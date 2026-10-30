# Viture Open Walker

An MVP spatial desktop for macOS (Apple Silicon) with **VITURE Luma Ultra** glasses. It shows a 360° panorama rendered with three.js. Several virtual screens float in that space, and you can freely move and resize each one. The camera follows your head through the glasses' pose tracking.

**Every display is in the room.** The laptop panel, external monitors, and two **real macOS virtual displays** the app creates each become a screen. The only exception is the glasses themselves, since that's what you're looking at.

While the app is on the glasses, VOW Virtual 1 becomes the macOS **main display**, so the menu bar, the Dock and new windows land inside the 3D space. Windows on the glasses display are moved off it.

Click any screen to put the real mouse on that display and use its apps directly. The UI follows VITURE's own spatial UI: glass panels, icon pills, corner resize arcs with inch readout, a 3D dot pointer, a control center with Head-Locked / Smooth Follow / Spatial Anchor, 3D (SBS stereo) and 6DoF toggles, animated scenery and a glowing wireframe floor for depth, a **Cinema** mode that sends a screen far away and makes it huge, and an optional **hand pointer** (point + pinch + push/pull, like VITURE's ray + pinch) through the glasses' camera or the Mac's.

> **使用說明（中文）：[使用說明.md](使用說明.md)** — setup, daily use, virtual displays, mouse and keyboard controls, FAQ.

```
.
├── helper/                 native helpers (arm64)
│   ├── Makefile
│   └── src/
│       ├── main.c, usb_enum.*      viture-pose-helper (Viture SDK → JSON poses)
│       └── display_helper.m        viture-display-helper (virtual displays, main-display
│                                   switch + restore, cursor warp, keep-glasses-clear)
│       └── camera_helper.m         viture-camera-helper (all three cameras → binary stream)
├── tools/camera-viewer/    web page showing what the glasses' cameras see (not part of the app)
├── tools/recon/            live 3D reconstruction from the tracking cameras, RGB recorder (Python, not part of the app)
├── tools/capture/          object-capture: photos → textured model with Apple's Object Capture (Swift)
├── app/                    Electron + Vite + TypeScript
│   ├── electron/           main process (helper supervisor, IPC) + preload
│   ├── renderer/           three.js scene
│   │   └── src/
│   │       ├── pose/       HeadTracker (smoothing, recenter, stats), MockHead
│   │       ├── scene/      Panorama, Ambient (clouds, birds, motes)
│   │       ├── screens/    ScreenSource (test pattern / display capture), VirtualScreen, ScreenManager
│   │       ├── interaction/ mouse + keyboard + hand pointer (HandTracker, OneEuro)
│   │       └── ui/         ControlCenter, Cursor3D, Hud (stereo), Overlay, canvasKit
│   ├── shared/types.ts     PoseSample / HelperStatus / preload API
│   ├── assets/             drop panorama.jpg here; public/mediapipe/ = hand-tracking runtime (generated)
│   ├── scripts/            dev / build / package scripts (no extra deps)
│   └── release/            packaged .app (generated, git-ignored)
└── include/, aarch64/      Viture SDK 2.4.1 (see "SDK location")
```

## Prerequisites

- An Apple Silicon Mac running macOS 13 or later.
- Xcode Command Line Tools recent enough to build arm64 (Apple clang 15 or later; tested with clang 21 / macOS SDK 26.5). Very old tools, such as clang 12 with the 10.15 SDK, can't link arm64 binaries. If yours are that old, update them with `softwareupdate --list`.
- Node.js ≥ 22.12 (Electron 44 requires it).
- The Viture glasses SDK 2.4.1 (headers + `libglasses.dylib` + `libcarina_vio.dylib`).

### SDK location

The Makefile looks for the SDK in `vendor/viture-sdk/` first (`include/` and `aarch64/` inside it). If that isn't there, it uses the repository root, which is where the SDK is unpacked right now. You can override this:

```bash
make -C helper SDK_DIR=/path/to/sdk
```

## Install

```bash
npm install          # installs app/ deps and downloads the Electron binary
```

## Build the helper

```bash
make -C helper       # → helper/build/viture-pose-helper (+ copies of the two SDK dylibs)
```

The two SDK dylibs are copied next to the binary. `libglasses` loads `libcarina_vio.dylib` from **its own directory** using `dladdr` + `dlopen`, so both files must stay together.

**Code signature fix.** SDK 2.4.1 ships `libglasses.dylib` with an **invalid** ad-hoc signature (`codesign -v` reports "code or signature have been modified"). The copy inside VITURE's own `glasses-demo.app` is byte-identical and broken the same way. On Apple Silicon the kernel SIGKILLs any process that loads it: the helper dies with exit status 137 and prints nothing. The Makefile therefore ad-hoc re-signs **the copy in `helper/build/` only** (`codesign --force --sign -`) and leaves the SDK files untouched. A distributed build would need the dylibs properly signed, by you or by VITURE.

Useful helper commands:

```bash
helper/build/viture-pose-helper --list
```

```bash
helper/build/viture-pose-helper --dof 3 --max-hz 250
```

`--list` shows the connected VITURE devices. The second command streams JSON to stdout, and you stop it with Ctrl-C.

