import { Camera, Plane, Quaternion, Raycaster, Vector2, Vector3 } from 'three';
import type { MockHead } from '../pose/MockHead';
import type { ScreenManager } from '../screens/ScreenManager';
import { DisplayCaptureSource } from '../screens/ScreenSource';
import { anglesFromDirection, VirtualScreen } from '../screens/VirtualScreen';
import type { ControlAction, ControlCenter } from '../ui/ControlCenter';
import type { Cursor3D } from '../ui/Cursor3D';

type Drag =
  | { kind: 'look'; x: number; y: number }
  /** Pressed on a live display: a click enters it, a drag turns into a move. */
  | { kind: 'press'; screen: VirtualScreen; x: number; y: number; dYaw: number; dPitch: number }
  | { kind: 'move'; screen: VirtualScreen; dYaw: number; dPitch: number }
  | {
      kind: 'resize';
      screen: VirtualScreen;
      plane: Plane;
      /** |x|, |y| of the grab point in screen-local metres, and the size at grab time. */
      grab: Vector2;
      w0: number;
      h0: number;
    }
  | { kind: 'panel'; x: number; y: number };

export interface InteractionHooks {
  recenter(): void;
  toggleDebug(): void;
  toggleHelp(): void;
  adjustSmoothing(delta: number): void;
  toggleFullscreen(): void;
  nextDisplay(): void;
  toast(msg: string): void;
  /** Move the real cursor onto a mirrored display at normalised (u, v). */
  enterDisplay(displayId: number, u: number, v: number): void;
  openScreenRecordingSettings(): void;
  toggleControlCenter(): void;
  controlAction(action: ControlAction): void;
  toggleStereo(): void;
  toggleCinema(): void;
}

type Hit =
  | { kind: 'panel'; uv: Vector2; point: Vector3 }
  | { kind: 'screen'; screen: VirtualScreen; part: 'content' | 'pill' | 'handle'; uv: Vector2 | null; point: Vector3 };

/** One pointer reading, from the mouse or a tracked hand. */
export interface PointerSample {
  /** Where it points, in normalised device coordinates of the (mono) camera. */
  ndc: Vector2;
  /** The same point in canvas pixels: click slop and look-drag deltas use these. */
  x: number;
  y: number;
  /** Option held: a press on a live display moves it instead of entering it. */
  alt: boolean;
}

export type PointerSource = 'mouse' | 'hand';

const CLICK_SLOP_PX = 4;
/** Pinches wobble more than mouse clicks. */
const HAND_SLOP_PX = 14;
/**
 * Hand push / pull while holding a screen moves it through space (its real
 * size stays, so it looks smaller as it goes back): distance changes by
 * exp(GAIN × reach change), where reach is the log of the hand's apparent
 * size (≈ log of how much nearer the camera it got). Moving the hand ~15 %
 * of its distance doubles or halves the screen's distance. Small wobbles
 * inside the dead zone are ignored.
 */
const PUSH_GAIN = 4.5;
const PUSH_DEADZONE = 0.04;
const MOVE_STEP = 2; // degrees per arrow press
const SIZE_STEP = 1.05;

/**
 * Mouse, hand and keyboard control. Mouse and hand both arrive as a pointer
 * ray plus a pressed state (press / move / release), so they behave the same:
 * the hand's pinch is a click. Mouse: drag a screen's pill (or the screen) to
 * move it, drag a corner arc to resize, wheel to scale (Option+wheel:
 * distance), drag empty space to look around (when the glasses aren't
 * tracking), click a live display to put the real cursor on it. The pointer is
 * shown as a 3D dot. Keyboard: see HELP below.
 */
