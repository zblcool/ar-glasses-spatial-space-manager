"""Checkerboard calibration of the Luma Ultra's tracking cameras.

Used by recon.py's calibration page: the page shows a 9×6 checkerboard full
screen, and you look at it with the glasses from many directions. A view is
captured automatically when both eyes see the whole board and your head has
been still for a moment. After enough views it solves for:

  - each eye's fisheye intrinsics (OpenCV's equidistant model);
  - the right eye relative to the left (stereo extrinsics);
  - the left eye relative to the glasses' tracked pose (hand-eye), which
    places the depth in the world;
  - the board's real size, in one of three ways (Calibrator.method):
    "screen": from the display's physical size (screens.py), the default;
    "manual": measured with a ruler and typed in;
    "auto":   solved together with the hand-eye, since the SDK's head
              positions are in metres (needs the head to move, not only turn).
    With a known size the auto estimate is still reported, as a cross-check.
"""

from __future__ import annotations

import threading
import time
from collections import deque

import cv2
import numpy as np

from core import Calibration, StereoFrame, invert, make_T, rotation_angle

PATTERN = (9, 6)  # inner corners of the board on the calibration page


def fisheye_flag(name: str) -> int:
    """cv2.fisheye.CALIB_* in OpenCV 4; plain cv2.CALIB_* in OpenCV 5."""
    return getattr(cv2.fisheye, name, None) or getattr(cv2, name)


def detect(gray: np.ndarray, pattern=PATTERN):
    ok, corners = cv2.findChessboardCornersSB(gray, pattern, flags=cv2.CALIB_CB_NORMALIZE_IMAGE | cv2.CALIB_CB_EXHAUSTIVE)
    return corners.reshape(-1, 1, 2).astype(np.float64) if ok else None


def board_points(square: float, pattern=PATTERN) -> np.ndarray:
    g = np.zeros((pattern[0] * pattern[1], 1, 3))
    g[:, 0, :2] = np.mgrid[0 : pattern[0], 0 : pattern[1]].T.reshape(-1, 2) * square
    return g


def same_order(cl: np.ndarray, cr: np.ndarray) -> np.ndarray:
    """The two eyes must number the corners the same way; a symmetric board
    can come back rotated 180° in one of them."""
    dl, dr = cl[-1, 0] - cl[0, 0], cr[-1, 0] - cr[0, 0]
    return cr[::-1].copy() if float(np.dot(dl, dr)) < 0 else cr


def board_pose(obj: np.ndarray, corners: np.ndarray, K: np.ndarray, D: np.ndarray) -> np.ndarray:
    """T_cam_board from one view (fisheye: undistort to normalised points first)."""
    norm = cv2.fisheye.undistortPoints(corners, K, D)
    ok, rvec, tvec = cv2.solvePnP(obj, norm, np.eye(3), None, flags=cv2.SOLVEPNP_ITERATIVE)
    return make_T(cv2.Rodrigues(rvec)[0], tvec)


def hand_eye(T_world_dev: list[np.ndarray], T_cam_board: list[np.ndarray], solve_scale: bool) -> tuple[np.ndarray, float]:
    """X = T_dev_cam (and the board's scale) from a static board seen from
    several head poses.

    T_world_dev[i] · X · T_cam_board[i] is the same board pose for every i, so for
    each pair A X = X B with A = Td_j⁻¹ Td_i and B = Tc_j Tc_i⁻¹ (Park & Martin):
    the rotation from the pairs' rotation axes, then the translation by least
    squares, with the board's unknown scale s as a fourth unknown:
    (R_A − I) t_X − s R_X t_B = −t_A. (OpenCV's calibrateHandEye is missing from
    some builds and has no scale, hence this.)"""
    As, Bs = [], []
    n = len(T_world_dev)
    for i in range(n):
        for j in range(i + 1, n):
            A = invert(T_world_dev[j]) @ T_world_dev[i]
            B = T_cam_board[j] @ invert(T_cam_board[i])
            if rotation_angle(A[:3, :3]) > np.radians(5):
                As.append(A)
                Bs.append(B)
    if len(As) < 3:
        raise ValueError("头部转动的角度不够，多歪头、抬头、低头")
    alpha = np.array([cv2.Rodrigues(A[:3, :3])[0].ravel() for A in As])
    beta = np.array([cv2.Rodrigues(B[:3, :3])[0].ravel() for B in Bs])
    U, _, Vt = np.linalg.svd(beta.T @ alpha)
    R = Vt.T @ np.diag([1, 1, np.sign(np.linalg.det(Vt.T @ U.T))]) @ U.T
    rows = [np.c_[A[:3, :3] - np.eye(3), -(R @ B[:3, 3])[:, None]] for A, B in zip(As, Bs)]
    M = np.concatenate(rows)
    v = np.concatenate([-A[:3, 3] for A in As])
    if solve_scale:
        x = np.linalg.lstsq(M, v, rcond=None)[0]
        t, s = x[:3], float(x[3])
    else:
        s = 1.0
        t = np.linalg.lstsq(M[:, :3], v - M[:, 3], rcond=None)[0]
    if not s > 0:
        raise ValueError("推算不出格子大小：头要前后移动（靠近、退远），不只是转动")
    return make_T(R, t), s


