import { Euler, MathUtils, Quaternion, PerspectiveCamera, Scene, SRGBColorSpace, StereoCamera, Texture, Vector2, Vector3, WebGLRenderer } from 'three';
import type { DisplaysState, HelperStatus, Prefs } from '../../shared/types';
import { HandTracker, type HandCamera, type HandState } from './interaction/HandTracker';
import { Interaction } from './interaction/Interaction';
import { HeadTracker } from './pose/HeadTracker';
import { MockHead } from './pose/MockHead';
import { Ambient } from './scene/Ambient';
import { FLOOR_Y, Grid } from './scene/Grid';
import { Panorama, PANORAMA_RADIUS } from './scene/Panorama';
import { ScreenManager } from './screens/ScreenManager';
import { anglesFromDirection, LIMITS, type ScreenLayout, type VirtualScreen } from './screens/VirtualScreen';
import { ControlCenter, type ControlAction } from './ui/ControlCenter';
import { Cursor3D } from './ui/Cursor3D';
import { HandOutline } from './ui/HandOutline';
import { Hud } from './ui/Hud';
import { Overlay } from './ui/Overlay';
import { Setup } from './ui/Setup';
import { vow } from './vow';

const DEFAULT_PREFS: Prefs = { anchor: 'spatial', ambient: true, stereoPreview: false, smoothing: 0.2, ipd: 0.063, autoEnter: false, hands: false, handsCamera: 'mac', skybox: 'panorama', grid: true };
/** Stereo convergence distance (m): roughly where the glasses' optics put the virtual image. */
const CONVERGENCE = 4;
/** Smooth Follow: start following past this yaw offset (deg), stop within this one. */
const FOLLOW_START = 25;
const FOLLOW_STOP = 2;
const UP = new Vector3(0, 1, 0);
const HANDS_LINE: Record<HandState, string> = { off: 'Off', starting: 'Starting…', 'no-hand': 'Show a hand', tracking: 'Tracking', error: 'Error' };
/** Cinema: how far the screen goes (m), how much of the view it fills, how dim the scenery gets. */
const CINEMA_DISTANCE = 30;
const CINEMA_FILL_W = 0.85;
const CINEMA_FILL_H = 0.75;
const CINEMA_DIM = 0.15; // linear: about 40 % brightness on screen
const CINEMA_TWEEN_S = 1.4;