Helper flags: `--dof 3|6` (default 3), `--max-hz N` (default 250, 0 = no cap), `--predict-ms F` (passed through to `get_gl_pose_carina`), `--log-level 0-3`, `--pid 0xNNNN`, `--no-imu-wake`.

### Helper output protocol (stdout, one JSON object per line)

```json
{"t": 1761494400123.456, "q": [x, y, z, w]}
{"t": 1761494400123.456, "q": [x, y, z, w], "p": [x, y, z]}
{"status": "searching" | "tracking" | "lost" | "error", "t": ..., ...}
```

- `"p"` is only included in 6DoF mode (`--dof 6`).
- `t` is the wall-clock time (epoch ms, `CLOCK_REALTIME`) when the pose was read from the SDK.
- Coordinates are the SDK's OpenGL frame (x right, y up, z backward), which is the same frame three.js uses.
- Everything else goes to stderr. The helper also points fd 1 at stderr, so any stray SDK `printf` can't corrupt the stream.
- On SIGTERM/SIGINT the helper calls `stop → shutdown → destroy`, then exits 0.

## Run

### Mock mode (no glasses)

```bash
npm run dev          # mock automatically if helper/build/viture-pose-helper doesn't exist
npm run dev:mock     # force mock (MOCK_HEAD=1) even if the helper is built
```

In mock mode, dragging empty space turns your head, and so do the arrow keys when no screen is selected. Poses are generated at 120 Hz and have the same `PoseSample` shape the helper produces.

### Real mode (glasses)

1. `make -C helper`
2. Plug in the Luma Ultra.
3. Run `npm run dev`.

The status badge (top right) shows `Waiting for glasses…` and then `Luma Ultra · 3DoF`. If the helper crashes, the badge shows the countdown to the next restart. Restarts back off 1 → 2 → 4 … 30 s, and the backoff resets after a run lasting 30 s or more. If you unplug the glasses, the helper tears down the SDK and waits for them to come back.

Use **F** for fullscreen and **M** to move the window to the next display (the glasses show up as an external display).

### Double-clickable app

```bash
npm run package
```

This builds everything and makes sure `app/release/Viture Open Walker.app` exists.

The bundle is a **linked launcher**: Electron's runtime plus a constant `loader.cjs` that runs the code from this repository (`app/dist*`, `helper/build`, `app/assets`).

Why linked: an ad-hoc signed app's code identity *is* its cdhash (`codesign -d -r-` shows `designated => cdhash H"…"`). macOS stores Screen Recording and Accessibility grants against that identity. A self-contained bundle gets a new cdhash on every rebuild, so System Settings keeps showing a stale "granted" entry under the same name while the new build is denied and keeps asking.

With the linked bundle, rebuilding never touches the signed bundle, so the identity and the grants survive. Verified: two builds with a code change in between both have cdhash `d3542711…`.

The script prints the cdhash and says whether permissions need re-granting. That's only needed when the loader or the Electron version changes. Keep the repository where it is. The bundle is for this Mac only.

**Startup.** The app always starts as a normal window, placed on the glasses if they're connected. A setup card is shown when the glasses are connected or a permission is missing; it can also be opened with **P**. The card has live permission status, Grant buttons that trigger the system prompts, Restart, and "Enter glasses view".

"Enter glasses view" uses native macOS fullscreen on the glasses (`setFullScreen`), as the first version did. The opt-in `prefs.autoEnter` skips the card.

The main-display switch and window sweep run only while fullscreen on the glasses *and* Screen Recording is granted. Otherwise the glasses would show blank screens, and system prompts would open behind the app. **⌃⌥Q** (global) or **F** leaves fullscreen.

**Log file.** Main-process and helper output is mirrored to `~/Library/Logs/viture-open-walker/main.log`. The packaged app has no terminal, so read this when something goes wrong.

`npm run build && npm start` still runs the built bundles unpackaged.

### All displays, main display, and mouse control

**Virtual displays.** While the app runs, `viture-display-helper` creates **VOW Virtual 1** and **VOW Virtual 2** (1920×1080@60). They disappear when the app quits, even if it crashes.

**Display bandwidth (base Apple Silicon).** Measured on an M2 MacBook Air with the glasses at 1920×1200@120:
- Virtual displays share the display engine's pixel budget with real displays. When it is exceeded, macOS silently turns an **external display off**, which blacked out the glasses.
- Two 1080p virtual displays are marginal at 60 Hz and stable at 50 Hz.
- In the glasses' SBS 3D mode (3840×1200), not even one 1280×720@30 virtual display fits.

So:
- virtual displays default to **50 Hz** (`virtualDisplayHz`);
- after creating them, the helper checks every physical display is still online and otherwise steps down through fallback tiers (30 Hz → 1600×900 → 1280×720 → one display);
- switching the glasses to 3D first `release`s the virtual displays, and switching back `create`s them again.

**Mirroring.** Every display except the one hosting the app window is captured via Electron `desktopCapturer` (ScreenCaptureKit) into its own screen. Layouts are saved per display key (`vd1`, `vd2`, `display-builtin`, `display-<CGDirectDisplayID>`). Screens without a saved spot go into the nearest free angular slot.

Mirroring needs **Screen Recording** permission: grant it to "Viture Open Walker" for the packaged app, or to "Electron" in dev, then restart the app. Press **P** in the app to open that settings page.