def solve(views: list[dict], size: tuple[int, int], square: float | None = None) -> tuple[Calibration, dict]:
    """views: dicts with 'left' / 'right' corners and 'pose' (T_world_dev).
    square: the board square in metres, or None to solve for it."""
    unit = square or 1.0
    obj = board_points(unit)
    objs = [obj] * len(views)
    L = [v["left"] for v in views]
    R = [v["right"] for v in views]
    flags = fisheye_flag("CALIB_RECOMPUTE_EXTRINSIC") | fisheye_flag("CALIB_FIX_SKEW")
    crit = (cv2.TERM_CRITERIA_COUNT + cv2.TERM_CRITERIA_EPS, 100, 1e-7)
    rms_l, K1, D1, _, _ = cv2.fisheye.calibrate(objs, L, size, None, None, flags=flags, criteria=crit)
    rms_r, K2, D2, _, _ = cv2.fisheye.calibrate(objs, R, size, None, None, flags=flags, criteria=crit)
    out = cv2.fisheye.stereoCalibrate(objs, L, R, K1, D1, K2, D2, size, flags=fisheye_flag("CALIB_FIX_INTRINSIC"), criteria=crit)
    rms_s, Rs, Ts = out[0], out[5], out[6]

    poses = [v["pose"] for v in views]
    boards = [board_pose(obj, c, K1, D1) for c in L]
    X, s = hand_eye(poses, boards, solve_scale=square is None)
    try:
        square_vio = unit * (s if square is None else hand_eye(poses, boards, solve_scale=True)[1])
    except ValueError:
        square_vio = float("nan")
    # Everything measured in board units becomes metres.
    Ts = Ts * s
    boards = [make_T(B[:3, :3], B[:3, 3] * s) for B in boards]
    obj_m = obj * s
    # Consistency: where each view puts the board's corners in the world.
    world = np.array([(Td @ X @ Tb @ np.c_[obj_m[:, 0], np.ones(len(obj))].T)[:3].T for Td, Tb in zip(poses, boards)])
    spread = float(np.sqrt(((world - world.mean(axis=0)) ** 2).sum(axis=2).mean()))
    stats = {
        "views": len(views),
        "rms_left_px": float(rms_l),
        "rms_right_px": float(rms_r),
        "rms_stereo_px": float(rms_s),
        "baseline_m": float(np.linalg.norm(Ts)),
        "square_m": float(unit * s),
        "square_vio_m": float(square_vio),
        "hand_eye_spread_m": spread,
    }
    return Calibration(size, K1, D1, K2, D2, Rs, Ts.reshape(3, 1), X), stats


