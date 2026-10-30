#!/usr/bin/env python3
"""Live 3D reconstruction from the Luma Ultra's tracking cameras.

    npm run scan        # starts everything (tools/scan.mjs) and opens http://localhost:8788

Without tools/recon/calib.json the page first runs the checkerboard
calibration (calibrate.py) and then switches to reconstruction. Each stereo
frame is rectified, matched (semi-global block matching) into a depth map,
moved into the world with the glasses' 6DoF pose, and fused twice: averaged
into a voxel map (the point cloud) and into a signed distance field whose zero
crossing is a surface mesh. The page draws either, live, with the glasses in it.
"Scan an object" puts a box around what you look at and maps only that, finer.

The page also records RGB keyframes from the front camera and turns a
recording into a textured model with Apple's Object Capture (capture.py).

Move slowly: frames are skipped while the head turns fast (motion blur) or
while the SDK's pose is unstable. Near things (0.3–2.5 m) come out best.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import struct
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import cv2
import numpy as np

from calibrate import Calibrator
from capture import Builder, Recorder
import screens
from core import Calibration, FrameStream, StereoDepth, StereoFrame, TSDFMap, VoxelMap, rotation_angle

HERE = Path(__file__).resolve().parent
# three.js for the page: the app's own copy (after `npm install`), else the same version from a CDN.
THREE_DIR = HERE.parent.parent / "app" / "node_modules" / "three"
THREE_CDN = "https://cdn.jsdelivr.net/npm/three@0.186.1/"


class Recon:
    """Depth from one stereo frame at a time, fused into the voxel map."""

    def __init__(self, calib: Calibration, args):
        self.depth = StereoDepth(calib, width=args.width, fov_scale=args.fov_scale, max_disp=args.max_disp, lr_check=not args.no_lr_check)
        self.T_dev_rect = calib.T_dev_cam @ self.depth.T_cam_rect
        self.map = VoxelMap(args.voxel)
        self.surface = TSDFMap(args.surface_voxel)
        self.room_voxel, self.object_voxel = args.surface_voxel, args.object_voxel
        self.near, self.far = args.near, args.far
        self.max_turn = np.radians(args.max_turn_dps)
        self.paused = False
        self.last: tuple | None = None  # (raw left, raw right, rect left, rect right, disparity) of the newest frame
        self.last_T: np.ndarray | None = None  # T_world_rect of the newest frame
        self.border = self._border()
        self.pose: list | None = None
        self.stats = {"fps": 0.0, "integrated": 0, "skipped": 0, "points": 0, "state": "starting"}
        self.prev: tuple | None = None  # (t, T_world_dev) of the previous frame
        self.times: list[float] = []

    def process(self, f: StereoFrame) -> None:
        t0 = time.time()
        rl, rr = self.depth.rectify(f.left, f.right)
        disp = self.depth.disparity(rl, rr)
        pts, gray = self.depth.points(disp, rl, self.near, self.far)

        state = "ok"
        if f.pose is None or not f.pose_stable:
            state = "no stable pose from the SDK (6DoF still starting?)"
        elif self.prev is not None:
            dt = max((f.t - self.prev[0]) / 1000.0, 1e-3)
            if rotation_angle(self.prev[1][:3, :3].T @ f.pose[:3, :3]) / dt > self.max_turn:
                state = "turning too fast"
        if f.pose is not None:
            self.prev = (f.t, f.pose)
            T = f.pose @ self.T_dev_rect
            self.last_T = T
            self.pose = T.T.ravel().tolist()  # column-major, for three.js Matrix4.fromArray
        if state == "ok" and not self.paused and len(pts):
            T = f.pose @ self.T_dev_rect
            self.map.add(pts @ T[:3, :3].T + T[:3, 3], gray)
            t1 = time.time()
            P = self.depth.P1
            self.surface.integrate(self.depth.depth_image(disp, self.near, self.far), rl, self.depth.focal, P[0, 2], P[1, 2], T)
            self.stats["surface_ms"] = round((time.time() - t1) * 1000)
            self.stats["integrated"] += 1
        else:
            self.stats["skipped"] += 1
        self.stats["state"] = "paused" if self.paused else state
        self.stats["points"] = int(len(pts))

        self.last = (f.left, f.right, rl, rr, disp)
        self.times = [t for t in self.times if t > t0 - 2] + [t0]
        self.stats["fps"] = round(len(self.times) / 2, 1)
        self.stats["ms"] = round((time.time() - t0) * 1000)


    def focus(self, size: float) -> list | None:
        """Map only a box of `size` metres around what the middle of the view sees,
        with the finer voxels. None if there is no depth there."""
        if not self.last or self.last_T is None:
            return None
        disp = self.last[4]
        z = self.depth.depth_image(disp, self.near, self.far)
        h, w = z.shape
        ys, xs = np.nonzero(z[h // 3 : 2 * h // 3, w // 3 : 2 * w // 3])
        if len(ys) < 50:
            return None
        ys, xs = ys + h // 3, xs + w // 3
        zz = z[ys, xs]
        P, f = self.depth.P1, self.depth.focal
        p = np.median(np.stack([(xs - P[0, 2]) * zz / f, (ys - P[1, 2]) * zz / f, zz], 1), axis=0)
        c = self.last_T[:3, :3] @ p + self.last_T[:3, 3]
        box = (c - size / 2, c + size / 2)
        self.surface.reset(self.object_voxel, box)
        return [box[0].tolist(), box[1].tolist()]

    def room(self) -> None:
        self.surface.reset(self.room_voxel, None)

    def _border(self) -> tuple[np.ndarray, np.ndarray]:
        """Outline of the rectified view in each raw image (from the remap tables)."""
        out = []
        for m in (self.depth.map_l[0], self.depth.map_r[0]):
            h, w = m.shape[:2]
            edge = np.concatenate([m[0, :], m[:, -1], m[-1, ::-1], m[::-1, 0]])
            out.append(edge.reshape(-1, 1, 2).astype(np.int32))
        return out[0], out[1]

    def jpeg(self, view: str) -> bytes:
        """depth: rectified left + disparity; rectified: both rectified eyes with
        rows marked (a point must sit on the same row in both); raw: the fisheye
        images with the part used for matching outlined."""
        if not self.last:
            return b""
        l, r, rl, rr, disp = self.last
        bgr = lambda g: cv2.cvtColor(g, cv2.COLOR_GRAY2BGR)
        if view == "rectified":
            img = np.hstack([bgr(rl), np.full((rl.shape[0], 4, 3), 255, np.uint8), bgr(rr)])
            for y in range(12, img.shape[0], 24):
                cv2.line(img, (0, y), (img.shape[1], y), (80, 200, 255) if (y // 24) % 2 else (255, 160, 60), 1)
        elif view == "raw":
            a, b = bgr(l), bgr(r)
            cv2.polylines(a, [self.border[0]], True, (80, 220, 120), 2)
            cv2.polylines(b, [self.border[1]], True, (80, 220, 120), 2)
            img = np.hstack([a, np.full((a.shape[0], 4, 3), 255, np.uint8), b])
        else:
            colour = cv2.applyColorMap(np.clip(disp * (255.0 / self.depth.sgbm.getNumDisparities()), 0, 255).astype(np.uint8), cv2.COLORMAP_TURBO)
            colour[disp <= 0.5] = 0
            img = np.hstack([bgr(rl), colour])
        return cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 80])[1].tobytes()


class App:
    """Feeds frames to the calibrator until there is a calibration, then to Recon."""

    def __init__(self, stream: FrameStream, args):
        self.stream, self.args = stream, args
        self.recon: Recon | None = None
        self.calibrator: Calibrator | None = None
        self.calib_stats: dict = {}
        self.recon_calib_old = False
        self.recorder = Recorder(stream, HERE / "captures")
        self.builder = Builder()
        if args.calib.exists():
            self.calib_stats = json.loads(args.calib.read_text()).get("stats", {})
            # Calibrations from before coverage was recorded: rectification
            # works, but a new calibration is more accurate.
            self.recon_calib_old = "theta_max" not in json.loads(args.calib.read_text())
            self.start_recon(Calibration.load(args.calib))
        else:
            self.calibrate()
        threading.Thread(target=self.run, daemon=True).start()

    @property
    def mode(self) -> str:
        return "recon" if self.recon else "calibrate"

    def calibrate(self) -> None:
        if self.args.square_mm:
            method, square = "manual", self.args.square_mm / 1000
        else:
            # The page sends the screen-based size (POST /calib-config) once it has drawn the board.
            method, square = ("screen" if any(d["mm"][0] > 0 for d in screens.displays()) else "auto"), None
        self.calibrator = Calibrator(method=method, square=square)
        self.recon = None

    def start_recon(self, calib: Calibration) -> None:
        self.recon = Recon(calib, self.args)
        d = self.recon.depth
        print(f"stereo: baseline {d.baseline * 100:.1f} cm, focal {d.focal:.0f} px (rectified {d.size[0]}×{d.size[1]})")

    def run(self) -> None:
        seq = 0
        while True:
            seq, f = self.stream.next(seq)
            recon, cal = self.recon, self.calibrator
            if f is not None and f.pose is not None and f.pose_stable:
                self.recorder.add_pose(f.t, f.pose)
            if f is None:
                if recon:
                    recon.stats["state"] = self.stream.error or "waiting for frames"
            elif recon:
                recon.process(f)
            elif cal:
                cal.step(f)
                if cal.result:
                    calib, stats = cal.result
                    calib.save(self.args.calib, {"stats": stats})
                    self.calib_stats = stats
                    self.recon_calib_old = False
                    print("calibrated:", ", ".join(f"{k} {v:.4g}" if isinstance(v, float) else f"{k} {v}" for k, v in stats.items()))
                    self.start_recon(calib)
                    self.calibrator = None

    def stream_problem(self) -> str | None:
        """What is wrong with the camera stream, if anything."""
        if self.stream.error:
            return self.stream.error
        s = self.stream.status.get("status")
        return None if s == "streaming" else self.stream.status.get("message") or s


CAPTURE_NAME = re.compile(r"^capture-\d{8}-\d{6}$")


def make_handler(app: App, scans: Path):
    captures = app.recorder.root

    def capture_dir(name: str) -> Path | None:
        d = captures / name
        return d if CAPTURE_NAME.match(name) and d.is_dir() else None

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):  # quiet
            pass

        def send(self, code: int, body: bytes, ctype: str = "application/json") -> None:
            self.send_response(code)
            self.send_header("content-type", ctype)
            self.send_header("cache-control", "no-store")
            self.send_header("content-length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def redirect(self, location: str) -> None:
            self.send_response(302)
            self.send_header("location", location)
            self.end_headers()

        def do_GET(self):
            url = urlparse(self.path)
            q = parse_qs(url.query)
            recon, cal = app.recon, app.calibrator
            if url.path == "/":
                if recon:
                    self.send(200, (HERE / "recon.html").read_bytes(), "text/html; charset=utf-8")
                else:
                    self.redirect("/calibrate")
            elif url.path == "/calibrate":
                self.send(200, (HERE / "calibrate.html").read_bytes(), "text/html; charset=utf-8")
            elif url.path.startswith("/vendor/three/"):
                rel = url.path[len("/vendor/three/"):]
                f = (THREE_DIR / rel).resolve()
                if f.is_relative_to(THREE_DIR.resolve()) and f.is_file():
                    self.send(200, f.read_bytes(), "text/javascript")
                else:
                    self.redirect(THREE_CDN + rel)
            elif url.path == "/calib-state":
                body = {"mode": app.mode, "stream": app.stream_problem(), **(cal.state() if cal else {})}
                self.send(200, json.dumps(body).encode())
            elif url.path == "/screens":
                self.send(200, json.dumps(screens.displays()).encode())
            elif url.path == "/calib-preview.jpg":
                self.send(200, cal.preview if cal else b"", "image/jpeg")
            elif url.path == "/state":
                if not recon:
                    self.send(200, json.dumps({"mode": app.mode}).encode())
                    return
                body = {**recon.stats, "mode": app.mode, "pose": recon.pose, "voxels": int(len(recon.map.hits)),
                        "version": recon.map.version, "surface_version": recon.surface.version,
                        "surface": {"blocks": recon.surface.n, "voxel": recon.surface.voxel,
                                    "box": None if recon.surface.box is None else [b.tolist() for b in recon.surface.box]}, "paused": recon.paused, "calib": app.calib_stats,
                        "baseline": recon.depth.baseline, "focal": recon.depth.focal,
                        "trusted_deg": [round(float(np.degrees(t)), 1) for t in recon.depth.theta],
                        "rect_size": list(recon.depth.size), "old_calib": app.recon_calib_old}
                self.send(200, json.dumps(body).encode())
            elif url.path == "/capture-state":
                body = {**app.recorder.state(), "build": app.builder.state(), "captures": app.recorder.captures()}
                self.send(200, json.dumps(body).encode())
            elif url.path == "/rgb.jpg":
                self.send(200, app.recorder.preview, "image/jpeg")
            elif url.path.startswith("/captures/"):
                # /captures/<name>/model/obj/<file>: the model, for the page's viewer
                parts = url.path.split("/")
                d = capture_dir(parts[2]) if len(parts) == 6 and parts[3:5] == ["model", "obj"] else None
                f = d / "model" / "obj" / parts[5] if d else None
                if f and f.is_file() and f.parent == d / "model" / "obj":
                    ctype = {".png": "image/png", ".jpg": "image/jpeg"}.get(f.suffix, "text/plain")
                    self.send(200, f.read_bytes(), ctype)
                else:
                    self.send(404, b"{}")
            elif url.path == "/frame.jpg":
                self.send(200, recon.jpeg(q.get("view", ["depth"])[0]) if recon else b"", "image/jpeg")
            elif url.path == "/cloud" and recon:
                pos, gray = recon.map.solid(int(q.get("min", ["3"])[0]))
                # u32 count, then xyz float32 × count, then gray uint8 × count
                self.send(200, struct.pack("<I", len(pos)) + pos.tobytes() + gray.tobytes(), "application/octet-stream")
            elif url.path == "/mesh" and recon:
                verts, gray, tris = recon.surface.mesh(float(q.get("min", ["3"])[0]))
                # u32 vertex count, u32 triangle count, xyz float32 × n, triangle indices u32 × 3m, gray uint8 × n
                body = struct.pack("<II", len(verts), len(tris)) + verts.tobytes() + tris.tobytes() + gray.tobytes()
                self.send(200, body, "application/octet-stream")
            else:
                self.send(404, b"{}")

        def do_POST(self):
            url = urlparse(self.path)
            recon = app.recon
            if url.path == "/recalibrate":
                app.calibrate()
                self.send(200, b"{}")
            elif url.path == "/calib-config" and app.calibrator:
                try:
                    body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
                    mm = body.get("square_mm")
                    app.calibrator.configure(body.get("method", ""), float(mm) / 1000 if mm else None)
                    self.send(200, json.dumps(app.calibrator.state() | {"ok": True}).encode())
                except (ValueError, TypeError) as err:
                    self.send(400, json.dumps({"error": str(err)}).encode())
            elif url.path == "/calib-solve" and app.calibrator:
                self.send(200, json.dumps({"started": app.calibrator.solve_now()}).encode())
            elif url.path == "/record":
                if parse_qs(url.query).get("on", ["1"])[0] == "1":
                    if not app.recorder.recording:
                        app.recorder.start()
                else:
                    app.recorder.stop()
                self.send(200, json.dumps(app.recorder.state()).encode())
            elif url.path == "/rgb-frame":
                # Frames from the browser, when it opened the camera itself.
                body = self.rfile.read(int(self.headers.get("content-length", 0)))
                app.stream.put_rgb(float(self.headers.get("x-time") or time.time() * 1000), body)
                self.send(204, b"")
            elif url.path in ("/build", "/open"):
                q = parse_qs(url.query)
                d = capture_dir(q.get("name", [""])[0])
                if not d:
                    self.send(404, json.dumps({"error": "no such capture"}).encode())
                elif url.path == "/build":
                    try:
                        app.builder.start(d, q.get("detail", ["medium"])[0])
                        self.send(200, b"{}")
                    except RuntimeError as err:
                        self.send(409, json.dumps({"error": str(err)}).encode())
                else:
                    target = {"usdz": d / "model" / "model.usdz", "images": d / "images"}.get(q.get("what", [""])[0], d)
                    # A .usdz opens in Preview (it can be turned around there); a folder in Finder.
                    subprocess.Popen(["open", str(target)])
                    self.send(200, b"{}")
            elif url.path == "/build-cancel":
                app.builder.cancel()
                self.send(200, b"{}")
            elif not recon:
                self.send(409, json.dumps({"error": "calibrating"}).encode())
            elif url.path == "/pause":
                recon.paused = not recon.paused
                self.send(200, json.dumps({"paused": recon.paused}).encode())
            elif url.path == "/reset":
                recon.map.reset()
                recon.surface.reset(recon.surface.voxel, recon.surface.box)
                self.send(200, b"{}")
            elif url.path == "/object":
                q = parse_qs(url.query)
                if "off" in q:
                    recon.room()
                    self.send(200, json.dumps({"box": None}).encode())
                    return
                box = recon.focus(float(q.get("size", ["0.6"])[0]))
                self.send(200 if box else 409, json.dumps({"box": box} if box else {"error": "no depth in the middle of the view"}).encode())
            elif url.path == "/save":
                scans.mkdir(exist_ok=True)
                stem = time.strftime("scan-%Y%m%d-%H%M%S")
                mn = int(parse_qs(url.query).get("min", ["3"])[0])
                n = recon.map.save_ply(scans / f"{stem}.ply", mn)
                tris = recon.surface.save_ply(scans / f"{stem}-mesh.ply", mn)
                self.send(200, json.dumps({"path": str(scans / stem), "points": n, "triangles": tris}).encode())
            else:
                self.send(404, b"{}")

    return Handler


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--calib", type=Path, default=HERE / "calib.json")
    ap.add_argument("--port", type=int, default=8788, help="this page's port (default 8788)")
    ap.add_argument("--viewer-port", type=int, default=8787, help="camera viewer port")
    ap.add_argument("--square-mm", type=float, help="board square size if you measured it (otherwise the page sizes it from the screen, or solves for it)")
    ap.add_argument("--voxel", type=float, default=0.02, help="voxel size in metres (default 0.02)")
    ap.add_argument("--surface-voxel", type=float, default=0.02, help="surface (TSDF) voxel for the whole room, metres (default 0.02)")
    ap.add_argument("--object-voxel", type=float, default=0.005, help="surface voxel when scanning one object, metres (default 0.005)")
    ap.add_argument("--near", type=float, default=0.25)
    ap.add_argument("--far", type=float, default=2.5, help="ignore depth beyond this (metres); it gets noisy fast")
    ap.add_argument("--width", type=int, default=480, help="rectified image width (bigger = finer, slower)")
    ap.add_argument("--fov-scale", type=float, default=0.85, help="<1 crops the rectified view to the middle of what both eyes see (default 0.85)")
    ap.add_argument("--max-disp", type=int, default=64, help="disparity search range, multiple of 16")
    ap.add_argument("--max-turn-dps", type=float, default=60, help="skip frames while turning faster (deg/s)")
    ap.add_argument("--no-lr-check", action="store_true", help="skip the left-right consistency check (faster, noisier)")
    args = ap.parse_args()

    app = App(FrameStream(port=args.viewer_port), args)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(app, HERE / "scans"))
    print(f"reconstruction: http://localhost:{args.port}" + ("  (calibration first)" if app.mode == "calibrate" else ""))
    server.serve_forever()


if __name__ == "__main__":
    main()