export class Interaction {
  private readonly raycaster = new Raycaster();
  private readonly ndc = new Vector2();
  private drag: Drag | null = null;
  private downAt: { x: number; y: number } | null = null;
  private hovered: VirtualScreen | null = null;
  /** Which input owns the current press (the other one is ignored until release). */
  private active: PointerSource | null = null;
  /** Which input last placed the cursor dot. */
  private lastSource: PointerSource = 'mouse';
  private handDown = false;
  /** Hand reach at the press, and the held screen's distance then (push / pull). */
  private reach0 = 0;
  private reachNow = 0;
  private dist0 = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly camera: Camera,
    private readonly screens: ScreenManager,
    private readonly mock: MockHead,
    private readonly cursor: Cursor3D,
    private readonly panel: ControlCenter,
    private readonly isStereo: () => boolean,
    private readonly hooks: InteractionHooks,
  ) {
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointermove', this.onPointerMove);
    canvas.addEventListener('pointerup', this.onPointerUp);
    canvas.addEventListener('pointercancel', this.onPointerUp);
    canvas.addEventListener('pointerleave', () => {
      if (this.active === 'hand' || this.lastSource === 'hand') return;
      this.cursor.hide();
      this.setHovered(null);
    });
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('keydown', this.onKeyDown);
  }

  // ---- picking ------------------------------------------------------------

  /** Mouse → pointer sample. In side-by-side stereo each half of the window is one eye's full view. */
  private mouseSample(e: { clientX: number; clientY: number; altKey: boolean }): PointerSample {
    const r = this.canvas.getBoundingClientRect();
    let x = (e.clientX - r.left) / r.width;
    if (this.isStereo()) x = (x * 2) % 1;
    return { ndc: new Vector2(x * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), x: e.clientX, y: e.clientY, alt: e.altKey };
  }

  private setRay(s: PointerSample): void {
    this.ndc.copy(s.ndc);
    this.raycaster.setFromCamera(this.ndc, this.camera);
  }

  private pick(): Hit | null {
    if (this.panel.open) {
      const h = this.raycaster.intersectObject(this.panel.mesh, false)[0];
      if (h?.uv) return { kind: 'panel', uv: h.uv, point: h.point };
    }
    const targets = this.screens.screens.flatMap((s) => [...s.handles.filter((h) => h.visible), s.pill, s.content]);
    const hit = this.raycaster.intersectObjects(targets, false)[0];
    if (!hit) return null;
    const ud = hit.object.userData;
    return {
      kind: 'screen',
      screen: ud.screen as VirtualScreen,
      part: ud.corner ? 'handle' : ud.pill ? 'pill' : 'content',
      uv: hit.uv ?? null,
      point: hit.point,
    };
  }

  /** Screen under the centre of view (for gaze selection with the glasses). */
  pickCenter(): VirtualScreen | null {
    this.raycaster.setFromCamera(new Vector2(0, 0), this.camera);
    const h = this.pick();
    return h?.kind === 'screen' ? h.screen : null;
  }

  /** The display shown on a screen, if it is streaming. */
  private liveDisplay(screen: VirtualScreen): number | null {
    const src = screen.source;
    return src instanceof DisplayCaptureSource && src.live ? src.displayId : null;
  }

  /** Ray direction in workspace space (screens live there; it may follow the head). */
  private localAngles(): { yaw: number; pitch: number } {
    const inv = this.screens.workspace.getWorldQuaternion(new Quaternion()).invert();
    return anglesFromDirection(this.raycaster.ray.direction.clone().applyQuaternion(inv));
  }

  private setHovered(s: VirtualScreen | null): void {
    if (s === this.hovered) return;
    this.hovered?.setHover(false);
    this.hovered = s;
    s?.setHover(true);
  }

  // ---- pointer --------------------------------------------------------------

  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0 || this.active) return;
    this.canvas.setPointerCapture(e.pointerId);
    this.press('mouse', this.mouseSample(e));
  };

  private onPointerMove = (e: PointerEvent): void => {
    this.move('mouse', this.mouseSample(e));
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (this.canvas.hasPointerCapture(e.pointerId)) this.canvas.releasePointerCapture(e.pointerId);
    if (this.active === 'mouse') this.release(this.mouseSample(e));
  };

  /**
   * Hand pointer, once per camera frame: where the hand points and whether it
   * is pinching, or null when no hand is in view (a press in progress is
   * dropped, not clicked).
   */
  handInput(ndc: Vector2 | null, pinched: boolean, reach = 0): void {
    if (!ndc) {
      if (this.active === 'hand') this.endPress();
      this.handDown = false;
      if (this.lastSource === 'hand') {
        this.cursor.hide();
        this.panel.hover(null);
        this.setHovered(null);
      }
      return;
    }
    const r = this.canvas.getBoundingClientRect();
    const s: PointerSample = { ndc, x: ((ndc.x + 1) / 2) * r.width, y: ((1 - ndc.y) / 2) * r.height, alt: false };
    this.reachNow = reach;
    if (pinched && !this.handDown && !this.active) {
      this.reach0 = reach;
      this.press('hand', s);
      const d = this.drag;
      this.dist0 = d && 'screen' in d ? d.screen.layout.distance : 0;
    }
    this.handDown = pinched;
    this.move('hand', s);
    if (!pinched && this.active === 'hand') this.release(s);
  }

  private press(src: PointerSource, s: PointerSample): void {
    this.active = src;
    this.downAt = { x: s.x, y: s.y };
    this.setRay(s);
    const hit = this.pick();
    this.cursor.setPressed(true);

    if (hit?.kind === 'panel') {
      this.drag = { kind: 'panel', x: s.x, y: s.y };
    } else if (hit) {
      const { x, y, alt } = s;
      const screen = hit.screen;
      this.screens.select(screen);
      if (hit.part === 'handle') {
        const normal = new Vector3(0, 0, 1).applyQuaternion(screen.group.getWorldQuaternion(new Quaternion()));
        const plane = new Plane().setFromNormalAndCoplanarPoint(normal, screen.group.getWorldPosition(new Vector3()));
        const p = this.raycaster.ray.intersectPlane(plane, new Vector3());
        const local = p ? screen.group.worldToLocal(p) : new Vector3(screen.layout.width / 2, screen.layout.height / 2, 0);
        this.drag = { kind: 'resize', screen, plane, grab: new Vector2(Math.abs(local.x), Math.abs(local.y)), w0: screen.layout.width, h0: screen.layout.height };
        screen.showSize();
      } else {
        const ray = this.localAngles();
        const dYaw = screen.layout.yaw - ray.yaw;
        const dPitch = screen.layout.pitch - ray.pitch;
        const pressToEnter = hit.part === 'content' && !alt && this.liveDisplay(screen) !== null;
        this.drag = pressToEnter
          ? { kind: 'press', screen, x, y, dYaw, dPitch }
          : { kind: 'move', screen, dYaw, dPitch };
      }
    } else if (this.mock.enabled) {
      this.drag = { kind: 'look', x: s.x, y: s.y };
    }
    this.canvas.classList.toggle('dragging', !!this.drag && this.drag.kind !== 'panel');
  }

  private move(src: PointerSource, s: PointerSample): void {
    if (this.active && this.active !== src) return;
    this.lastSource = src;
    this.setRay(s);
    const d = this.drag;
    if (!d || d.kind === 'panel') {
      const hit = this.pick();
      this.cursor.place(this.camera, hit?.point ?? null, this.raycaster.ray.direction);
      this.panel.hover(hit?.kind === 'panel' ? hit.uv : null);
      this.setHovered(hit?.kind === 'screen' ? hit.screen : null);
      return;
    }

    if (d.kind === 'press') {
      // Past the click slop (or a hand push), a press on a display becomes a move.
      if (Math.hypot(s.x - d.x, s.y - d.y) < this.slop() && !this.pushing(src)) return;
      this.drag = { kind: 'move', screen: d.screen, dYaw: d.dYaw, dPitch: d.dPitch };
      this.move(src, s);
      return;
    }

    if (d.kind === 'look') {
      this.mock.drag(s.x - d.x, s.y - d.y);
      d.x = s.x;
      d.y = s.y;
      this.cursor.hide();
    } else if (d.kind === 'move') {
      const ray = this.localAngles();
      d.screen.layout.yaw = ray.yaw + d.dYaw;
      d.screen.layout.pitch = ray.pitch + d.dPitch;
      if (this.pushing(src)) {
        // Push the hand forward = send the screen back, pull = bring it in.
        const dr = this.reachNow - this.reach0;
        d.screen.layout.distance = this.dist0 * Math.exp(PUSH_GAIN * (dr - Math.sign(dr) * PUSH_DEADZONE));
      }
      d.screen.apply();
      this.screens.changed();
      this.cursor.hide();
    } else {
      const hitPoint = this.raycaster.ray.intersectPlane(d.plane, new Vector3());
      if (!hitPoint) return;
      this.cursor.place(this.camera, hitPoint.clone(), this.raycaster.ray.direction);
      const local = d.screen.group.worldToLocal(hitPoint);
      const screen = d.screen;
      // Size follows the cursor's movement relative to where the arc was grabbed
      // (centre stays fixed, so each edge moves by the cursor delta).
      const w = d.w0 + 2 * (Math.abs(local.x) - d.grab.x);
      const h = d.h0 + 2 * (Math.abs(local.y) - d.grab.y);
      if (screen.layout.aspectLocked) {
        const k = (w * d.w0 + h * d.h0) / (d.w0 * d.w0 + d.h0 * d.h0);
        if (k > 0) screen.scaleBy((d.w0 * k) / screen.layout.width);
      } else {
        screen.resize(w, h);
      }
      screen.showSize();
      this.screens.changed();
    }
  }

  private pushing(src: PointerSource): boolean {
    return src === 'hand' && this.dist0 > 0 && Math.abs(this.reachNow - this.reach0) > PUSH_DEADZONE;
  }

  private slop(): number {
    return this.active === 'hand' ? HAND_SLOP_PX : CLICK_SLOP_PX;
  }

  private release(s: PointerSample): void {
    const wasClick = !!this.downAt && Math.hypot(s.x - this.downAt.x, s.y - this.downAt.y) < this.slop();
    const d = this.drag;
    this.setRay(s);

    if (d?.kind === 'panel' && wasClick) {
      const hit = this.pick();
      const action = hit?.kind === 'panel' ? this.panel.click(hit.uv) : null;
      if (action) this.hooks.controlAction(action);
    } else if (d?.kind === 'press') {
      // Click on a live display: move the real cursor there, at the clicked point.
      const hit = this.pick();
      const id = this.liveDisplay(d.screen);
      if (hit?.kind === 'screen' && hit.screen === d.screen && hit.uv && id !== null) {
        this.hooks.enterDisplay(id, hit.uv.x, hit.uv.y);
        this.cursor.hide();
        this.hooks.toast(`Mouse is on ${d.screen.source.label} — click again to use it · ⌃⌥⎋ returns`);
      }
    } else if (wasClick && (!d || d.kind === 'look')) {
      // Click on empty space: deselect and close the control center.
      if (!this.pick()) {
        this.screens.select(null);
        if (this.panel.open) this.hooks.toggleControlCenter();
      }
    }
    this.endPress();
  }

  private endPress(): void {
    this.drag = null;
    this.downAt = null;
    this.active = null;
    this.dist0 = 0;
    this.cursor.setPressed(false);
    this.canvas.classList.remove('dragging');
  }

  private onWheel = (e: WheelEvent): void => {
    this.setRay(this.mouseSample(e));
    const hit = this.pick();
    if (hit?.kind !== 'screen') return;
    e.preventDefault();
    const target = hit.screen;
    this.screens.select(target);
    const factor = Math.exp(-e.deltaY * 0.0015);
    if (e.altKey) {
      target.layout.distance *= factor;
      target.apply();
    } else {
      target.scaleBy(factor);
      target.showSize();
    }
    this.screens.changed();
  };

  // ---- keyboard -------------------------------------------------------------

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.metaKey || e.ctrlKey) return; // leave system shortcuts alone
    if (document.body.classList.contains('setup-open')) return; // the setup screen has focus
    const sel = this.screens.selected;
    const step = e.shiftKey ? MOVE_STEP * 5 : MOVE_STEP;
    let handled = true;

    const nudge = (dYaw: number, dPitch: number) => {
      if (sel) {
        sel.layout.yaw += dYaw;
        sel.layout.pitch += dPitch;
        sel.apply();
        this.screens.changed();
      } else if (this.mock.enabled) {
        // No selection while not tracking: arrows turn the head instead.
        this.mock.drag(dYaw / 0.15, dPitch / 0.15);
      }
    };
    const resize = (sw: number, sh: number) => {
      if (!sel) return;
      sel.resize(sel.layout.width * sw, sel.layout.height * sh);
      sel.showSize();
      this.screens.changed();
    };
    const scale = (k: number) => {
      if (!sel) return;
      sel.scaleBy(k);
      sel.showSize();
      this.screens.changed();
    };

    switch (e.key) {
      case 'Tab':
        this.screens.cycle(e.shiftKey ? -1 : 1);
        break;
      case 'g':
      case 'G': {
        const s = this.pickCenter();
        this.screens.select(s);
        this.hooks.toast(s ? `Selected ${s.source.label}` : 'No screen in view');
        break;
      }
      case 'Escape':
        if (this.panel.open) this.hooks.toggleControlCenter();
        else this.screens.select(null);
        break;
      case 'c':
      case 'C':
      case ' ':
        this.hooks.toggleControlCenter();
        break;
      case 'ArrowLeft':
        nudge(step, 0);
        break;
      case 'ArrowRight':
        nudge(-step, 0);
        break;
      case 'ArrowUp':
        nudge(0, step);
        break;
      case 'ArrowDown':
        nudge(0, -step);
        break;
      case '=':
      case '+':
        scale(SIZE_STEP);
        break;
      case '-':
      case '_':
        scale(1 / SIZE_STEP);
        break;
      case ']':
        resize(SIZE_STEP, 1);
        break;
      case '[':
        resize(1 / SIZE_STEP, 1);
        break;
      case "'":
        resize(1, SIZE_STEP);
        break;
      case ';':
        resize(1, 1 / SIZE_STEP);
        break;
      case 't':
      case 'T':
        this.hooks.toggleCinema();
        break;
      case '.':
      case ',':
        if (sel) {
          sel.layout.distance *= e.key === '.' ? SIZE_STEP : 1 / SIZE_STEP;
          sel.apply();
          this.screens.changed();
        }
        break;
      case 'a':
      case 'A':
        if (sel) {
          sel.layout.aspectLocked = !sel.layout.aspectLocked;
          this.screens.changed();
          this.hooks.toast(sel.layout.aspectLocked ? 'Aspect ratio locked' : 'Free resize');
        } else {
          this.hooks.toast('Select a screen first (Tab / click / G)');
        }
        break;
      case 'Backspace':
        if (e.shiftKey) {
          this.screens.reset();
          this.hooks.toast('Layout reset to defaults');
        } else handled = false;
        break;
      case 'r':
      case 'R':
        this.hooks.recenter();
        break;
      case '3':
        this.hooks.toggleStereo();
        break;
      case 'd':
      case 'D':
      case '`':
        this.hooks.toggleDebug();
        break;
      case 'h':
      case 'H':
      case '?':
        this.hooks.toggleHelp();
        break;
      case '9':
        this.hooks.adjustSmoothing(-0.05);
        break;
      case '0':
        this.hooks.adjustSmoothing(0.05);
        break;
      case 'p':
      case 'P':
        this.hooks.openScreenRecordingSettings();
        break;
      case 'f':
      case 'F':
        this.hooks.toggleFullscreen();
        break;
      case 'm':
      case 'M':
        this.hooks.nextDisplay();
        break;
      default:
        handled = false;
    }
    if (handled) e.preventDefault();
  };
}