class Calibrator:
    """Collects views from live frames (step) and solves on a thread once it
    has `target` of them. state() feeds the calibration page."""

    METHODS = ("screen", "manual", "auto")

    def __init__(self, target: int = 25, method: str = "auto", square: float | None = None):
        self.target = target
        self.method = method  # see the module docstring
        self.square = square  # metres; required unless method == "auto"
        self.views: list[dict] = []
        self.history: deque = deque()  # (time, T_world_dev)
        self.last_detect = 0.0
        self.message = "看着屏幕上的棋盘格"
        self.board_seen = False
        self.solving = False
        self.result: tuple[Calibration, dict] | None = None
        self.error: str | None = None
        self.captured_at = 0.0
        self.size: tuple[int, int] | None = None
        self.preview = b""

    def state(self) -> dict:
        h = self.size[1] if self.size else 1
        w = self.size[0] if self.size else 1
        return {
            "views": len(self.views), "target": self.target, "message": self.message,
            "board": self.board_seen, "solving": self.solving, "error": self.error,
            "captured_at": self.captured_at, "method": self.method,
            "square_mm": round(self.square * 1000, 3) if self.square else None,
            "coverage": [[float(v["centre"][0] / w), float(v["centre"][1] / h)] for v in self.views],
        }

    def step(self, f: StereoFrame) -> None:
        if self.solving or self.result:
            return
        now = time.time()
        self.size = (f.left.shape[1], f.left.shape[0])
        if f.pose is not None:
            self.history.append((now, f.pose))
        while self.history and self.history[0][0] < now - 0.5:
            self.history.popleft()
        steady = (
            f.pose is not None and f.pose_stable and len(self.history) > 3
            and self.history[-1][0] - self.history[0][0] > 0.35
            and all(
                rotation_angle(T[:3, :3].T @ f.pose[:3, :3]) < np.radians(0.6)
                and np.linalg.norm(T[:3, 3] - f.pose[:3, 3]) < 0.004
                for _, T in self.history
            )
        )
        if not steady and now - self.last_detect < 0.4:
            return
        self.last_detect = now
        cl, cr = detect(f.left), detect(f.right)
        self.board_seen = cl is not None and cr is not None
        self.preview = self._preview(f, cl, cr)
        if f.pose is None or not f.pose_stable:
            self.message = "等眼镜的空间定位就绪…"
        elif cl is None and cr is None:
            self.message = "看着屏幕上的棋盘格"
        elif not self.board_seen:
            self.message = "只有一只眼看到整个棋盘格，正对屏幕一点"
        else:
            cr = same_order(cl, cr)
            centre = cl[:, 0].mean(axis=0)
            new = all(
                rotation_angle(v["pose"][:3, :3].T @ f.pose[:3, :3]) > np.radians(8)
                or np.linalg.norm(v["pose"][:3, 3] - f.pose[:3, 3]) > 0.08
                or np.linalg.norm(v["centre"] - centre) > 60
                for v in self.views
            )
            if not steady:
                self.message = "看到了，停住别动"
            elif not new:
                self.message = "这个角度拍过了，换个角度 / 远近"
            else:
                self.views.append({"left": cl, "right": cr, "pose": f.pose, "centre": centre})
                self.captured_at = now
                self.message = "拍到了！换个角度"
                if len(self.views) >= self.target:
                    self.solve_now()

    def configure(self, method: str, square: float | None) -> None:
        if method not in self.METHODS:
            raise ValueError(f"method must be one of {self.METHODS}")
        self.method, self.square = method, square
        self.error = None
        if method != "auto" and not square:
            self.message = "先填写格子的边长"
        elif len(self.views) >= self.target:
            self.solve_now()

    def solve_now(self) -> bool:
        """Solve with the views so far (at least 12)."""
        if self.solving or self.result or len(self.views) < 12:
            return False
        if self.method != "auto" and not self.square:
            self.error = "还不知道格子的边长：填上量到的毫米数，或换一种尺寸方式。"
            return False
        self.solving = True
        self.error = None
        self.message = "计算中…"
        threading.Thread(target=self._solve, daemon=True).start()
        return True

    def _solve(self) -> None:
        try:
            calib, stats = solve(self.views, self.size, self.square if self.method != "auto" else None)
            stats["square_method"] = self.method
            given, vio = stats["square_m"], stats["square_vio_m"]
            if self.method != "auto" and vio > 0 and abs(vio / given - 1) > 0.15:
                hint = "检查浏览器缩放是否 100%、棋盘格是否在 Mac 自己的屏幕上" if self.method == "screen" else "再量一次"
                raise ValueError(f"格子大小对不上：设定 {given * 1000:.2f} mm，眼镜定位估算约 {vio * 1000:.1f} mm。{hint}，或点「更改」换一种方式")
            if stats["rms_stereo_px"] > 1.5 or stats["hand_eye_spread_m"] > 0.03:
                raise ValueError(f"误差偏大（重投影 {stats['rms_stereo_px']:.2f} px，手眼 {stats['hand_eye_spread_m'] * 100:.1f} cm）。再多拍几个不同角度和远近的画面")
            self.result = (calib, stats)
            self.message = "标定完成"
        except (cv2.error, ValueError) as err:
            # Keep the views and ask for more variety.
            self.error = f"{err}。"
            self.target = len(self.views) + 8
            self.message = "需要更多角度"
        finally:
            self.solving = False

    @staticmethod
    def _preview(f: StereoFrame, cl, cr) -> bytes:
        vis = cv2.cvtColor(np.hstack([f.left, f.right]), cv2.COLOR_GRAY2BGR)
        w = f.left.shape[1]
        if cl is not None:
            cv2.drawChessboardCorners(vis[:, :w], PATTERN, cl.astype(np.float32), True)
        if cr is not None:
            cv2.drawChessboardCorners(vis[:, w:], PATTERN, cr.astype(np.float32), True)
        vis = cv2.resize(vis, (vis.shape[1] // 2, vis.shape[0] // 2))
        return cv2.imencode(".jpg", vis, [cv2.IMWRITE_JPEG_QUALITY, 70])[1].tobytes()
