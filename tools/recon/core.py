"""Shared pieces for calibration and live reconstruction.

Frames come from the camera viewer's local server (tools/camera-viewer,
GET /stream), which relays viture-camera-helper's packets. Each stereo packet
carries the left and right 8-bit planes and the head pose the SDK reported
when the frame arrived (see the header of helper/src/camera_helper.m).

Frames used here:
  world  the SDK's OpenGL tracking frame (x right, y up, z back), metres;
         also three.js's frame, so the viewer can draw it as-is
  dev    the glasses (the pose the SDK reports)
  cam    an OpenCV camera: x right, y down, z forward (left eye unless noted)
  rect   the rectified left camera used for stereo matching
"""

from __future__ import annotations

import http.client
import json
import struct
import threading
import time
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

MAGIC = 0x4D414356
HEADER = struct.Struct("<IB3xHHId")
POSE_TRAILER = 40
KIND_STEREO, KIND_RGB, KIND_STATUS = 1, 2, 3


# ---- geometry -------------------------------------------------------------------


def quat_to_matrix(qw: float, qx: float, qy: float, qz: float) -> np.ndarray:
    n = np.sqrt(qw * qw + qx * qx + qy * qy + qz * qz)
    qw, qx, qy, qz = qw / n, qx / n, qy / n, qz / n
    return np.array(
        [
            [1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw)],
            [2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw)],
            [2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy)],
        ]
    )


def pose_to_matrix(pose) -> np.ndarray:
    """SDK pose [px py pz qw qx qy qz] -> 4x4 T_world_dev."""
    T = np.eye(4)
    T[:3, :3] = quat_to_matrix(*pose[3:7])
    T[:3, 3] = pose[:3]
    return T


def make_T(R: np.ndarray, t) -> np.ndarray:
    T = np.eye(4)
    T[:3, :3] = R
    T[:3, 3] = np.ravel(t)
    return T


def invert(T: np.ndarray) -> np.ndarray:
    R, t = T[:3, :3], T[:3, 3]
    return make_T(R.T, -R.T @ t)


def rotation_angle(R: np.ndarray) -> float:
    """Angle of a rotation matrix, radians."""
    return float(np.arccos(np.clip((np.trace(R) - 1) / 2, -1.0, 1.0)))


# ---- stream ---------------------------------------------------------------------


@dataclass
class StereoFrame:
    left: np.ndarray  # (h, w) uint8
    right: np.ndarray
    t: float  # epoch ms, when the helper received the frame
    sdk_t: float  # SDK frame timestamp (seconds, SDK clock)
    pose: np.ndarray | None  # T_world_dev, or None when the SDK had no pose yet
    pose_stable: bool


def parse_stereo(w: int, h: int, t: float, payload: bytes) -> StereoFrame:
    plane = w * h
    buf = np.frombuffer(payload, np.uint8)
    left = buf[:plane].reshape(h, w)
    right = buf[plane : 2 * plane].reshape(h, w)
    sdk_t, pose, status = 0.0, None, -1
    if len(payload) >= 2 * plane + POSE_TRAILER:
        tr = payload[2 * plane : 2 * plane + POSE_TRAILER]
        sdk_t = struct.unpack_from("<d", tr, 0)[0]
        p = struct.unpack_from("<7f", tr, 8)
        status = struct.unpack_from("<i", tr, 36)[0]
        if status >= 0 and abs(np.linalg.norm(p[3:7]) - 1) < 0.1:
            pose = pose_to_matrix(p)
    return StereoFrame(left, right, t, sdk_t, pose, status == 0)


class FrameStream:
    """Reads the camera viewer's /stream on a thread and keeps the newest stereo
    frame (older ones are dropped: processing is slower than the cameras)."""

    def __init__(self, host: str = "127.0.0.1", port: int = 8787):
        self.host, self.port = host, port
        self.status: dict = {}
        self._latest: StereoFrame | None = None
        self._seq = 0
        self._cond = threading.Condition()
        self.error: str | None = None
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self) -> None:
        while True:
            try:
                conn = http.client.HTTPConnection(self.host, self.port, timeout=10)
                conn.request("GET", "/stream")
                res = conn.getresponse()
                self.error = None
                while True:
                    head = res.read(HEADER.size)
                    if len(head) < HEADER.size:
                        raise ConnectionError("stream ended")
                    magic, kind, w, h, length, t = HEADER.unpack(head)
                    if magic != MAGIC:
                        raise ConnectionError("stream out of sync")
                    payload = res.read(length)
                    if kind == KIND_STEREO:
                        frame = parse_stereo(w, h, t, payload)
                        with self._cond:
                            self._latest = frame
                            self._seq += 1
                            self._cond.notify_all()
                    elif kind == KIND_STATUS:
                        self.status.update(json.loads(payload))
            except (OSError, ConnectionError, http.client.HTTPException) as err:
                self.error = f"camera viewer at {self.host}:{self.port} not reachable ({err}); is `npm run cameras` running?"
                time.sleep(1.0)

    def next(self, after: int, timeout: float = 1.0) -> tuple[int, StereoFrame | None]:
        """Wait for a frame newer than sequence number `after`."""
        with self._cond:
            self._cond.wait_for(lambda: self._seq != after, timeout)
            return self._seq, self._latest


