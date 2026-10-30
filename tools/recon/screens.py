"""Physical size of the Mac's displays, for sizing the calibration board.

CoreGraphics reports each display's size in millimetres (from its EDID; exact
for built-in panels, e.g. a 13.6" MacBook Air M2 reports ~290 × 189 mm) and its
bounds in points. A CSS pixel at 100% browser zoom is one point, so the page
can turn the board's on-screen size into millimetres.
"""

from __future__ import annotations

import ctypes
import ctypes.util
import sys


class CGSize(ctypes.Structure):
    _fields_ = [("width", ctypes.c_double), ("height", ctypes.c_double)]


class CGPoint(ctypes.Structure):
    _fields_ = [("x", ctypes.c_double), ("y", ctypes.c_double)]


class CGRect(ctypes.Structure):
    _fields_ = [("origin", CGPoint), ("size", CGSize)]


def displays() -> list[dict]:
    """Active displays: id, builtin, mm [w, h] (0 when unknown), points
    [x, y, w, h] in the global desktop space, and backing scale (pixels per point)."""
    if sys.platform != "darwin":
        return []
    try:
        cg = ctypes.CDLL(ctypes.util.find_library("CoreGraphics"))
    except OSError:
        return []
    cg.CGGetActiveDisplayList.argtypes = [ctypes.c_uint32, ctypes.POINTER(ctypes.c_uint32), ctypes.POINTER(ctypes.c_uint32)]
    cg.CGDisplayScreenSize.restype = CGSize
    cg.CGDisplayScreenSize.argtypes = [ctypes.c_uint32]
    cg.CGDisplayBounds.restype = CGRect
    cg.CGDisplayBounds.argtypes = [ctypes.c_uint32]
    cg.CGDisplayIsBuiltin.argtypes = [ctypes.c_uint32]
    cg.CGDisplayCopyDisplayMode.restype = ctypes.c_void_p
    cg.CGDisplayCopyDisplayMode.argtypes = [ctypes.c_uint32]
    cg.CGDisplayModeGetPixelWidth.argtypes = [ctypes.c_void_p]
    cg.CGDisplayModeGetPixelWidth.restype = ctypes.c_size_t
    cg.CGDisplayModeRelease.argtypes = [ctypes.c_void_p]

    ids = (ctypes.c_uint32 * 16)()
    count = ctypes.c_uint32()
    if cg.CGGetActiveDisplayList(16, ids, ctypes.byref(count)) != 0:
        return []
    out = []
    for i in range(count.value):
        d = ids[i]
        size = cg.CGDisplayScreenSize(d)
        b = cg.CGDisplayBounds(d)
        scale = 1.0
        mode = cg.CGDisplayCopyDisplayMode(d)
        if mode:
            if b.size.width > 0:
                scale = cg.CGDisplayModeGetPixelWidth(mode) / b.size.width
            cg.CGDisplayModeRelease(mode)
        out.append({
            "id": int(d),
            "builtin": bool(cg.CGDisplayIsBuiltin(d)),
            "mm": [round(size.width, 2), round(size.height, 2)],
            "points": [b.origin.x, b.origin.y, b.size.width, b.size.height],
            "scale": round(scale, 4),
        })
    return out


if __name__ == "__main__":
    for d in displays():
        mm_per_pt = d["mm"][0] / d["points"][2] if d["points"][2] else 0
        print(d, f"→ {mm_per_pt:.4f} mm per point")
