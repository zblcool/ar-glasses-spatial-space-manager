import { Group, MathUtils } from 'three';
import type { DisplaysState, MirrorDisplay } from '../../../shared/types';
import { vow } from '../vow';
import { DisplayCaptureSource, TestPatternSource, type ScreenSource } from './ScreenSource';
import { LIMITS, VirtualScreen, type ScreenLayout } from './VirtualScreen';
import type { IconName } from '../ui/canvasKit';

const SAVE_DEBOUNCE_MS = 300;
const DEFAULT_DISTANCE = 2.4;
const DEFAULT_HEIGHT = 0.95;
/** Angular gap between neighbouring screens in the default arrangement. */
const GAP_DEG = 3;

interface SavedLayout {
  version: number;
  screens: ScreenLayout[];
}

interface ScreenSpec {
  key: string;
  label: string;
  aspect: number;
  icon: IconName;
  accent: string;
  display: MirrorDisplay | null;
  /** Placed first (front and centre) in the default arrangement. */
  primary: boolean;
  source: () => ScreenSource;
}

const ACCENTS = ['#4aa3ff', '#3ddc84', '#f5c542', '#ff7ab6', '#b48cff', '#5ad1d1'];

/**
 * Keeps one screen per mirrored display (every display except the glasses),
 * creates/removes screens as displays come and go, and persists layouts by
 * display key so a display returns to where it was.
 */
export class ScreenManager {
  /** Parent of all screens; the anchor mode (spatial / smooth follow / head-locked) moves it. */
  readonly workspace = new Group();
  readonly screens: VirtualScreen[] = [];
  private saved = new Map<string, ScreenLayout>();
  private selectedId: string | null = null;
  private saveTimer: number | null = null;
  private listeners = new Set<() => void>();
  private lastState: DisplaysState | null = null;

  async init(): Promise<void> {
    const raw = (await vow.loadLayout()) as Partial<SavedLayout> | null;
    const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
    for (const s of Array.isArray(raw?.screens) ? raw.screens : []) {
      if (s && typeof s.id === 'string' && num(s.yaw) && num(s.pitch) && num(s.distance) && num(s.width) && num(s.height)) {
        this.saved.set(s.id, { ...s, aspectLocked: s.aspectLocked !== false });
      }
    }
  }

  get selected(): VirtualScreen | null {
    return this.screens.find((s) => s.id === this.selectedId) ?? null;
  }

  select(screen: VirtualScreen | null): void {
    if (screen?.id === this.selectedId) return;
    this.selected?.setSelected(false);
    this.selectedId = screen?.id ?? null;
    screen?.setSelected(true);
    this.emit();
  }

  cycle(dir: 1 | -1): void {
    if (!this.screens.length) return;
    const i = this.screens.findIndex((s) => s.id === this.selectedId);
    const next = i < 0 ? (dir > 0 ? 0 : this.screens.length - 1) : (i + dir + this.screens.length) % this.screens.length;
    this.select(this.screens[next]);
  }

  /** Make the screen set match the mirrored displays. */
  sync(state: DisplaysState): void {
    this.lastState = state;
    const specs = this.specsFor(state);

    for (const s of [...this.screens]) {
      if (!specs.some((sp) => sp.key === s.id)) {
        if (s.id === this.selectedId) this.select(null);
        this.screens.splice(this.screens.indexOf(s), 1);
        s.dispose();
      }
    }

    const fresh: VirtualScreen[] = [];
    for (const spec of specs) {
      let screen = this.screens.find((s) => s.id === spec.key);
      if (!screen) {
        const saved = this.saved.get(spec.key);
        const layout: ScreenLayout = saved
          ? { ...saved }
          : { id: spec.key, yaw: 0, pitch: 0, distance: DEFAULT_DISTANCE, width: DEFAULT_HEIGHT * spec.aspect, height: DEFAULT_HEIGHT, aspectLocked: true };
        screen = new VirtualScreen(layout, spec.source());
        screen.icon = spec.icon;
        this.screens.push(screen);
        this.workspace.add(screen.group);
        if (!saved) fresh.push(screen);
      }
      screen.fitAspect(spec.aspect);
      if (screen.source instanceof DisplayCaptureSource) {
        screen.source.bind(spec.display, this.unavailableMessage(state));
      }
    }
    // Keep the configured order (primary first) for Tab cycling.
    this.screens.sort((a, b) => specs.findIndex((s) => s.key === a.id) - specs.findIndex((s) => s.key === b.id));
    if (fresh.length) {
      this.placeDefaults(fresh, specs);
      this.changed(); // persist, so new displays keep their spot next time
    } else this.emit();
  }

  /** Highlight the screen whose display currently has the cursor. */
  setCursorDisplay(displayId: number | null): void {
    for (const s of this.screens) {
      s.setActive(displayId !== null && s.source instanceof DisplayCaptureSource && s.source.displayId === displayId);
    }
  }

