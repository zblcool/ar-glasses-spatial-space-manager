#!/usr/bin/env python3
"""Live 3D reconstruction from the Luma Ultra's tracking cameras.

    npm run scan        # starts everything (tools/scan.mjs) and opens http://localhost:8788

Without tools/recon/calib.json the page first runs the checkerboard
calibration (calibrate.py) and then switches to reconstruction. Each stereo
frame is rectified, matched (semi-global block matching) into a depth map,
moved into the world with the glasses' 6DoF pose, and averaged into a voxel
map. The page draws the map as a point cloud, live, with the glasses in it.

Move slowly: frames are skipped while the head turns fast (motion blur) or
while the SDK's pose is unstable. Near things (0.3–2.5 m) come out best.
"""

from __future__ import annotations

import argparse
import json
import struct
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import cv2
import numpy as np

from calibrate import Calibrator
import screens
from core import Calibration, FrameStream, StereoDepth, StereoFrame, VoxelMap, rotation_angle

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
        self.near, self.far = args.near, args.far
        self.max_turn = np.radians(args.max_turn_dps)
        self.paused = False
        self.last: tuple | None = None  # (raw left, raw right, rect left, rect right, disparity) of the newest frame
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
            self.pose = T.T.ravel().tolist()  # column-major, for three.js Matrix4.fromArray
        if state == "ok" and not self.paused and len(pts):
            T = f.pose @ self.T_dev_rect
            self.map.add(pts @ T[:3, :3].T + T[:3, 3], gray)
            self.stats["integrated"] += 1
        else:
            self.stats["skipped"] += 1
        self.stats["state"] = "paused" if self.paused else state
        self.stats["points"] = int(len(pts))

        self.last = (f.left, f.right, rl, rr, disp)
        self.times = [t for t in self.times if t > t0 - 2] + [t0]
        self.stats["fps"] = round(len(self.times) / 2, 1)
        self.stats["ms"] = round((time.time() - t0) * 1000)


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


def make_handler(app: App, scans: Path):
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
                        "version": recon.map.version, "paused": recon.paused, "calib": app.calib_stats,
                        "baseline": recon.depth.baseline, "focal": recon.depth.focal,
                        "trusted_deg": [round(float(np.degrees(t)), 1) for t in recon.depth.theta],
                        "rect_size": list(recon.depth.size), "old_calib": app.recon_calib_old}
                self.send(200, json.dumps(body).encode())
            elif url.path == "/frame.jpg":
                self.send(200, recon.jpeg(q.get("view", ["depth"])[0]) if recon else b"", "image/jpeg")
            elif url.path == "/cloud" and recon:
                pos, gray = recon.map.solid(int(q.get("min", ["3"])[0]))
                # u32 count, then xyz float32 × count, then gray uint8 × count
                self.send(200, struct.pack("<I", len(pos)) + pos.tobytes() + gray.tobytes(), "application/octet-stream")
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
            elif not recon:
                self.send(409, json.dumps({"error": "calibrating"}).encode())
            elif url.path == "/pause":
                recon.paused = not recon.paused
                self.send(200, json.dumps({"paused": recon.paused}).encode())
            elif url.path == "/reset":
                recon.map.reset()
                self.send(200, b"{}")
            elif url.path == "/save":
                scans.mkdir(exist_ok=True)
                path = scans / time.strftime("scan-%Y%m%d-%H%M%S.ply")
                n = recon.map.save_ply(path, int(parse_qs(url.query).get("min", ["3"])[0]))
                self.send(200, json.dumps({"path": str(path), "points": n}).encode())
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
