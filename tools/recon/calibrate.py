#!/usr/bin/env python3
"""Calibrate the Luma Ultra's tracking cameras with a checkerboard.

    npm run cameras                                    # in another terminal
    python3 tools/recon/calibrate.py --square-mm 28.5

Show the board (http://localhost:8787/checkerboard, full screen) on a screen
and keep it still. Look at it with the glasses from many directions: near and
far, tilted, in every part of both eyes' view. A view is captured
automatically when both eyes see the whole board and your head has been still
for a moment. After enough views it solves for:

  - each eye's fisheye intrinsics (OpenCV's equidistant model);
  - the right eye relative to the left (stereo extrinsics);
  - the left eye relative to the glasses' tracked pose (hand-eye), which
    places the depth in the world.

and writes tools/recon/calib.json. Keys in the preview window: space captures
the current view, c solves now (at least 10 views), q quits.
"""

from __future__ import annotations

import argparse
import time
from collections import deque
from pathlib import Path

import cv2
import numpy as np

from core import Calibration, FrameStream, invert, make_T, rotation_angle

HERE = Path(__file__).resolve().parent
PATTERN = (9, 6)  # inner corners of the board served at /checkerboard


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


def hand_eye(T_world_dev: list[np.ndarray], T_cam_board: list[np.ndarray]) -> np.ndarray:
    """X = T_dev_cam from a static board seen from several head poses.

    T_world_dev[i] · X · T_cam_board[i] is the same board pose for every i, so for
    each pair A X = X B with A = Td_j⁻¹ Td_i and B = Tc_j Tc_i⁻¹ (Park & Martin):
    the rotation from the pairs' rotation axes, then the translation by least squares.
    (OpenCV's calibrateHandEye is missing from some builds, hence this.)"""
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
        raise ValueError("not enough head rotation between views for the hand-eye solve; turn and tilt your head more")
    alpha = np.array([cv2.Rodrigues(A[:3, :3])[0].ravel() for A in As])
    beta = np.array([cv2.Rodrigues(B[:3, :3])[0].ravel() for B in Bs])
    U, _, Vt = np.linalg.svd(beta.T @ alpha)
    R = Vt.T @ np.diag([1, 1, np.sign(np.linalg.det(Vt.T @ U.T))]) @ U.T
    M = np.concatenate([A[:3, :3] - np.eye(3) for A in As])
    v = np.concatenate([R @ B[:3, 3] - A[:3, 3] for A, B in zip(As, Bs)])
    t = np.linalg.lstsq(M, v, rcond=None)[0]
    return make_T(R, t)


def solve(views: list[dict], square: float, size: tuple[int, int]) -> tuple[Calibration, dict]:
    """views: dicts with 'left' / 'right' corners and 'pose' (T_world_dev)."""
    obj = board_points(square)
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
    X = hand_eye(poses, boards)
    # Consistency: where each view puts the board's corners in the world.
    world = np.array([(Td @ X @ Tb @ np.c_[obj[:, 0], np.ones(len(obj))].T)[:3].T for Td, Tb in zip(poses, boards)])
    spread = float(np.sqrt(((world - world.mean(axis=0)) ** 2).sum(axis=2).mean()))
    stats = {
        "views": len(views),
        "rms_left_px": float(rms_l),
        "rms_right_px": float(rms_r),
        "rms_stereo_px": float(rms_s),
        "baseline_m": float(np.linalg.norm(Ts)),
        "hand_eye_spread_m": spread,
    }
    return Calibration(size, K1, D1, K2, D2, Rs, Ts.reshape(3, 1), X), stats


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--square-mm", type=float, required=True, help="side of one board square, measured on your screen")
    ap.add_argument("--views", type=int, default=25, help="solve after this many views (default 25)")
    ap.add_argument("--port", type=int, default=8787, help="camera viewer port")
    ap.add_argument("--out", type=Path, default=HERE / "calib.json")
    args = ap.parse_args()
    square = args.square_mm / 1000.0

    stream = FrameStream(port=args.port)
    views: list[dict] = []
    history: deque = deque()  # (time, T_world_dev)
    seq, last_detect, message = 0, 0.0, "look at the board"
    while True:
        seq, frame = stream.next(seq)
        key = cv2.waitKey(1) & 0xFF
        if key == ord("q"):
            return
        if frame is None:
            print(stream.error or "waiting for frames...")
            continue
        now = time.time()
        if frame.pose is not None:
            history.append((now, frame.pose))
        while history and history[0][0] < now - 0.5:
            history.popleft()
        steady = (
            frame.pose is not None and frame.pose_stable and len(history) > 3 and history[-1][0] - history[0][0] > 0.35
            and all(
                rotation_angle(T[:3, :3].T @ frame.pose[:3, :3]) < np.radians(0.6)
                and np.linalg.norm(T[:3, 3] - frame.pose[:3, 3]) < 0.004
                for _, T in history
            )
        )

        cl = cr = None
        if steady or key == ord(" ") or now - last_detect > 0.5:
            last_detect = now
            cl, cr = detect(frame.left), detect(frame.right)
        if cl is not None and cr is not None:
            cr = same_order(cl, cr)
            centre = cl[:, 0].mean(axis=0)
            new = all(
                rotation_angle(v["pose"][:3, :3].T @ frame.pose[:3, :3]) > np.radians(8)
                or np.linalg.norm(v["pose"][:3, 3] - frame.pose[:3, 3]) > 0.08
                or np.linalg.norm(v["centre"] - centre) > 60
                for v in views
            ) if frame.pose is not None else False
            if frame.pose is None:
                message = "no head pose from the SDK yet"
            elif (steady and new) or key == ord(" "):
                views.append({"left": cl, "right": cr, "pose": frame.pose, "centre": centre})
                message = f"captured view {len(views)}"
                print(message)
            elif not steady:
                message = "board found - hold still"
            else:
                message = "already have this view - move to a new angle"

        vis = cv2.cvtColor(np.hstack([frame.left, frame.right]), cv2.COLOR_GRAY2BGR)
        if cl is not None:
            cv2.drawChessboardCorners(vis[:, : frame.left.shape[1]], PATTERN, cl.astype(np.float32), True)
        if cr is not None:
            cv2.drawChessboardCorners(vis[:, frame.left.shape[1] :], PATTERN, cr.astype(np.float32), True)
        for v in views:
            cv2.circle(vis, tuple(int(x) for x in v["centre"]), 4, (0, 200, 255), -1)
        cv2.putText(vis, f"{len(views)}/{args.views}  {message}", (12, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 0), 2)
        cv2.imshow("calibrate (space: capture, c: solve, q: quit)", vis)

        if len(views) >= args.views or (key == ord("c") and len(views) >= 10):
            h, w = frame.left.shape
            print(f"solving with {len(views)} views...")
            try:
                calib, stats = solve(views, square, (w, h))
            except (cv2.error, ValueError) as err:
                print(f"solve failed: {err}\ncapture more varied views and press c again")
                args.views += 10
                continue
            calib.save(args.out, {"stats": stats, "square_m": square})
            for k, v in stats.items():
                print(f"  {k}: {v:.4f}" if isinstance(v, float) else f"  {k}: {v}")
            print(f"wrote {args.out}")
            print("good: rms under ~0.5 px, hand_eye_spread under ~0.01 m. Worse? redo with more varied views.")
            return


if __name__ == "__main__":
    main()