async function boot() {
  const config = await vow.getConfig();
  const prefs: Prefs = { ...DEFAULT_PREFS, ...((await vow.loadPrefs()) ?? {}) };
  let savePrefsTimer: number | null = null;
  const savePrefs = () => {
    if (savePrefsTimer !== null) clearTimeout(savePrefsTimer);
    savePrefsTimer = window.setTimeout(() => void vow.savePrefs(prefs), 300);
  };
  // Read by pushControlState(), which status events can call early in boot.
  let handState: HandState = 'off';
  let handCamera: HandCamera = 'mac';
  let cinema: { screen: VirtualScreen; saved: ScreenLayout } | null = null;
  let tween: { screen: VirtualScreen; from: ScreenLayout; to: ScreenLayout; t: number } | null = null;
  let dim = 1;

  const canvas = document.getElementById('scene') as HTMLCanvasElement;
  const renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(window.devicePixelRatio);
  renderer.outputColorSpace = SRGBColorSpace;

  const scene = new Scene();
  const camera = new PerspectiveCamera(config.fovDesktop, 1, 0.05, PANORAMA_RADIUS * 2);
  camera.focus = CONVERGENCE;
  scene.add(camera); // the HUD is parented to the camera
  const stereoCam = new StereoCamera();
  stereoCam.eyeSep = prefs.ipd;

  const panorama = new Panorama();
  scene.add(panorama.mesh);
  panorama.mesh.visible = prefs.skybox !== 'off';
  const ambient = new Ambient();
  ambient.enabled = prefs.ambient;
  scene.add(ambient.group);
  const grid = new Grid();
  grid.enabled = prefs.grid;
  scene.add(grid.mesh, grid.footprints);

  const screens = new ScreenManager();
  await screens.init();
  scene.add(screens.workspace);

  const controlCenter = new ControlCenter();
  scene.add(controlCenter.mesh);
  const cursor = new Cursor3D();
  scene.add(cursor.sprite);
  const hud = new Hud(camera);

  const tracker = new HeadTracker();
  tracker.smoothing = prefs.smoothing;
  const overlay = new Overlay(tracker, screens, camera, hud);

  // ---- head pose: glasses, or mouse-look while the glasses aren't tracking ----
  let status: HelperStatus = await vow.getStatus();
  let dof = config.dof;
  const mock = new MockHead((pose) => tracker.push(pose));
  mock.enabled = config.mock;
  mock.start();
  if (!config.mock) vow.onPose((pose) => tracker.push(pose));

  // ---- stereo: on the glasses when they're in 3D mode, else an optional preview ----
  let stereo = false;
  const stereoOnGlasses = () => status.display?.is3d === true;
  const updateStereo = () => {
    const next = stereoOnGlasses() || prefs.stereoPreview;
    if (next !== stereo) {
      stereo = next;
      overlay.setStereo(stereo);
      resize();
    }
    pushControlState();
  };
  const toggleStereo = () => {
    if (status.state === 'tracking') {
      const on = !stereoOnGlasses();
      vow.setGlasses3d(on);
      prefs.stereoPreview = false;
      overlay.toast(on ? 'Switching glasses to 3D — virtual displays pause meanwhile…' : 'Switching glasses to 2D — virtual displays coming back…');
    } else {
      prefs.stereoPreview = !prefs.stereoPreview;
      overlay.toast(prefs.stereoPreview ? '3D preview (side-by-side) on' : '3D preview off');
    }
    savePrefs();
    updateStereo();
  };

  const onStatus = (s: HelperStatus) => {
    status = s;
    overlay.setStatus(s);
    mock.enabled = config.mock || s.state !== 'tracking';
    if (s.display?.error) overlay.toast(`Glasses display mode: ${s.display.error}`);
    updateStereo();
  };
  vow.onStatus(onStatus);

  // ---- mirrored displays ----
  const onDisplays = (st: DisplaysState) => {
    screens.sync(st);
    overlay.setDisplays(st);
    const aniso = renderer.capabilities.getMaxAnisotropy();
    for (const s of screens.screens) setAnisotropy(s.source.texture, aniso);
  };
  vow.onDisplays(onDisplays);
  onDisplays(await vow.getDisplays());
  vow.onCursorDisplay((id) => {
    screens.setCursorDisplay(id);
    if (id !== null) cursor.hide(); // the real cursor is on that display now
  });

  // ---- control center ----
  function pushControlState() {
    controlCenter.setState({
      anchor: prefs.anchor,
      stereo,
      stereoOnGlasses: stereoOnGlasses(),
      dof,
      ambient: ambient.enabled,
      debug: overlay.debugVisible,
      hands: prefs.hands,
      handsLine: !prefs.hands ? 'Off' : handState === 'tracking' ? (handCamera === 'glasses' ? 'Glasses cam' : 'Mac cam') : HANDS_LINE[handState],
      handsCamera: prefs.handsCamera,
      skybox: prefs.skybox,
      grid: grid.enabled,
      cinema: !!cinema,
      deviceLine: overlay.deviceLine(),
    });
  }
  const toggleControlCenter = () => {
    if (controlCenter.open) controlCenter.hide();
    else {
      pushControlState();
      controlCenter.show(camera);
    }
  };
  let followYaw = 0;
  let following = false;
  const setAnchor = (a: Prefs['anchor']) => {
    prefs.anchor = a;
    followYaw = cameraYaw();
    following = false;
    savePrefs();
    overlay.toast(
      { spatial: 'Spatial Anchor: screens stay in place', smooth: 'Smooth Follow: screens catch up when you turn', head: 'Head-Locked: screens move with your head' }[a],
    );
  };
  const recenter = () => {
    tracker.recenterNow();
    followYaw = 0;
    overlay.toast('Recentered');
  };
  const controlAction = (a: ControlAction) => {
    switch (a.kind) {
      case 'anchor':
        setAnchor(a.anchor);
        break;
      case 'recenter':
        recenter();
        break;
      case 'stereo':
        toggleStereo();
        break;
      case 'dof':
        if (config.mock) {
          overlay.toast('6DoF needs the glasses');
          break;
        }
        dof = dof === 6 ? 3 : 6;
        vow.setDof(dof);
        overlay.toast(dof === 6 ? 'Restarting tracking in 6DoF…' : 'Restarting tracking in 3DoF…');
        break;
      case 'ambient':
        ambient.enabled = !ambient.enabled;
        prefs.ambient = ambient.enabled;
        savePrefs();
        break;
      case 'debug':
        overlay.toggleDebug();
        break;
      case 'hands':
        setHands(!prefs.hands);
        break;
      case 'handsCamera':
        prefs.handsCamera = prefs.handsCamera === 'mac' ? 'glasses' : 'mac';
        savePrefs();
        if (prefs.hands) {
          hands.stop();
          startHands();
        }
        break;
      case 'skybox':
        prefs.skybox = prefs.skybox === 'off' ? 'panorama' : 'off';
        panorama.mesh.visible = prefs.skybox !== 'off';
        savePrefs();
        break;
      case 'grid':
        grid.enabled = !grid.enabled;
        prefs.grid = grid.enabled;
        savePrefs();
        break;
      case 'cinema':
        toggleCinema();
        break;
      case 'close':
        controlCenter.hide();
        return;
    }
    pushControlState();
  };

  const interaction = new Interaction(canvas, camera, screens, mock, cursor, controlCenter, () => stereo, {
    recenter,
    toggleDebug: () => {
      overlay.toggleDebug();
      pushControlState();
    },
    toggleHelp: () => overlay.toggleHelp(),
    adjustSmoothing: (d: number) => {
      tracker.smoothing = MathUtils.clamp(Math.round((tracker.smoothing + d) * 100) / 100, 0, 0.95);
      prefs.smoothing = tracker.smoothing;
      savePrefs();
      overlay.toast(`Smoothing ${tracker.smoothing.toFixed(2)}`);
    },
    toggleFullscreen: () => vow.toggleFullscreen(),
    nextDisplay: () => vow.moveToNextDisplay(),
    toast: (m: string) => overlay.toast(m),
    enterDisplay: (id: number, u: number, v: number) => vow.enterDisplay(id, u, v),
    openScreenRecordingSettings: () => void setup.show(),
    toggleControlCenter,
    controlAction,
    toggleStereo,
    toggleCinema: () => toggleCinema(),
  });

  // ---- cinema: send a screen far away and make it huge (keeps the far-away feel) ----
  const animateTo = (screen: VirtualScreen, to: ScreenLayout) => {
    tween = { screen, from: { ...screen.layout }, to: { ...to }, t: 0 };
  };
  function toggleCinema() {
    if (cinema && screens.screens.includes(cinema.screen)) {
      animateTo(cinema.screen, cinema.saved);
      cinema = null;
      overlay.toast('Cinema off');
    } else {
      const s = screens.selected ?? interaction.pickCenter() ?? screens.screens[0];
      if (!s) return;
      cinema = { screen: s, saved: { ...s.layout } };
      // In front of where you look (workspace space), as big as fits the view, bottom just above the floor.
      const inv = screens.workspace.getWorldQuaternion(new Quaternion()).invert();
      const gaze = anglesFromDirection(camera.getWorldDirection(new Vector3()).applyQuaternion(inv));
      const ty = Math.tan(MathUtils.degToRad(camera.fov / 2));
      const halfW = Math.min(CINEMA_FILL_W * ty * camera.aspect, CINEMA_FILL_H * ty * s.aspect);
      const width = Math.min(LIMITS.maxSize, 2 * CINEMA_DISTANCE * halfW);
      const height = width / s.aspect;
      const centreY = FLOOR_Y + 0.3 + height / 2;
      const pitch = MathUtils.radToDeg(Math.asin(MathUtils.clamp(centreY / CINEMA_DISTANCE, -1, 1)));
      animateTo(s, { ...s.layout, yaw: gaze.yaw, pitch, distance: CINEMA_DISTANCE, width, height });
      screens.select(s);
      if (controlCenter.open) controlCenter.hide();
      overlay.toast(`Cinema: ${s.source.label} — T again to bring it back`);
    }
    pushControlState();
  }
  const updateCinema = (dt: number) => {
    if (cinema && !screens.screens.includes(cinema.screen)) cinema = null; // display went away
    const target = cinema ? CINEMA_DIM : 1;
    if (Math.abs(dim - target) > 0.001) {
      dim += (target - dim) * (1 - Math.exp(-dt * 2.5));
      panorama.mesh.material.color.setScalar(dim);
    }
    if (!tween) return;
    tween.t = Math.min(1, tween.t + dt / CINEMA_TWEEN_S);
    const k = tween.t * tween.t * (3 - 2 * tween.t);
    const { from, to, screen } = tween;
    // Distance and size move geometrically, so the screen visibly recedes while it grows.
    const geo = (a: number, b: number) => a * Math.pow(b / a, k);
    const dYaw = ((((to.yaw - from.yaw + 180) % 360) + 360) % 360) - 180;
    Object.assign(screen.layout, {
      yaw: from.yaw + dYaw * k,
      pitch: from.pitch + (to.pitch - from.pitch) * k,
      distance: geo(from.distance, to.distance),
      width: geo(from.width, to.width),
      height: geo(from.height, to.height),
    });
    screen.apply();
    if (tween.t >= 1) {
      tween = null;
      screens.changed();
    }
  };

  // ---- hand pointer (camera): feeds the same press / move / release as the mouse ----
  const handOutline = new HandOutline(camera);
  camera.add(handOutline.mesh);
  const hands = new HandTracker({
    hand: (points, pinched) => handOutline.update(points, pinched),
    pointer: (ndc, pinched, reach) => interaction.handInput(ndc, pinched, reach),
    viewTan: () => {
      const ty = Math.tan(MathUtils.degToRad(camera.fov / 2));
      return { x: ty * camera.aspect, y: ty };
    },
    state: (st, detail) => {
      handState = st;
      handCamera = hands.camera;
      if (st === 'error') {
        overlay.toast(`Hands: ${detail ?? 'failed to start'}`);
        prefs.hands = false;
        savePrefs();
      }
      pushControlState();
    },
  });
  function setHands(on: boolean) {
    prefs.hands = on;
    savePrefs();
    if (on) {
      overlay.toast('Hands: point with your index finger, pinch to click · pinch a screen and push / pull to move it back / in');
      startHands();
    } else hands.stop();
    pushControlState();
  }
  function startHands() {
    void hands.start(prefs.handsCamera).then(() => {
      if (prefs.handsCamera === 'glasses' && hands.running && hands.camera === 'mac') overlay.toast('Hands: glasses camera not found — using the Mac camera');
    });
  }
  if (prefs.hands) startHands();

  // ---- panorama ----
  panorama
    .load(await vow.getPanorama())
    .catch((err) => overlay.toast(`Panorama failed to load: ${err}`))
    .finally(() => (overlay.panoramaName = panorama.name));
  overlay.panoramaName = panorama.name;

  // ---- sizing / FOV ----
  const size = new Vector2();
  function resize() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = (stereo ? w / 2 : w) / h;
    camera.updateProjectionMatrix();
    hud.fit();
  }
  vow.onWindowOnGlasses((onGlasses) => {
    camera.fov = onGlasses ? config.fovGlasses : config.fovDesktop;
    resize();
  });
  window.addEventListener('resize', resize);
  resize();
  onStatus(status);

  // Permissions / onboarding before anything goes fullscreen on the glasses.
  const setup = new Setup({
    autoEnter: () => prefs.autoEnter,
    setAutoEnter: (on) => {
      prefs.autoEnter = on;
      savePrefs();
    },
  });
  void setup.showIfNeeded();

  // Debug overlay on by default during development.
  if (import.meta.env.DEV) overlay.toggleDebug();

  // ---- anchor modes: move the whole workspace relative to the head ----
  const euler = new Euler(0, 0, 0, 'YXZ');
  function cameraYaw(): number {
    return euler.setFromQuaternion(camera.quaternion, 'YXZ').y;
  }
  const updateWorkspace = (dt: number) => {
    const ws = screens.workspace;
    switch (prefs.anchor) {
      case 'spatial':
        ws.quaternion.identity();
        ws.position.set(0, 0, 0);
        break;
      case 'head':
        ws.quaternion.copy(camera.quaternion);
        ws.position.copy(camera.position);
        break;
      case 'smooth': {
        const yaw = cameraYaw();
        const diff = Math.atan2(Math.sin(yaw - followYaw), Math.cos(yaw - followYaw));
        if (Math.abs(diff) > MathUtils.degToRad(FOLLOW_START)) following = true;
        if (following) {
          followYaw += diff * (1 - Math.exp(-dt * 3));
          if (Math.abs(diff) < MathUtils.degToRad(FOLLOW_STOP)) following = false;
        }
        ws.quaternion.setFromAxisAngle(UP, followYaw);
        ws.position.lerp(camera.position, 1 - Math.exp(-dt * 3));
        break;
      }
    }
  };

  let last = performance.now();
  renderer.setAnimationLoop((now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    tracker.update(camera, dt);
    updateWorkspace(dt);
    panorama.mesh.position.copy(camera.position); // background stays at infinity in 6DoF
    ambient.update(now / 1000, dt);
    grid.update(now / 1000, screens.screens);
    updateCinema(dt);
    screens.update(Date.now());
    controlCenter.update();

    renderer.getSize(size);
    if (stereo) {
      camera.updateMatrixWorld();
      stereoCam.eyeSep = prefs.ipd;
      stereoCam.update(camera);
      const half = size.x / 2;
      renderer.setScissorTest(true);
      renderer.setScissor(0, 0, half, size.y);
      renderer.setViewport(0, 0, half, size.y);
      renderer.render(scene, stereoCam.cameraL);
      renderer.setScissor(half, 0, half, size.y);
      renderer.setViewport(half, 0, half, size.y);
      renderer.render(scene, stereoCam.cameraR);
      renderer.setScissorTest(false);
    } else {
      renderer.setViewport(0, 0, size.x, size.y);
      renderer.render(scene, camera);
    }
    overlay.frame();
  });

  (window as unknown as { __vowReady?: boolean }).__vowReady = true;
  // Dev-only handle for scripted UI tests (project screens to pixels, etc.).
  if (import.meta.env.DEV) Object.assign(window, { __vow: { screens, camera, controlCenter, interaction, hands } });
}

function setAnisotropy(tex: Texture, n: number) {
  if (tex.anisotropy === n) return;
  tex.anisotropy = n;
  tex.needsUpdate = true;
}

boot().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML('beforeend', `<pre class="panel" style="top:40%;left:20%">${String(err)}</pre>`);
});