# ---- calibration ------------------------------------------------------------------


@dataclass
class Calibration:
    size: tuple[int, int]  # (w, h) of the tracking camera images
    K1: np.ndarray
    D1: np.ndarray
    K2: np.ndarray
    D2: np.ndarray
    R: np.ndarray  # x_right = R x_left + T (OpenCV stereoCalibrate convention)
    T: np.ndarray
    T_dev_cam: np.ndarray  # left camera -> glasses (hand-eye)

    def save(self, path: Path, extra: dict | None = None) -> None:
        data = {
            "size": list(self.size),
            "K1": self.K1.tolist(), "D1": self.D1.ravel().tolist(),
            "K2": self.K2.tolist(), "D2": self.D2.ravel().tolist(),
            "R": self.R.tolist(), "T": self.T.ravel().tolist(),
            "T_dev_cam": self.T_dev_cam.tolist(),
            **(extra or {}),
        }
        path.write_text(json.dumps(data, indent=2))

    @staticmethod
    def load(path: Path) -> "Calibration":
        d = json.loads(path.read_text())
        f = lambda k: np.array(d[k], dtype=np.float64)
        return Calibration(
            tuple(d["size"]), f("K1"), f("D1").reshape(4, 1), f("K2"), f("D2").reshape(4, 1),
            f("R"), f("T").reshape(3, 1), f("T_dev_cam"),
        )


# ---- stereo depth ----------------------------------------------------------------


