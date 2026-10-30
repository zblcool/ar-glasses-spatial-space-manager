#!/usr/bin/env python3
"""Live 3D reconstruction from the Luma Ultra's tracking cameras.

    npm run cameras                         # in another terminal
    python3 tools/recon/recon.py            # then open http://localhost:8788

Needs tools/recon/calib.json from calibrate.py. Each stereo frame is rectified,
matched (semi-global block matching) into a depth map, moved into the world
with the glasses' 6DoF pose, and averaged into a voxel map. The page draws
the map as a point cloud, live, with the glasses in it.

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

from core import Calibration, FrameStream, StereoDepth, VoxelMap, rotation_angle

HERE = Path(__file__).resolve().parent
# three.js for the page: the app's own copy (after `npm install`), else the same version from a CDN.
THREE_DIR = HERE.parent.parent / "app" / "node_modules" / "three"
THREE_CDN = "https://cdn.jsdelivr.net/npm/three@0.186.1/"


class Recon:
    def __init__(self, calib: Calibration, stream: FrameStream, args):
        self.stream = stream
        self.depth = StereoDepth(calib, width=args.width, fov_scale=args.fov_scale, max_disp=args.max_disp, lr_check=not args.no_lr_check)
        self.T_dev_rect = calib.T_dev_cam @ self.depth.T_cam_rect
        self.map = VoxelMap(args.voxel)
        self.near, self.far = args.near, args.far
        self.max_turn = np.radians(args.max_turn_dps)
        self.paused = False
        self.jpeg = b""
        self.pose: list | None = None
        self.stats = {"fps": 0.0, "integrated": 0, "skipped": 0, "points": 0, "state": "starting"}
        threading.Thread(target=self.run, daemon=True).start()

    def run(self) -> None:
        seq, prev, times = 0, None, []
        while True:
            seq, f = self.stream.next(seq)
            if f is None:
                self.stats["state"] = self.stream.error or "waiting for frames"
                continue
            t0 = time.time()
            rl, rr = self.depth.rectify(f.left, f.right)
            disp = self.depth.disparity(rl, rr)
            pts, gray = self.depth.points(disp, rl, self.near, self.far)

            state = "ok"
            if f.pose is None or not f.pose_stable:
                state = "no stable pose from the SDK (6DoF still starting?)"
            elif prev is not None:
                dt = max((f.t - prev[0]) / 1000.0, 1e-3)
                if rotation_angle(prev[1][:3, :3].T @ f.pose[:3, :3]) / dt > self.max_turn:
                    state = "turning too fast"
            if f.pose is not None:
                prev = (f.t, f.pose)
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

            colour = cv2.applyColorMap(np.clip(disp * (255.0 / self.depth.sgbm.getNumDisparities()), 0, 255).astype(np.uint8), cv2.COLORMAP_TURBO)
            colour[disp <= 0.5] = 0
            self.jpeg = cv2.imencode(".jpg", np.hstack([cv2.cvtColor(rl, cv2.COLOR_GRAY2BGR), colour]), [cv2.IMWRITE_JPEG_QUALITY, 75])[1].tobytes()
            times = [t for t in times if t > t0 - 2] + [t0]
            self.stats["fps"] = round(len(times) / 2, 1)
            self.stats["ms"] = round((time.time() - t0) * 1000)


def make_handler(recon: Recon, scans: Path):
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

        def do_GET(self):
            url = urlparse(self.path)
            q = parse_qs(url.query)
            if url.path == "/":
                self.send(200, (HERE / "recon.html").read_bytes(), "text/html; charset=utf-8")
            elif url.path.startswith("/vendor/three/"):
                rel = url.path[len("/vendor/three/"):]
                f = (THREE_DIR / rel).resolve()
                if f.is_relative_to(THREE_DIR.resolve()) and f.is_file():
                    self.send(200, f.read_bytes(), "text/javascript")
                else:
                    self.send_response(302)
                    self.send_header("location", THREE_CDN + rel)
                    self.end_headers()
            elif url.path == "/state":
                body = {**recon.stats, "pose": recon.pose, "voxels": int(len(recon.map.hits)), "version": recon.map.version,
                        "paused": recon.paused, "baseline": recon.depth.baseline, "focal": recon.depth.focal}
                self.send(200, json.dumps(body).encode())
            elif url.path == "/frame.jpg":
                self.send(200, recon.jpeg, "image/jpeg")
            elif url.path == "/cloud":
                pos, gray = recon.map.solid(int(q.get("min", ["3"])[0]))
                # u32 count, then xyz float32 × count, then gray uint8 × count
                self.send(200, struct.pack("<I", len(pos)) + pos.tobytes() + gray.tobytes(), "application/octet-stream")
            else:
                self.send(404, b"{}")

        def do_POST(self):
            url = urlparse(self.path)
            if url.path == "/pause":
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
    ap.add_argument("--voxel", type=float, default=0.02, help="voxel size in metres (default 0.02)")
    ap.add_argument("--near", type=float, default=0.25)
    ap.add_argument("--far", type=float, default=2.5, help="ignore depth beyond this (metres); it gets noisy fast")
    ap.add_argument("--width", type=int, default=480, help="rectified image width (bigger = finer, slower)")
    ap.add_argument("--fov-scale", type=float, default=0.75, help="rectified field of view; <1 crops to the middle of the fisheye (default 0.75)")
    ap.add_argument("--max-disp", type=int, default=64, help="disparity search range, multiple of 16")
    ap.add_argument("--max-turn-dps", type=float, default=60, help="skip frames while turning faster (deg/s)")
    ap.add_argument("--no-lr-check", action="store_true", help="skip the left-right consistency check (faster, noisier)")
    args = ap.parse_args()
    if not args.calib.exists():
        raise SystemExit(f"{args.calib} not found: run calibrate.py first")

    calib = Calibration.load(args.calib)
    recon = Recon(calib, FrameStream(port=args.viewer_port), args)
    print(f"stereo: baseline {recon.depth.baseline * 100:.1f} cm, focal {recon.depth.focal:.0f} px (rectified {recon.depth.size[0]}×{recon.depth.size[1]})")
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(recon, HERE / "scans"))
    print(f"reconstruction: http://localhost:{args.port}")
    server.serve_forever()


if __name__ == "__main__":
    main()
