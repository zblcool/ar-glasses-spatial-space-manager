"""Record RGB keyframes, then turn them into a textured model with Object Capture.

Recorder: while recording, every RGB frame from the glasses' front camera is
looked at. A new keyframe is due once the head has moved 4 cm or turned 6°
since the last one (with no 6DoF pose: every 0.6 s). The sharpest frame of
the next ~0.35 s is kept, so motion blur is avoided without asking you to
stop. Frames go to captures/<name>/images/ as the camera's own JPEGs (no
re-encoding), with their head poses in captures/<name>/frames.json.

Builder: runs tools/capture/build/object-capture (Swift, Apple's
PhotogrammetrySession) on a capture and reports its progress. The model goes
to captures/<name>/model/: model.usdz, obj/ (OBJ + MTL + textures) and
detail.txt. Building again (say at a higher detail) replaces it once done.
"""

from __future__ import annotations

import json
import subprocess
import threading
import time
from collections import deque
from pathlib import Path

import cv2
import numpy as np

from core import FrameStream, rotation_angle

ROOT = Path(__file__).resolve().parent.parent.parent
TOOL_SRC = ROOT / "tools" / "capture" / "object_capture.swift"
TOOL = ROOT / "tools" / "capture" / "build" / "object-capture"

MOVE_M, TURN_RAD, NO_POSE_S = 0.04, np.radians(6), 0.6
WINDOW_S, MAX_FRAMES = 0.35, 400


class Recorder:
    def __init__(self, stream: FrameStream, root: Path):
        self.stream, self.root = stream, root
        self.poses: deque = deque(maxlen=240)  # (epoch ms, T_world_dev) of recent stereo frames
        self.dir: Path | None = None
        self.frames: list[dict] = []
        self.message = ""
        self.sharp_hist: deque = deque(maxlen=90)
        self.rgb_times: deque = deque(maxlen=60)
        self.preview: bytes = b""
        self.lock = threading.Lock()
        threading.Thread(target=self._run, daemon=True).start()

    # ---- control ----

    @property
    def recording(self) -> bool:
        return self.dir is not None

    def start(self) -> str:
        with self.lock:
            name = time.strftime("capture-%Y%m%d-%H%M%S")
            self.dir = self.root / name
            (self.dir / "images").mkdir(parents=True)
            self.frames, self.message = [], ""
            self.last: tuple | None = None  # (t, pose) of the last keyframe
            self.window: list | None = None  # candidates: (sharpness, t, jpeg, pose)
        self.stream.command("rgb 1")
        return name

    def stop(self, message: str = "") -> None:
        with self.lock:
            if self.dir:
                self._write_meta()
            self.dir = None
            self.message = message
        self.stream.command("rgb 0")

    def add_pose(self, t: float, pose: np.ndarray) -> None:
        self.poses.append((t, pose))

    def state(self) -> dict:
        now = time.time()
        fps = sum(1 for t in self.rgb_times if t > now - 2) / 2
        return {"recording": self.recording, "name": self.dir.name if self.dir else None, "frames": len(self.frames),
                "rgb_fps": fps, "rgb": self.stream.status.get("rgb"), "rgb_message": self.stream.status.get("message"),
                "message": self.message, "max": MAX_FRAMES}

    def captures(self) -> list[dict]:
        out = []
        for d in sorted(self.root.glob("capture-*"), reverse=True):
            m = d / "model"
            objs = sorted((m / "obj").glob("*.obj"))
            usdz = m / "model.usdz"
            out.append({"name": d.name, "images": len(list((d / "images").glob("*.jpg"))),
                        "usdz": usdz.exists(), "obj": objs[0].name if objs else None,
                        "detail": (m / "detail.txt").read_text().strip() if (m / "detail.txt").exists() else None,
                        "built": int(usdz.stat().st_mtime) if usdz.exists() else None})
        return out

    # ---- keyframes ----

    def _pose_at(self, t: float) -> np.ndarray | None:
        if not self.poses:
            return None
        pt, pose = min(self.poses, key=lambda p: abs(p[0] - t))
        return pose if abs(pt - t) < 150 else None

    def _due(self, t: float, pose: np.ndarray | None) -> bool:
        if self.last is None:
            return True
        lt, lpose = self.last
        if pose is None or lpose is None:
            return t - lt >= NO_POSE_S * 1000
        moved = np.linalg.norm(pose[:3, 3] - lpose[:3, 3])
        return moved >= MOVE_M or rotation_angle(lpose[:3, :3].T @ pose[:3, :3]) >= TURN_RAD

    def _run(self) -> None:
        seq = 0
        while True:
            f = self.stream.next_rgb(seq)
            if f is None:
                continue
            seq, t, jpeg = f
            self.rgb_times.append(time.time())
            self.preview = jpeg
            if not self.recording:
                continue
            g = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_REDUCED_GRAYSCALE_4)
            if g is None:
                continue
            sharp = float(cv2.Laplacian(g, cv2.CV_64F).var())
            self.sharp_hist.append(sharp)
            pose = self._pose_at(t)
            with self.lock:
                if not self.dir:
                    continue
                if self.window is None and self._due(t, pose):
                    self.window = []
                if self.window is not None:
                    self.window.append((sharp, t, jpeg, pose))
                    if t - self.window[0][1] >= WINDOW_S * 1000:
                        self._keep()
            if len(self.frames) >= MAX_FRAMES:
                self.stop(f"已到 {MAX_FRAMES} 张，自动停止")

    def _keep(self) -> None:
        sharp, t, jpeg, pose = max(self.window, key=lambda c: c[0])
        self.window = None
        # All blurred (turning or walking fast): try again with the next frames.
        if len(self.sharp_hist) > 20 and sharp < 0.4 * float(np.median(self.sharp_hist)):
            return
        name = f"{len(self.frames) + 1:04d}.jpg"
        (self.dir / "images" / name).write_bytes(jpeg)
        self.frames.append({"file": name, "t": t, "sharpness": round(sharp, 1),
                            "T_world_dev": None if pose is None else pose.tolist()})
        self.last = (t, pose)
        if len(self.frames) % 10 == 0:
            self._write_meta()

    def _write_meta(self) -> None:
        (self.dir / "frames.json").write_text(json.dumps({"frames": self.frames}, indent=1))


