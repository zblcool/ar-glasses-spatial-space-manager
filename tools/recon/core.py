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
    frame (older ones are dropped: processing is slower than the cameras), and
    the newest RGB frame (a JPEG) while the RGB camera is on."""

    def __init__(self, host: str = "127.0.0.1", port: int = 8787):
        self.host, self.port = host, port
        self.status: dict = {}
        self._latest: StereoFrame | None = None
        self._seq = 0
        self._cond = threading.Condition()
        self.rgb: tuple[int, float, bytes] | None = None  # (sequence, epoch ms, JPEG)
        self.rgb_cond = threading.Condition()
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
                    elif kind == KIND_RGB:
                        self.put_rgb(t, payload)
                    elif kind == KIND_STATUS:
                        self.status.update(json.loads(payload))
            except (OSError, ConnectionError, http.client.HTTPException) as err:
                self.error = f"camera viewer at {self.host}:{self.port} not reachable ({err}); is `npm run cameras` running?"
                time.sleep(1.0)

    def put_rgb(self, t: float, jpeg: bytes) -> None:
        """A new RGB frame, from the stream or from a browser that opened the camera itself."""
        with self.rgb_cond:
            self.rgb = ((self.rgb[0] if self.rgb else 0) + 1, t, jpeg)
            self.rgb_cond.notify_all()

    def next_rgb(self, after: int, timeout: float = 1.0) -> tuple[int, float, bytes] | None:
        with self.rgb_cond:
            self.rgb_cond.wait_for(lambda: self.rgb is not None and self.rgb[0] != after, timeout)
            return self.rgb if self.rgb and self.rgb[0] != after else None

    def command(self, line: str) -> None:
        """Send a command to the camera helper through the viewer (e.g. "rgb 1")."""
        try:
            conn = http.client.HTTPConnection(self.host, self.port, timeout=3)
            conn.request("POST", "/cmd", line)
            conn.getresponse().read()
        except (OSError, http.client.HTTPException):
            pass

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
    # Per eye, the widest angle off the optical axis (radians) where the board
    # was seen during calibration: the lens model is only trusted inside it.
    theta_max: tuple[float, float] | None = None

    def save(self, path: Path, extra: dict | None = None) -> None:
        data = {
            "size": list(self.size),
            "K1": self.K1.tolist(), "D1": self.D1.ravel().tolist(),
            "K2": self.K2.tolist(), "D2": self.D2.ravel().tolist(),
            "R": self.R.tolist(), "T": self.T.ravel().tolist(),
            "T_dev_cam": self.T_dev_cam.tolist(),
            **({"theta_max": list(self.theta_max)} if self.theta_max else {}),
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
            tuple(d["theta_max"]) if "theta_max" in d else None,
        )


# ---- stereo depth ----------------------------------------------------------------


def trusted_theta(K: np.ndarray, D: np.ndarray, measured: float | None) -> float:
    """Largest off-axis angle where the fisheye model can be trusted: inside
    what calibration saw (plus a little), where the distortion polynomial still
    grows, and never past 80°."""
    th = np.radians(np.arange(0, 90.1, 0.5))
    k = D.ravel()
    thd = th * (1 + k[0] * th**2 + k[1] * th**4 + k[2] * th**6 + k[3] * th**8)
    falling = np.nonzero(np.diff(thd) <= 0)[0]
    limit = th[falling[0]] if len(falling) else th[-1]
    limit = min(limit, np.radians(80))
    if measured:
        limit = min(limit, measured + np.radians(4))
    return float(limit)


class StereoDepth:
    """Fisheye stereo rectification + semi-global matching -> 3D points in the
    left camera frame.

    The rectified view covers only directions both eyes see with a trusted lens
    model (trusted_theta) and inside their images. That matters for the glasses,
    whose eyes turn outwards: a fixed crop of the averaged view samples beyond
    the edge of what was calibrated, where a fisheye model can run wild (black,
    garbage). fov_scale < 1 crops further, to the middle of that window.
    lr_check drops pixels whose left->right and right->left matches disagree."""

    def __init__(self, calib: Calibration, width: int = 480, fov_scale: float = 0.85, max_disp: int = 64, lr_check: bool = True):
        w, h = calib.size
        R1, R2, _, _, _ = cv2.fisheye.stereoRectify(
            calib.K1, calib.D1, calib.K2, calib.D2, (w, h),
            np.ascontiguousarray(calib.R), np.ascontiguousarray(calib.T).reshape(3, 1),
            flags=cv2.CALIB_ZERO_DISPARITY,
        )
        measured = calib.theta_max or (None, None)
        theta = (trusted_theta(calib.K1, calib.D1, measured[0]), trusted_theta(calib.K2, calib.D2, measured[1]))
        u0, v0, half_w, half_h = self._window(calib, R1, R2, theta, (w, h))
        half_w, half_h = half_w * fov_scale, half_h * fov_scale
        out = (width, int(round(width * half_h / half_w)))
        f = out[0] / (2 * half_w)
        P = np.array([[f, 0, out[0] / 2 - u0 * f], [0, f, out[1] / 2 - v0 * f], [0, 0, 1]])
        self.size = out
        self.lr_check = lr_check
        self.P1 = P
        self.R1 = R1
        self.theta = theta
        self.map_l = cv2.fisheye.initUndistortRectifyMap(calib.K1, calib.D1, R1, P, out, cv2.CV_16SC2)
        self.map_r = cv2.fisheye.initUndistortRectifyMap(calib.K2, calib.D2, R2, P, out, cv2.CV_16SC2)
        # rect -> left camera: x_cam = R1^T x_rect
        self.T_cam_rect = make_T(R1.T, np.zeros(3))
        self.focal = float(f)
        # Right eye's centre in the rectified frame: on +x, `baseline` away.
        c = R1 @ (-calib.R.T @ calib.T.ravel())
        self.baseline = float(np.linalg.norm(c))
        self.swapped = bool(c[0] < 0)
        block = 5
        self.sgbm = cv2.StereoSGBM_create(
            minDisparity=0, numDisparities=max_disp, blockSize=block,
            P1=8 * block * block, P2=32 * block * block, disp12MaxDiff=1,
            uniquenessRatio=10, speckleWindowSize=80, speckleRange=2, preFilterCap=31,
            mode=cv2.STEREO_SGBM_MODE_SGBM_3WAY,
        )

    @staticmethod
    def _window(calib: Calibration, R1, R2, theta, size, aspect: float = 4 / 3):
        """Biggest rectangle (in rectified tan-space: centre u0, v0 and half
        sizes) that both eyes see with a trusted model and inside their images."""
        g = np.linspace(-3, 3, 241)  # tan of up to ±71.6°
        u, v = np.meshgrid(g, g)
        rays = np.stack([u.ravel(), v.ravel(), np.ones(u.size)], axis=1)
        ok = np.ones(u.size, bool)
        for R, K, D, th in ((R1, calib.K1, calib.D1, theta[0]), (R2, calib.K2, calib.D2, theta[1])):
            r = rays @ R  # = (R^T x)^T: the ray in that eye's frame
            ok &= np.arccos(np.clip(r[:, 2] / np.linalg.norm(r, axis=1), -1, 1)) < th
            front = r[:, 2] > 1e-6
            px = np.full((len(r), 2), -1.0)
            px[front] = cv2.fisheye.projectPoints(r[front].reshape(-1, 1, 3), np.zeros(3), np.zeros(3), K, D)[0].reshape(-1, 2)
            ok &= (px[:, 0] >= 0) & (px[:, 0] <= size[0] - 1) & (px[:, 1] >= 0) & (px[:, 1] <= size[1] - 1)
        mask = ok.reshape(u.shape)
        if not mask.any():
            raise ValueError("the two eyes share no trusted view; calibrate again")
        u0, v0 = float(u[mask].mean()), float(v[mask].mean())
        step = g[1] - g[0]
        lo, hi = step, 6.0
        for _ in range(30):  # largest centred rectangle that is ≥99% inside the mask
            hw = (lo + hi) / 2
            inside = (np.abs(u - u0) <= hw) & (np.abs(v - v0) <= hw / aspect)
            if inside.sum() and mask[inside].mean() >= 0.99:
                lo = hw
            else:
                hi = hw
        return u0, v0, lo, lo / aspect

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

    def depth_image(self, disp: np.ndarray, near: float, far: float) -> np.ndarray:
        """Per-pixel depth (rect frame z, metres); 0 where there is none."""
        z = np.zeros(disp.shape, np.float32)
        ok = disp > 0.5
        z[ok] = self.focal * self.baseline / disp[ok]
        z[(z < near) | (z > far)] = 0
        return z


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



# ---- surface (TSDF) -----------------------------------------------------------------

BLOCK = 8  # voxels per block edge
_LOCAL = np.stack(np.meshgrid(*[np.arange(BLOCK)] * 3, indexing="ij"), -1).reshape(-1, 3)
_CORNERS = np.array([[i & 1, (i >> 1) & 1, (i >> 2) & 1] for i in range(8)])
_EDGES = [(a, b) for a in range(8) for b in range(8) if a < b and bin(a ^ b).count("1") == 1]


def _pack(q: np.ndarray) -> np.ndarray:
    q = q.astype(np.int64) + (1 << 20)
    return (q[..., 0] << 42) | (q[..., 1] << 21) | q[..., 2]


class TSDFMap:
    """Truncated signed distance to the nearest surface, in sparse 8×8×8 voxel
    blocks (only blocks near something seen exist). Each depth frame updates the
    blocks around its points: a voxel in front of the measured depth moves
    towards +1 (free), one just behind it towards the negative distance. The
    surface is where the averaged field crosses zero; mesh() extracts it.

    Averaging distances (rather than points, as VoxelMap does) cancels stereo
    noise along the line of sight and gives a closed surface with normals.
    `box` (lo, hi in world metres) restricts the map to one object."""

    def __init__(self, voxel: float = 0.02, box: tuple[np.ndarray, np.ndarray] | None = None):
        self.lock = threading.Lock()
        self.reset(voxel, box)

    def reset(self, voxel: float | None = None, box=None) -> None:
        with self.lock:
            if voxel:
                self.voxel = voxel
                self.trunc = max(4 * voxel, 0.02)
            self.box = box
            self.index: dict[int, int] = {}
            self.n = 0
            self.coords = np.zeros((256, 3), np.int64)
            self.tsdf = np.ones((256, BLOCK ** 3), np.float32)
            self.weight = np.zeros((256, BLOCK ** 3), np.float32)
            self.gray = np.zeros((256, BLOCK ** 3), np.float32)
            self.version = 0
            self._mesh: tuple | None = None

    def _grow(self, cap: int) -> None:
        def more(arr, fill):
            out = np.full((cap, *arr.shape[1:]), fill, arr.dtype)
            out[: self.n] = arr[: self.n]
            return out
        self.coords, self.tsdf = more(self.coords, 0), more(self.tsdf, 1.0)
        self.weight, self.gray = more(self.weight, 0.0), more(self.gray, 0.0)

    def _blocks(self, keys: np.ndarray, coords: np.ndarray) -> np.ndarray:
        idx = np.fromiter((self.index.get(k, -1) for k in keys.tolist()), np.int64, len(keys))
        new = idx < 0
        if new.any():
            k = int(new.sum())
            if self.n + k > len(self.coords):
                self._grow(max(2 * len(self.coords), self.n + k))
            ids = np.arange(self.n, self.n + k)
            self.index.update(zip(keys[new].tolist(), ids.tolist()))
            self.coords[ids] = coords[new]
            idx[new] = ids
            self.n += k
        return idx

    def integrate(self, depth: np.ndarray, gray: np.ndarray, f: float, cx: float, cy: float, T_world_cam: np.ndarray, max_weight: float = 50) -> None:
        h, w = depth.shape
        R, t = T_world_cam[:3, :3], T_world_cam[:3, 3]
        bs = self.voxel * BLOCK

        # Blocks to touch: those around this frame's points, from just in front to just behind.
        ys, xs = np.nonzero(depth[::4, ::4])
        if len(ys) == 0:
            return
        z = depth[ys * 4, xs * 4]
        ray = np.stack([(xs * 4 - cx) / f, (ys * 4 - cy) / f, np.ones_like(z)], 1)
        pts = np.concatenate([ray * (z + s)[:, None] for s in (-self.trunc, 0, self.trunc)]) @ R.T + t
        if self.box is not None:
            lo, hi = self.box
            pts = pts[np.all((pts >= lo) & (pts <= hi), 1)]
        q = np.unique(np.floor(pts / bs).astype(np.int64), axis=0)
        if len(q) == 0:
            return

        with self.lock:
            idx = self._blocks(_pack(q), q)
            centres = ((q[:, None, :] * BLOCK + _LOCAL[None]) + 0.5) * self.voxel  # (n, 512, 3) world
            c = (centres - t) @ R  # camera frame
            zc = c[..., 2]
            with np.errstate(divide="ignore", invalid="ignore"):
                u = np.rint(c[..., 0] / zc * f + cx)
                v = np.rint(c[..., 1] / zc * f + cy)
            ok = (zc > 0.05) & (u >= 0) & (u < w) & (v >= 0) & (v < h)
            ui, vi = u[ok].astype(np.int64), v[ok].astype(np.int64)
            d = np.zeros_like(zc)
            d[ok] = depth[vi, ui]
            sdf = d - zc
            upd = ok & (d > 0) & (sdf > -self.trunc)
            if self.box is not None:
                lo, hi = self.box
                upd &= np.all((centres >= lo) & (centres <= hi), -1)
            bi, vi_ = np.nonzero(upd)
            blk = idx[bi]
            val = np.minimum(1.0, sdf[bi, vi_] / self.trunc)
            wt = self.weight[blk, vi_]
            self.tsdf[blk, vi_] = (self.tsdf[blk, vi_] * wt + val) / (wt + 1)
            self.weight[blk, vi_] = np.minimum(wt + 1, max_weight)
            # Gray only from near the surface (free space has no colour of its own).
            near = np.abs(val) < 1
            g = np.zeros_like(zc)
            g[ok] = gray[v[ok].astype(np.int64), u[ok].astype(np.int64)]
            gb, gv = blk[near], vi_[near]
            self.gray[gb, gv] = (self.gray[gb, gv] * wt[near] + g[bi, vi_][near]) / (wt[near] + 1)
            self.version += 1

    def mesh(self, min_weight: float = 3) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """Surface where the field crosses zero, as (vertices f32 (n,3), gray u8 (n),
        triangles u32 (m,3)). Surface nets: one vertex per voxel cell the surface
        passes through, at the mean of its edge crossings; one quad per crossed edge.
        Triangles wind counter-clockwise seen from the free (positive) side."""
        with self.lock:
            key = (self.version, min_weight)
            if self._mesh and self._mesh[0] == key:
                return self._mesh[1]
            n = self.n
            coords, tsdf, weight, gray = self.coords[:n].copy(), self.tsdf[:n].copy(), self.weight[:n].copy(), self.gray[:n].copy()
            voxel = self.voxel
        empty = (np.zeros((0, 3), np.float32), np.zeros(0, np.uint8), np.zeros((0, 3), np.uint32))
        g = (coords[:, None, :] * BLOCK + _LOCAL[None]).reshape(-1, 3)
        m = weight.ravel() >= min_weight
        g, val, gr = g[m], tsdf.ravel()[m], gray.ravel()[m]
        if len(g) == 0:
            out = empty
        else:
            keys = _pack(g)
            order = np.argsort(keys)
            keys, g, val, gr = keys[order], g[order], val[order], gr[order]

            def look(q):
                k = _pack(q)
                i = np.clip(np.searchsorted(keys, k), 0, len(keys) - 1)
                return np.where(keys[i] == k, i, -1)

            # Cells (by their lowest corner) that touch an inside voxel.
            neg = g[val < 0]
            cells = np.unique((neg[:, None, :] - _CORNERS[None]).reshape(-1, 3), axis=0)
            ci = look(cells[:, None, :] + _CORNERS[None])  # (c, 8)
            full = np.all(ci >= 0, 1)
            cells, ci = cells[full], ci[full]
            cv = val[ci]
            inside = cv < 0
            active = inside.any(1) & ~inside.all(1)
            cells, ci, cv = cells[active], ci[active], cv[active]
            if len(cells) == 0:
                out = empty
            else:
                acc = np.zeros((len(cells), 3))
                cnt = np.zeros(len(cells))
                for a, b in _EDGES:
                    va, vb = cv[:, a], cv[:, b]
                    x = (va < 0) != (vb < 0)
                    tt = va[x] / (va[x] - vb[x])
                    acc[x] += _CORNERS[a] + tt[:, None] * (_CORNERS[b] - _CORNERS[a])
                    cnt[x] += 1
                verts = ((cells + acc / cnt[:, None] + 0.5) * voxel).astype(np.float32)
                vgray = np.clip(gr[ci].mean(1), 0, 255).astype(np.uint8)
                ckeys = _pack(cells)  # sorted: cells came from np.unique, packing keeps the order

                def cell(q):
                    k = _pack(q)
                    i = np.clip(np.searchsorted(ckeys, k), 0, len(ckeys) - 1)
                    return np.where(ckeys[i] == k, i, -1)

                tris = []
                eye = np.eye(3, dtype=np.int64)
                for a in range(3):
                    eu, ev = eye[(a + 1) % 3], eye[(a + 2) % 3]
                    for s in (1, -1):
                        j = look(neg + s * eye[a])
                        hit = j >= 0
                        hit[hit] = val[j[hit]] >= 0
                        lo = neg[hit] if s == 1 else neg[hit] - eye[a]
                        quad = np.stack([cell(lo), cell(lo - eu), cell(lo - eu - ev), cell(lo - ev)], 1)
                        quad = quad[np.all(quad >= 0, 1)]
                        if s == -1:  # inside is the upper end: the surface faces -a
                            quad = quad[:, ::-1]
                        tris += [quad[:, [0, 1, 2]], quad[:, [0, 2, 3]]]
                out = (verts, vgray, np.concatenate(tris).astype(np.uint32))
        with self.lock:
            if self.version == key[0]:
                self._mesh = (key, out)
        return out

    def save_ply(self, path: Path, min_weight: float) -> int:
        verts, gray, tris = self.mesh(min_weight)
        with open(path, "wb") as f:
            f.write(
                (
                    "ply\nformat binary_little_endian 1.0\n"
                    f"element vertex {len(verts)}\n"
                    "property float x\nproperty float y\nproperty float z\n"
                    "property uchar red\nproperty uchar green\nproperty uchar blue\n"
                    f"element face {len(tris)}\nproperty list uchar uint vertex_indices\nend_header\n"
                ).encode()
            )
            rec = np.zeros(len(verts), dtype=[("p", "<f4", 3), ("c", "u1", 3)])
            rec["p"] = verts
            rec["c"] = gray[:, None]
            f.write(rec.tobytes())
            face = np.zeros(len(tris), dtype=[("n", "u1"), ("i", "<u4", 3)])
            face["n"] = 3
            face["i"] = tris
            f.write(face.tobytes())
        return len(tris)