**Immersive mode** (only while the window is fullscreen on the VITURE display):
- The window uses Space-less "simple" fullscreen at screen-saver level.
- The helper makes VOW Virtual 1 the main display (`CGConfigureDisplayOrigin`). Physical displays keep their relative arrangement, moved as a block centred *below* the row of virtual displays. A virtual display is then leftmost and rightmost, so a left/right Dock (which lives on the leftmost/rightmost display) never covers the glasses.
- **Order matters.** The display switch happens while the window is still normal; only then does it go native fullscreen on the glasses. Leaving is the reverse: exit fullscreen first, then restore. Rearranging displays under a fullscreen window moved its fullscreen Space onto the new main (virtual) display, leaving the app running where the user couldn't see or reach it. That was verified, then fixed. The 3D toggle uses the same pattern: it steps out of fullscreen, reconfigures, and steps back in.
- The original arrangement is written to `<userData>/display-arrangement.json` first. It is restored on quit or SIGTERM, or on the next start after a crash.
- Every second, the helper moves other apps' normal windows whose centre is on the glasses to the main display. This uses the Accessibility API, so **Accessibility** permission is required.
- None of this happens when the app runs on a normal monitor (dev), so your windows are never touched there.

**Mouse control:**
- **Clicking** a live display screen warps the real cursor to the matching point on that display (`CGWarpMouseCursorPosition`). From there, clicks and typing go natively to the apps on it.
- The screen's frame turns green while the cursor is there.
- **⌃⌥⎋** (global shortcut) brings the cursor back to the app window.
- Dragging past 4 px, or ⌥-dragging, moves the screen instead of entering it. The title bar always moves it.

`CGVirtualDisplay` is **private, undocumented Apple API**, the same one Spacewalker-style apps use. The helper declares only the members it uses, with the type encodings read from the Objective-C runtime on macOS 26.6. A future macOS could change or remove it. In that case the screens show "Virtual display error" and the rest of the app keeps working.

### Configuration

Environment variables take priority over `~/Library/Application Support/viture-open-walker/settings.json` (keys shown in parentheses):

| Env | settings.json | Default | Meaning |
|---|---|---|---|
| `MOCK_HEAD=1` | — | off | force mock head |
| `VITURE_HELPER` | `helperPath` | `helper/build/viture-pose-helper` | helper binary |
| `VITURE_DOF` | `dof` | 3 | 3 or 6 |
| `VITURE_MAX_HZ` | `maxHz` | 250 | helper output cap |
| `VITURE_PREDICT_MS` | `predictMs` | 0 | pose prediction |
| `PANORAMA_PATH` | `panoramaPath` | `app/assets/panorama.{jpg,jpeg,png,webp}` | panorama image |
| `FOV_Y` | `fovY` | 29 on the VITURE display, 50 elsewhere | vertical FOV in degrees (switches automatically when the window changes display) |
| `VOW_VIRTUAL_DISPLAYS` | `virtualDisplays` | 2 | number of virtual displays (0 = off, max 4) |
| — | `virtualDisplayWidth` / `virtualDisplayHeight` | 1920 / 1080 | virtual display resolution |
| — | `virtualDisplayHiDPI` | false | Retina (2×) virtual displays |
| — | `fullscreenOnGlasses` | true | open fullscreen on the VITURE display |

The screen layout is saved to `~/Library/Application Support/viture-open-walker/layout.json`. Opening the renderer in a plain browser uses `localStorage` instead.

## Adding a panorama

You can do any of these:

- save the image as `app/assets/panorama.jpg` (or `.png` / `.webp`), then re-run `npm run package` for the app;
- in dev only, put a `bg.jpg` in the repository root;
- set `PANORAMA_PATH=/abs/path/to/image.jpg`.

Two kinds of image work:
- **2:1 equirectangular** images wrap the full sphere.
- **Any other aspect**, such as a wide landscape like `bg.JPG` (16000×5000), is placed in front of you. It is mirror-tiled to 360° so both joins match, and the sky and ground are filled with colours sampled from its top and bottom edges, with a feathered blend.

Either way, the image is downscaled to 8192 px wide, and its centre faces forward. If no image is found, the app draws a procedural gradient + 15° grid with compass labels instead.

## Controls