def ensure_tool() -> str | None:
    """Compile the Object Capture tool if it is missing or older than its source.
    Returns an error message, or None when it is ready."""
    if TOOL.exists() and TOOL.stat().st_mtime >= TOOL_SRC.stat().st_mtime:
        return None
    TOOL.parent.mkdir(parents=True, exist_ok=True)
    r = subprocess.run(["swiftc", "-O", "-parse-as-library", "-swift-version", "5", str(TOOL_SRC), "-o", str(TOOL)],
                       capture_output=True, text=True)
    if r.returncode != 0:
        return "编译 Object Capture 工具失败（需要 Xcode Command Line Tools）：" + (r.stderr.strip().splitlines() or ["?"])[-1]
    return None


HINTS = {
    "processError": "照片没能拼到一起。可能是张数太少、相邻两张重叠不够（走得太快），或物体和背景没有花纹。重新录一次，走慢一点、多拍几圈。",
}


class Builder:
    """One Object Capture run at a time."""

    def __init__(self):
        self.job: dict | None = None
        self.proc: subprocess.Popen | None = None

    def start(self, capture: Path, detail: str) -> None:
        if self.proc and self.proc.poll() is None:
            raise RuntimeError("已经在生成一个模型了")
        self.job = {"name": capture.name, "detail": detail, "stage": "准备", "progress": 0.0, "started": time.time(),
                    "warnings": 0, "error": None, "done": False}
        threading.Thread(target=self._run, args=(capture, detail), daemon=True).start()

    def cancel(self) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.terminate()

    def state(self) -> dict | None:
        if not self.job:
            return None
        return {**self.job, "elapsed": round(time.time() - self.job["started"])}

    def _run(self, capture: Path, detail: str) -> None:
        job = self.job
        job["stage"] = "编译工具"
        err = ensure_tool()
        if err:
            job["error"] = err
            return
        job["stage"] = "开始"
        self.proc = subprocess.Popen([str(TOOL), str(capture / "images"), str(capture / "model"), "--detail", detail],
                                     stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
        for line in self.proc.stdout:
            try:
                o = json.loads(line)
            except ValueError:
                continue  # the framework's own log lines
            if "progress" in o:
                job["progress"] = o["progress"]
                job["stage"] = o.get("stage", job["stage"])
                job["eta"] = o.get("eta")
            elif "warning" in o:
                job["warnings"] += 1
                job["last_warning"] = o["warning"]
            elif "error" in o:
                job["error"] = HINTS.get(o["error"], o["error"])
            elif "done" in o:
                job["done"], job["progress"], job["stage"] = True, 1.0, "完成"
        code = self.proc.wait()
        if not job["done"] and not job["error"]:
            job["error"] = "已取消" if code < 0 else f"object-capture 退出（{code}）"