class StereoDepth:
    """Fisheye stereo rectification + semi-global matching -> 3D points in the
    left camera frame.

    fov_scale < 1 crops the rectified view to the middle of the fisheye: the
    edges are where calibration is weakest (wrong matches) and cropping also
    raises the rectified focal length, i.e. depth precision. lr_check drops
    pixels whose left->right and right->left matches disagree. On synthetic
    fisheye data the two together cut wrong depths from ~11% to under 1%."""

    def __init__(self, calib: Calibration, width: int = 480, fov_scale: float = 0.75, max_disp: int = 64, lr_check: bool = True):
        w, h = calib.size
        out = (width, int(round(width * h / w)))
        R1, R2, P1, P2, Q = cv2.fisheye.stereoRectify(
            calib.K1, calib.D1, calib.K2, calib.D2, (w, h),
            np.ascontiguousarray(calib.R), np.ascontiguousarray(calib.T).reshape(3, 1),
            flags=cv2.CALIB_ZERO_DISPARITY, newImageSize=out, balance=0.0, fov_scale=fov_scale,
        )
        self.size = out
        self.lr_check = lr_check
        self.P1, self.Q = P1, Q
        self.R1 = R1
        self.map_l = cv2.fisheye.initUndistortRectifyMap(calib.K1, calib.D1, R1, P1, out, cv2.CV_16SC2)
        self.map_r = cv2.fisheye.initUndistortRectifyMap(calib.K2, calib.D2, R2, P2, out, cv2.CV_16SC2)
        # rect -> left camera: x_cam = R1^T x_rect
        self.T_cam_rect = make_T(R1.T, np.zeros(3))
        self.focal = float(P1[0, 0])
        self.baseline = float(abs(P2[0, 3] / P2[0, 0]))
        block = 5
        self.sgbm = cv2.StereoSGBM_create(
            minDisparity=0, numDisparities=max_disp, blockSize=block,
            P1=8 * block * block, P2=32 * block * block, disp12MaxDiff=1,
            uniquenessRatio=10, speckleWindowSize=80, speckleRange=2, preFilterCap=31,
            mode=cv2.STEREO_SGBM_MODE_SGBM_3WAY,
        )

    def rectify(self, left: np.ndarray, right: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        l = cv2.remap(left, *self.map_l, cv2.INTER_LINEAR)
        r = cv2.remap(right, *self.map_r, cv2.INTER_LINEAR)
        return l, r

    def disparity(self, rl: np.ndarray, rr: np.ndarray) -> np.ndarray:
        d = self.sgbm.compute(rl, rr).astype(np.float32) / 16.0
        if self.lr_check:
            # Right-to-left disparity = matching the mirrored pair.
            dr = cv2.flip(self.sgbm.compute(cv2.flip(rr, 1), cv2.flip(rl, 1)), 1).astype(np.float32) / 16.0
            h, w = d.shape
            xr = np.clip(np.arange(w)[None, :] - np.round(d).astype(np.int32), 0, w - 1)
            d[np.abs(d - np.take_along_axis(dr, xr, axis=1)) > 1.0] = -1
        return d

    def points(self, disp: np.ndarray, gray: np.ndarray, near: float, far: float, step: int = 2):
        """3D points (rect frame, metres) and their gray values for valid pixels."""
        d = disp[::step, ::step]
        g = gray[::step, ::step]
        ys, xs = np.nonzero(d > 0.5)
        dv = d[ys, xs]
        z = self.focal * self.baseline / dv
        keep = (z > near) & (z < far)
        xs, ys, z, dv = xs[keep] * step, ys[keep] * step, z[keep], dv[keep]
        cx, cy, f = self.P1[0, 2], self.P1[1, 2], self.focal
        pts = np.stack([(xs - cx) * z / f, (ys - cy) * z / f, z], axis=1)
        return pts, g[ys // step, xs // step]


# ---- voxel map --------------------------------------------------------------------


class VoxelMap:
    """Running average of points per voxel. A voxel only shows once it has been
    seen in `min_hits` frames, which removes most stereo-matching noise."""

    def __init__(self, voxel: float = 0.02):
        self.voxel = voxel
        self.lock = threading.Lock()
        self.reset()

    def reset(self) -> None:
        with getattr(self, "lock", threading.Lock()):
            self.index: dict[int, int] = {}
            self.pos = np.zeros((0, 3))
            self.gray = np.zeros(0)
            self.hits = np.zeros(0, np.int32)
            self.version = 0

    def add(self, pts: np.ndarray, gray: np.ndarray) -> None:
        if len(pts) == 0:
            return
        q = np.floor(pts / self.voxel).astype(np.int64) + (1 << 20)
        keys = (q[:, 0] << 42) | (q[:, 1] << 21) | q[:, 2]
        uniq, inv = np.unique(keys, return_inverse=True)
        n = len(uniq)
        psum = np.zeros((n, 3))
        np.add.at(psum, inv, pts)
        cnt = np.bincount(inv, minlength=n).astype(np.float64)
        gsum = np.bincount(inv, weights=gray.astype(np.float64), minlength=n)
        with self.lock:
            idx = np.fromiter((self.index.get(k, -1) for k in uniq.tolist()), np.int64, n)
            new = idx < 0
            if new.any():
                start = len(self.hits)
                ids = np.arange(start, start + int(new.sum()))
                self.index.update(zip(uniq[new].tolist(), ids.tolist()))
                idx[new] = ids
                self.pos = np.concatenate([self.pos, np.zeros((len(ids), 3))])
                self.gray = np.concatenate([self.gray, np.zeros(len(ids))])
                self.hits = np.concatenate([self.hits, np.zeros(len(ids), np.int32)])
            # Per-voxel average of this frame's points, then a running mean over frames.
            h = self.hits[idx].astype(np.float64)
            self.pos[idx] = (self.pos[idx] * h[:, None] + psum / cnt[:, None]) / (h[:, None] + 1)
            self.gray[idx] = (self.gray[idx] * h + gsum / cnt) / (h + 1)
            self.hits[idx] += 1
            self.version += 1

    def solid(self, min_hits: int) -> tuple[np.ndarray, np.ndarray]:
        with self.lock:
            m = self.hits >= min_hits
            return self.pos[m].astype(np.float32), self.gray[m].astype(np.uint8)

    def save_ply(self, path: Path, min_hits: int) -> int:
        pos, gray = self.solid(min_hits)
        with open(path, "wb") as f:
            f.write(
                (
                    "ply\nformat binary_little_endian 1.0\n"
                    f"element vertex {len(pos)}\n"
                    "property float x\nproperty float y\nproperty float z\n"
                    "property uchar red\nproperty uchar green\nproperty uchar blue\nend_header\n"
                ).encode()
            )
            rec = np.zeros(len(pos), dtype=[("p", "<f4", 3), ("c", "u1", 3)])
            rec["p"] = pos
            rec["c"] = gray[:, None]
            f.write(rec.tobytes())
        return len(pos)