export const HELP: Array<[string, string]> = [
  ['C / ␣', 'control center (anchor modes, 3D, 6DoF…)'],
  ['click', 'a screen: put the mouse on that display'],
  ['⌃⌥⎋', 'bring the mouse back (works anywhere)'],
  ['drag', 'pill / screen: move · empty: look (no glasses)'],
  ['corner', 'drag the arc to resize'],
  ['pinch', 'Hands on: point = move dot, pinch = click / drag'],
  ['pinch+push', 'hold a screen, push hand away / pull back: move it far / near'],
  ['T', 'cinema: send screen far away, huge'],
  ['wheel', 'scale screen · ⌥ wheel: distance'],
  ['Tab', 'cycle selection (⇧ reverse)'],
  ['G', 'select screen in centre of view'],
  ['←↑↓→', 'move selected (⇧ ×5) · no glasses: look'],
  ['+ −', 'scale selected'],
  ['[ ]', 'width   ; \'  height'],
  [', .', 'distance closer / farther'],
  ['A', 'toggle aspect lock / free resize'],
  ['R', 'recenter heading'],
  ['3', '3D (side-by-side) on / off'],
  ['9 0', 'smoothing less / more'],
  ['D', 'debug overlay'],
  ['F', 'fullscreen   M  next display'],
  ['P', 'setup / permissions'],
  ['⌃⌥Q', 'leave the glasses view (works anywhere)'],
  ['⇧⌫', 'reset layout'],
  ['Esc', 'close / deselect   H  this help'],
];