  /** Call after mutating any screen's layout; persists with a short debounce. */
  changed(): void {
    this.emit();
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, SAVE_DEBOUNCE_MS);
  }

  async save(): Promise<void> {
    for (const s of this.screens) this.saved.set(s.id, { ...s.layout });
    const data: SavedLayout = { version: 2, screens: [...this.saved.values()] };
    await vow.saveLayout(data);
  }

  /** Forget all saved positions and lay the current screens out again. */
  reset(): void {
    this.saved.clear();
    const specs = this.lastState ? this.specsFor(this.lastState) : [];
    for (const s of this.screens) {
      const spec = specs.find((x) => x.key === s.id);
      s.layout = { id: s.id, yaw: 0, pitch: 0, distance: DEFAULT_DISTANCE, width: DEFAULT_HEIGHT * (spec?.aspect ?? s.aspect), height: DEFAULT_HEIGHT, aspectLocked: true };
    }
    this.placeDefaults([...this.screens], specs);
    this.changed();
  }

  update(nowMs: number): void {
    for (const s of this.screens) {
      s.source.update(nowMs);
      s.update();
    }
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(): void {
    for (const cb of this.listeners) cb();
  }

  private unavailableMessage(state: DisplaysState): string {
    switch (state.status) {
      case 'starting':
        return 'Creating virtual display…';
      case 'unavailable':
      case 'error':
        return state.detail ?? 'Virtual display unavailable';
      default:
        return 'Display not available';
    }
  }

  private specsFor(state: DisplaysState): ScreenSpec[] {
    const specs: ScreenSpec[] = state.displays.map((d, i) => ({
      key: d.key,
      label: d.name,
      aspect: d.width / d.height,
      icon: d.kind === 'virtual' ? 'virtual' : /built-?in/i.test(d.name) || d.key === 'display-builtin' ? 'laptop' : 'display',
      accent: ACCENTS[i % ACCENTS.length],
      display: d,
      // The main display (menu bar, Dock, new windows) goes front and centre.
      primary: d.isMain,
      source: () => new DisplayCaptureSource(d.key, d.name, ACCENTS[i % ACCENTS.length]),
    }));
    // While virtual displays are still starting, keep placeholders so the layout doesn't jump.
    if (state.status === 'starting' && !specs.some((s) => s.key.startsWith('vd'))) {
      for (const key of ['vd1', 'vd2']) {
        specs.unshift({
          key,
          label: `VOW Virtual ${key.slice(2)}`,
          aspect: 16 / 9,
          icon: 'virtual',
          accent: ACCENTS[0],
          display: null,
          primary: key === 'vd1',
          source: () => new DisplayCaptureSource(key, `VOW Virtual ${key.slice(2)}`, ACCENTS[0]),
        });
      }
    }
    // Nothing to mirror (browser preview, no permission yet…): show test patterns instead of an empty room.
    if (!specs.length) {
      specs.push(
        { key: 'test-a', label: 'Test Pattern A', aspect: 16 / 9, icon: 'pattern', accent: '#4aa3ff', display: null, primary: true, source: () => new TestPatternSource('test-a', 'Test Pattern A', 1920, 1080, '#4aa3ff') },
        { key: 'test-b', label: 'Test Pattern B', aspect: 4 / 3, icon: 'pattern', accent: '#f5c542', display: null, primary: false, source: () => new TestPatternSource('test-b', 'Test Pattern B', 1024, 768, '#f5c542') },
      );
    }
    specs.sort((a, b) => Number(b.primary) - Number(a.primary));
    return specs;
  }

  /**
   * Default arrangement for screens without a saved position: the first goes
   * straight ahead if free, the rest into the nearest free angular slot,
   * alternating right / left, so they never land on top of screens already
   * placed (e.g. ones the user moved).
   */
  private placeDefaults(fresh: VirtualScreen[], specs: ScreenSpec[]): void {
    const halfWidth = (s: VirtualScreen) => MathUtils.radToDeg(Math.atan(s.layout.width / 2 / s.layout.distance));
    const occupied: Array<[number, number]> = this.screens
      .filter((s) => !fresh.includes(s) && Math.abs(s.layout.pitch) < 30)
      .map((s) => [s.layout.yaw - halfWidth(s), s.layout.yaw + halfWidth(s)]);
    const free = (lo: number, hi: number) => occupied.every(([a, b]) => hi + GAP_DEG <= a || lo - GAP_DEG >= b);
    const ordered = [...fresh].sort((a, b) => specs.findIndex((s) => s.key === a.id) - specs.findIndex((s) => s.key === b.id));
    for (const s of ordered) {
      const hw = halfWidth(s);
      let yaw = 0;
      // Scan outward from straight ahead: 0, -1, +1, -2, +2 … (right first).
      for (let step = 0; step <= 360; step++) {
        const candidate = (step % 2 === 1 ? -1 : 1) * Math.ceil(step / 2);
        if (free(candidate - hw, candidate + hw)) {
          yaw = candidate;
          break;
        }
      }
      occupied.push([yaw - hw, yaw + hw]);
      s.layout.yaw = yaw;
      s.layout.pitch = 0;
      s.layout.distance = MathUtils.clamp(s.layout.distance, LIMITS.minDistance, LIMITS.maxDistance);
      s.apply();
    }
  }
}