| Input | Action |
|---|---|
| **C** / **Space** | control center (anchor mode, recenter, 3D, 6DoF, scenery, grid, cinema, see-through, hands, debug) |
| **T** | Cinema on/off (selected screen, or the one you look at) |
| **V** | See-through: camera → outlines only → off |
| click a screen | put the real mouse on that display, at that point |
| **3** | 3D (SBS) on/off: glasses 3D mode when tracking, otherwise a side-by-side preview |
| **⌃⌥⎋** | bring the mouse back (global) |
| drag the pill / screen | move it around you (yaw/pitch); ⌥-drag never enters a display |
| drag a bottom-corner arc | resize (keeps aspect unless free-resize is on); shows the diagonal in inches |
| wheel over screen | scale · **⌥ wheel**: distance (push back / pull in) |
| drag empty space | look around (mock mode, or while the glasses aren't tracking) |
| **Tab** / **⇧Tab** | cycle selection |
| **G** | select the screen in the centre of view (useful with the glasses) |
| **← ↑ ↓ →** | move selected screen 2° (⇧ = 10°) |
| **+ / −** | scale selected |
| **[ ]** / **; '** | width / height |
| **, .** | distance |
| **A** | toggle aspect lock ↔ free resize (per screen) |
| **R** | recenter heading (yaw only; pitch/roll stay gravity-aligned) |
| **9 / 0** | less / more smoothing |
| **D** | debug overlay (FPS, pose rate, pose latency, helper status) |
| **H** | help · **Esc** deselect · **⇧⌫** reset layout |
| **F** / **M** / **P** | fullscreen / move window to next display / setup & permissions screen |
| **⌃⌥Q** | leave the glasses view (global escape hatch) |
| hand (Hands on) | point to move the dot · pinch thumb + index = click · pinch and move = drag · pinch a screen and push the hand away / pull it back = move it farther / nearer in space |

### Depth: push / pull, Cinema, grid, sky

- **Push / pull** (**⌥ wheel**, **, .**, or hand pinch + push) moves a screen through space along your line of sight. Its real size stays the same, so it looks smaller as it goes back, like an object in a room, and its footprint slides along the grid. Distance limit: 0.6–60 m.
- A screen's chrome (name pill, corner arcs, rim) keeps a constant apparent size so it stays readable, but it never grows past a fraction of the screen itself. A far screen therefore looks like a small far object, not a small panel with a huge frame.
- To get **far and huge**, a screen has to be both farther and bigger (size limit 40 m). **Cinema** does that in one step:
- **Cinema** (**T** or the control-center tile) flies the selected screen, or the one you look at, to 30 m in front of you. It sizes it to fill about 85 % of the view's width (or 75 % of its height) and stands it just above the floor, so you look up at it a little. The scenery dims to about 40 %. **T** again flies it back to where it was.
- **What sells the distance:** in 3D (SBS) mode, the stereo disparity at 30 m is almost zero, and your eyes read that directly. In 2D, the cues are the grid floor and each screen's footprint on it, birds and motes passing in front of it, and parallax in 6DoF.
- **Sky** (control-center tile) turns the panorama off (black background), which leaves just the grid and the screens: the clearest way to judge the depth effect. It's saved as `skybox: 'panorama' | 'off'` in `prefs.json`, ready to become a skybox switcher.

### See-through

**V** or the **See-through** tile shows the room through the glasses' front RGB camera instead of the panorama, scenery and grid; the screens float over it. Press again for **outlines only**, and once more to turn it off. The camera is a plain UVC device, so the renderer opens it with `getUserMedia` (the same way Hands does, and Hands can use it at the same time). No camera helper is needed, and the pose helper keeps running.

- The image hangs 100 m away, sized from the camera's horizontal FOV (`GLASSES_CAMERA_HFOV`, 75°), so it lines up roughly 1:1 with the real world.
- Each frame is placed at the head orientation from when it was **captured** (the frame's `captureTime`, else 90 ms ago), taken from a 1 s pose history. When you turn, the room stays still instead of swimming along with your head; only its edges lag.
- The camera is captured at its full 1920×1080. In camera style, a light unsharp mask on brightness makes it a bit crisper.
- **Outlines only** runs one GPU pass on the camera image (17 texture reads per pixel). It takes a Sobel gradient of brightness at two scales, each divided by the local mean so dark corners count as much as bright ones. The fine scale places a thin line, and the coarse scale has to agree, which drops fine texture (carpet, grain, noise) and keeps the outlines of things. The lines are the grid's cyan on black, and black is transparent on the glasses. `EDGE_LO` / `EDGE_HI` in `scene/Passthrough.ts` set how much detail survives.
- The Luma lenses are optical see-through, so the camera image is added on top of the real view. Set the lens tint to its darkest for a clean picture.
- Without the glasses' camera it falls back to the Mac's (useful only for testing), and says so.
- The camera's mounting angle is `PITCH_OFFSET_DEG` in `scene/Passthrough.ts`. Tune it if the image sits above or below the real world.

### Grid floor

A glowing cyan wireframe floor 1.5 m below eye level. It runs to the horizon (in the style of The Thirteenth Floor / Tron), with 2 m and 10 m lines, a scan wave sweeping outward every 6 s, and a glow where it dissolves into the horizon. Toggle it with **Grid** in the control center (saved in `prefs.json`). It fades out under your feet, and its lines fade before they get small enough to shimmer. The floor is fixed in the world, so it shows parallax in 6DoF. Every screen casts a glowing **footprint** on the floor directly below it (fainter the higher it floats), so you can see where in the room it stands.

### Hand pointer (Hands)

Turn on **Hands** in the control center (the choice is saved in `prefs.json`). One hand is tracked by the camera chosen with the **Hand Cam** tile: **Mac** (the default, and in practice the more reliable of the two) or **Glasses** (the glasses' front RGB camera; falls back to the Mac's if it isn't connected). The Hands tile shows which camera is in use: *Mac cam* / *Glasses cam*.

- **Glasses camera.** The Luma Pro / Cyber / Ultra RGB camera is a plain UVC camera (USB `0c45:636b`; macOS calls it "USB Camera"), so the renderer opens it with `getUserMedia`. No SDK call is needed. It looks where you look, so the ray goes from your eyes through your hand, as on the headset. Its image is not mirrored (the image's left is your left), unlike the Mac camera's. The mapping assumes the camera's horizontal FOV is 75°, which is not documented; tune `GLASSES_CAMERA_HFOV` in `HandTracker.ts` if the dot runs ahead of or lags behind your hand. Not yet verified with a hand in front of the glasses.
- The SDK also exposes the two grayscale **tracking cameras** (`XRCameraCallback` in `viture_device_carina.h`, stereo, about 25 Hz). Stereo would give true hand depth, but those frames only reach the pose helper. Using them would mean streaming frames from the helper to the renderer, and they are greyscale fisheye images that MediaPipe isn't trained on. Not done.


- **Push / pull:** while you pinch a screen, move your hand away from you to push the screen farther back in space, or toward you to bring it in (its real size stays the same). Depth comes from the hand's apparent size in the camera image (`PUSH_GAIN` / `PUSH_DEADZONE` in `Interaction.ts`).
- **Hand outline:** the whole tracked hand is drawn as a glowing cyan outline with a faint fill (white while pinching), on a plane at hand distance (0.6 m) in front of everything. The dot stays the precise target. With the Mac camera the outline is shrunk around the dot to about hand size (`MAC_OUTLINE_SCALE`), because that mapping magnifies the middle of the frame. With the glasses camera it is drawn 1:1 (`ui/HandOutline.ts`).
- **Point:** the 3D dot follows your index finger. The ray goes from the camera through the index **knuckle**, not the fingertip, so the dot doesn't jump when you pinch. A One-Euro filter keeps it steady when the hand is slow and responsive when it's fast. The middle ~60 % × 50 % of the camera image covers the whole view, so you don't have to reach the edge of the frame.
- **Pinch** thumb and index = mouse button. Pinch and release on a pill or screen = click. Pinch and move = drag (move a screen, resize from a corner arc, use the control center). Hand and mouse use the same code path, so a pinch does whatever a click does. That includes putting the real mouse on a display.
- Losing the hand mid-drag drops the drag without clicking.

How it works: MediaPipe Hands (`@mediapipe/tasks-vision`, pinned to 1.1.0, `HandLandmarker`, GPU delegate with CPU fallback) runs in the renderer. Nothing is fetched at runtime. `npm install` runs `app/scripts/mediapipe-assets.mjs`, which copies the WASM runtime from `node_modules` into `app/assets/public/mediapipe/` and downloads the model once (`hand_landmarker.task`, float16 v1, SHA-256 checked). Vite serves that folder and copies it into `dist/`. Run the script by hand if the download failed. The first time you turn Hands on, macOS asks for camera access (in dev the prompt names Electron).

Limits:
- One hand only. With the Mac camera, keep your hand in front of the laptop, roughly 30–60 cm away, in decent light. It can't see your hand when you face away from the laptop, and the pointer works like a touchpad in the air rather than following where your finger points. With the glasses camera, keep your hand in front of you, in view.
- The pointer is a 2D mapping of where your hand is in the image, not a true 3D pointing direction. Push / pull depth is estimated from hand size, so it is relative and noisy, not metric.
- No scrolling (use the wheel), no ⌥-modifier, and no gestures beyond pinch. Pinch thresholds are fixed (`PINCH_ON` / `PINCH_OFF` in `renderer/src/interaction/HandTracker.ts`).
- While the hand is in view it costs a few ms of GPU per camera frame (30 fps). When Hands is off, the camera is fully released.

## Camera viewer (what the glasses see)

A standalone web page, separate from the app, that shows all three cameras of a Luma Ultra live:

- the **left and right tracking cameras**: grayscale, used by the glasses for 6DoF (VIO). They come from the Carina camera callback in the SDK.
- the **RGB camera**: 1920×1080 MJPEG, the one Hands can use. It comes from `xr_camera_provider` in the SDK.

```bash
make -C helper           # also builds helper/build/viture-camera-helper
npm run cameras          # → http://localhost:8787
```

Quit Viture Open Walker first, because both open the glasses through the SDK. The first time the RGB camera starts, macOS asks for camera access for your terminal. `npm run cameras -- --fake` shows synthetic frames, so you can try the page without glasses. `-- --no-rgb` streams only the tracking cameras, and `-- --port N` changes the port.

On the page you can:

- view the stereo pair as **原图** (raw), **红蓝 3D** (a red/cyan anaglyph) or **左右差异** (|L − R|, bright where the two eyes disagree, which means near objects).
- use **自动增强**, which stretches the gray levels so a dim room is visible.
- choose the **第 1 / 2 对** stereo pair. The SDK hands over two pairs per callback.
- set the tracking cameras to auto or manual **exposure** (0.01–8 ms, gain 0–15).
- pause, take a PNG snapshot of each camera, and enlarge a single camera.

When you hover over either eye, the page draws a matching horizontal line across both images, so you can compare disparity. If the RGB camera won't open through the SDK, the page offers to open it as a normal webcam in the browser instead.

`-- --log-level 3` turns on the SDK's full logging in the terminal. The VIO library may print the glasses' factory camera calibration there.

`tools/camera-viewer/server.mjs` is a dependency-free Node server. It relays the helper's packets to the page over one streaming HTTP response. The packet format is described at the top of `helper/src/camera_helper.m`.

## Live 3D reconstruction

`tools/recon/` builds a rough 3D model of what's in front of you, live, from the two tracking cameras and the glasses' 6DoF pose:

1. Each stereo pair is rectified and matched (OpenCV semi-global matching) into a depth map.
2. The depth map is moved into the world with the pose the SDK reported for that frame.
3. The depth is fused twice. The points are averaged into a 2 cm voxel map, which the three.js page draws as a point cloud. Distances to the surface are averaged into a truncated signed distance field (TSDF), whose zero crossing becomes a shaded mesh (表面). Both are drawn next to the glasses' path.

**One click:** quit Viture Open Walker, then double-click `Scan.command` in Finder, or run `npm run scan`. The launcher (`tools/scan.mjs`):

1. builds the helper if needed;
2. creates `tools/recon/.venv` with numpy and OpenCV 4 the first time (it needs `python3`, which macOS offers to install);
3. starts the camera stream (port 8787) and the reconstruction page (port 8788), and opens the page in your browser.

Ctrl-C in its terminal stops everything. Arguments after `--` go to `recon.py`; `python3 tools/recon/recon.py --help` lists them.

**First run: calibration.** The SDK doesn't publish the camera calibration, so the page calibrates the cameras first. It only needs doing once per pair of glasses:

1. Choose how the board's real size is found, then click 开始. The screen shows a checkerboard full screen. There are three ways to get the size:
   - **按屏幕尺寸 (default):** `tools/recon/screens.py` reads the Mac display's physical size and point size from CoreGraphics. The page works out the square size from that, the browser zoom, and the board's on-screen size. For example, a 13.6" MacBook Air M2 is 290.3 mm across 1470 points at the default scaling, so an 89 px square is 17.6 mm. Show the board on the Mac's own screen.
   - **尺子量:** type in a square's measured side, now or later from the status card.
   - **定位推算:** solved from the SDK's metric head poses. Move your head closer and further, not only turn it.

   With the first two, the head-pose estimate is still worked out as a cross-check. If the two differ by more than 15%, calibration stops and says so; the usual cause is browser zoom or the board being on the wrong screen. The 更改 button switches method without losing the captured views.
2. Look at the checkerboard from many angles: tilt your head, move closer and further, and put the board in every part of the view. A view is captured when both eyes see the board and you hold still for about half a second; the border flashes green.
3. After 25 views it solves on its own, or press 现在计算 once you have 12 or more. Bring the board into the edges and corners of the view as well: depth is only measured inside the angle the board reached.

The calibration solves for:

- each eye's fisheye intrinsics;
- the stereo extrinsics;
- the hand-eye transform from the left camera to the tracked pose;
- the board's size, if you chose 定位推算.

The result goes to `tools/recon/calib.json`. If the error is too large, the page asks for more views. Later runs go straight to reconstruction, and the 重新标定 button calibrates again.

**Scanning.** Move slowly. Frames are skipped while your head turns faster than 60°/s or while the SDK's pose is unstable. On the page you can:

- pause fusion, or clear the map;
- save the map as a PLY file to `tools/recon/scans/`, which opens in MeshLab or Blender;
- choose how many frames must see a voxel before it shows;
- switch between the surface (default) and the point cloud;
- scan one object: 框住眼前的物体 puts a box (20–150 cm) around what the middle of the view sees. Only that box is mapped from then on, with 5 mm voxels instead of 2 cm, and the view orbits it. Walk slowly around the object and look at it from above too;
- colour the points or surface by gray value or by height.

Saving writes `scan-….ply` (points) and `scan-…-mesh.ply` (the surface, with faces).

**The surface.** `TSDFMap` in `core.py` is plain NumPy, with no Open3D: Open3D's macOS wheels need Homebrew libraries or a long list of Python packages. It keeps 8×8×8-voxel blocks only near surfaces that have been seen, in a hash map. Each frame updates the blocks around its depth points. A voxel in front of the measured depth moves towards +1 (free space), one up to the truncation distance behind it towards the negative distance, and each voxel's value is a running average. Averaging distances, unlike points, cancels stereo noise along the line of sight. The mesh comes from surface nets: one vertex per voxel cell the surface crosses, at the mean of its edge crossings, and one quad per crossed edge. It is extracted when the page asks, about once a second. Costs on an M2: about 20 ms per frame for the room at 2 cm, 10–30 ms for an object box at 5 mm. `--surface-voxel 0.01` gives a finer room, but at about 70 ms per frame. `--object-voxel` sets the box's voxel size.

**Photo models (拍照建模).** The live map comes from the low-resolution gray tracking cameras. For a model that looks like the real thing, the page can also record the 1920×1080 RGB camera and hand the photos to Apple's Object Capture (RealityKit's `PhotogrammetrySession`), which runs on the Mac:

1. Put the object on a surface with some pattern (a plain white table gives the photos nothing to align on), click **开始录制**, and walk slowly around it: once at eye level, once a bit higher, then look down at it from above. Keep the whole object in view. The page shows the camera and counts the photos; 40–150 is a good number.
2. A photo is taken each time the head has moved 4 cm or turned 6° since the last one (every 0.6 s if there is no 6DoF pose). Of the frames in the next 0.35 s, the sharpest is kept; if they are all blurred compared with the recent ones, it waits for the next. The camera's own JPEGs are saved without re-encoding, to `tools/recon/captures/capture-…/images/`, with the head pose of each in `frames.json`. Recording turns the RGB camera on (`rgb 1` to the camera helper) and off again. The first time, macOS asks for camera access for your terminal. If the SDK can't open the camera, the page offers to open it as a webcam in the browser and sends its frames instead.
3. Pick the recording and a detail level, then **生成模型**. `tools/capture/build/object-capture` (built by `npm run scan`, or on first use) writes `model/model.usdz` and `model/obj/` (OBJ, MTL and color, normal and AO textures). **在这里查看** shows the model in the page, **用「预览」打开** opens the USDZ in Preview, and **打开文件夹** opens the capture in Finder.

On an M2 with 8 GB, 66 synthetic 1440×1080 photos took 29 s at "reduced" and 32 took about 3 min at "medium". The live map slows to a crawl meanwhile, because Object Capture takes the whole machine. If the photos don't fit together (too few, too little overlap, no texture), it fails with `processError`, and the page explains what to try. The tool also works on its own, on any folder of photos:

```
tools/capture/build/object-capture <images-dir> <out-dir> [--detail preview|reduced|medium|full|raw] [--unordered] [--high-sensitivity] [--no-masking]
```

It prints its progress as one JSON object per line. Object Capture finds the pose of each photo itself, so the head poses in `frames.json` aren't used yet; they are there for later (COLMAP / Gaussian splatting).

The image at the top has three views:

- **深度:** the rectified left eye and its disparity map.
- **校正检查:** both rectified eyes with rows marked. A point must sit on the same row in both images; if it doesn't, calibration is off.
- **原始画面:** the raw fisheye images, with the region used for matching outlined.

Below the image, the page lists the calibration's quality: reprojection error, hand-eye spread, how far out the board was seen, and the matching window size.

**Rectification on the glasses.** The glasses' eyes turn outwards, so a fixed crop of the averaged view can reach beyond where the lens model was calibrated. A fisheye model can diverge there, which leaves the rectified image mostly black and the depth meaningless. Rectification therefore covers only directions both eyes see inside the angle the board reached during calibration (stored in `calib.json` as `theta_max`), where the distortion model is still monotonic, and inside both images. Calibrations from before this was recorded still load, but the page suggests calibrating again.

What limits accuracy now is the board calibration of the rotation between the eyes. On a simulated outward-turned rig it came out within 0.2–0.5°, mostly around the vertical axis. That shifts every disparity a little, which left-right image matching alone can't detect.

**What to expect.** These are tested numbers from a simulated 9 cm fisheye rig:

- Calibration recovered the baseline and the board size to about 0.1%, and the camera-to-pose transform to about 1 mm.
- Depth is best from 0.3 to 2 m. Single-frame median error was about 1–2 cm, and the fused map's median error was about 1.2 cm.

Blank walls, glass and dark areas give no depth. Stereo matching uses only the middle of the fisheye view (`--fov-scale 0.75`) with a left-right consistency check, because the outer edges are where calibration is weakest.

The pose sent with a frame is the newest one when the frame arrives, not the exact pose at exposure, so fast motion smears the map.

## Architecture notes

- **Latency path.** The SDK has no blocking "wait for pose" call. Instead, the helper registers the Carina IMU callback and uses it only as a wake-up signal (a condition variable), then reads `get_gl_pose_carina` and writes the line. If no IMU callback arrives, there's a 4 ms timeout fallback. The output is capped at `--max-hz`. Exact repeat poses are dropped.
- **Latency measurement.** "pose latency" in the overlay is `render time − t` for the latest sample, averaged and as p95 over 250 ms windows. It measures helper read → IPC → frame. It does **not** include the time from sensor to SDK, which the SDK doesn't expose for `get_gl_pose_carina`, or display scan-out. "ipc transit" is helper read → renderer receive.
- **Smoothing** is a frame-rate-independent slerp. `smoothing` is the fraction of the remaining error kept every 1/60 s. The default of 0.2 is a time constant of about 10 ms, which adds that much perceived lag on top of the measured latency; setting it to 0 turns it off.
- **Security.** `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, plus a CSP. Navigation and new windows are blocked. The preload exposes only `window.vow` (see `shared/types.ts`).
- **Screen sources.** `renderer/src/screens/ScreenSource.ts` defines `ScreenSource` (texture, pixel size, start/update/stop/dispose). There are three implementations:
  - `TestPatternSource` draws a placeholder.
  - `DisplayCaptureSource` streams a virtual display through `getUserMedia` (`chromeMediaSource: 'desktop'`) into a `VideoTexture`, and shows a status card until the stream runs.
  - `WindowCaptureSource` is still a placeholder for capturing single windows.
- **Media permission.** Media requests are only granted to the app's own page (the dev-server URL or `file://`).
- **Anchor modes.** Screens live in a `workspace` group:
  - Spatial Anchor: identity transform.
  - Head-Locked: copies the camera pose.
  - Smooth Follow: catches up in yaw once you turn more than 25°.
  Screen layouts are workspace-relative, so moving screens works in every mode.
- **Stereo (3D).** The glasses' 3D mode is set through the pose helper's `display3d` command, which calls `xr_device_provider_set_display_mode` with 0x42 / 0x45 (3840×1200 @ 60 / 90 Hz, same height and refresh as the current mode).
  - `switch_dimension` is documented as Gen1/Gen2-only and 1080p, so it is not used.
  - The original mode is restored when the helper exits.
  - The renderer draws side-by-side with three's `StereoCamera`: IPD 63 mm (`prefs.ipd`), convergence 4 m.
  - HTML overlays only reach one eye in SBS, so status, toast and debug go to a head-locked 3D HUD instead.
- **6DoF.** The control center restarts the pose helper with `--dof 6` (persisted in `settings.json`). The panorama follows the head position, so it stays at infinity; screens, birds and motes show parallax.
- **Scenery.** Clouds at 200–320 m, birds on breathing loops at 18–55 m, and motes at 3–10 m (behind the screens, so they never cover text).

## Measured with a Luma Ultra (MacBook Air M2, 3DoF)

| | |
|---|---|
| IMU callback rate | ~1000 Hz |
| Fused pose update rate (new values from `get_gl_pose_carina`) | ~200 Hz (5.0 ms median interval, p95 5.1 ms) |
| Poses reaching the renderer | ~201–204 Hz |
| Pose latency (helper read → rendered frame) | 2.3–2.6 ms avg, 4.3–4.8 ms p95 |
| IPC transit (helper → renderer) | ~0.2–0.5 ms |
| Time to `pose_status` stable after `start()` | ~1 s typical, up to ~5 s seen |
| Yaw drift while stationary | < 0.5° over 6.5 s |

Behaviour observed on the real device:

- At startup the SDK zeroes yaw, so the heading at launch becomes forward. Pitch and roll are absolute against gravity.
- While `pose_status` is unstable, the SDK returns an exact identity pose as a placeholder. The helper drops those samples so the camera doesn't snap to level and then jump.
- The SDK `printf`s its own `[CARINA]…` log lines to **stdout**. The helper's fd 1 → stderr redirect keeps them out of the JSON stream.
- At shutdown the SDK logs `get exp flag status: Host Command Invalid` / `do sync data transfer :-7`. `stop`/`shutdown` still succeed and the process exits 0.
- The latency figure compares the helper's `CLOCK_REALTIME` with Chromium's `performance.timeOrigin + now()`. Those two clocks agree to within ~0.3 ms, so short transits can display as 0.0 ms.

## Known limitations

- Tested on one machine with one pair of glasses, in 3DoF only. 6DoF (`VITURE_DOF=6`), unplug/replug recovery, and very long sessions have not been exercised on hardware.
- Only the Luma Ultra (Carina) is supported. Gen1/Gen2/Beast devices are detected but rejected.
- 3DoF is the default. 6DoF works through `VITURE_DOF=6`, but screens are anchored at the tracking origin, and the helper doesn't use the SDK's `reset_origin`.
- Recenter happens in software and only affects yaw. The `R` key doesn't call `xr_device_provider_reset_origin_carina`.
- Default FOV (29° vertical) is an **assumption** based on a ~52° diagonal FOV and a 16:10 panel. Adjust `FOV_Y` once you try it in the glasses.
- Mono rendering only (no SBS stereo / 3D mode).
- The `.app` is for personal use on this Mac. Distributing it would mean redistributing `libglasses.dylib` + `libcarina_vio.dylib` (a licensing question for VITURE), plus proper signing and notarization.
- Virtual displays rely on private `CGVirtualDisplay` API (see above).
- **Verified with the glasses:** fullscreen on the glasses with live virtual displays, the main-display switch (switched once, restored at quit), the 3D mode switch via `set_display_mode` (0x44 → 0x42 → back), and the bandwidth fallback.
- **Not yet verified with the glasses:** 6DoF, moving windows off the glasses in practice, and stereo comfort (IPD / convergence).

  Verified without glasses: live capture of virtual and physical displays, the main-display switch and exact restore (standalone helper), click-to-enter warp accuracy, pill move, arc resize, control center, SBS rendering.
- The first click on a screen only moves the cursor there. Synthesizing the click too would need Accessibility permission, so it isn't done.
- While the cursor is on a virtual display, keyboard focus is with the app there, so the app's own shortcuts (R, D…) don't work until ⌃⌥⎋.
- Capture adds some latency (typically a frame or two) to what you see on the virtual-display screens. Head tracking is not affected.
- **No extra entitlements or sandbox settings were needed or added.** The SDK uses IOKit for USB, and a plain unsandboxed binary can access it. If you ever enable the App Sandbox, you'd need `com.apple.security.device.usb`, and that hasn't been tested. The SDK also links AVFoundation (for the VIO cameras). A packaged app might trigger a camera-permission prompt in 6DoF mode; this hasn't been tested.
- Electron 44.7.0 is affected by advisory GHSA-jr5w-w6x2-84p9 (eMudhra certificate mitigation), which is fixed in 44.9.3. The app loads no remote content, but bump the version once 44.9.3 has been out for a while.
