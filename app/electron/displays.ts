import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { desktopCapturer, screen, systemPreferences } from 'electron';
import type { DisplaysState, MirrorDisplay } from '../shared/types';

interface HelperDisplay {
  id: number;
  name: string;
  width: number;
  height: number;
}

const CURSOR_POLL_MS = 33;
const RESTART_DELAY_MS = 3000;
const REFRESH_DEBOUNCE_MS = 400;
/** Capture physical displays at most this wide (keeps Retina panels cheap to stream). */
const MAX_CAPTURE_WIDTH = 2560;

export interface DisplaysOptions {
  binary: string | null;
  args: string[];
  /** CGDirectDisplayID of the display the app window is on (excluded from mirroring). */
  hostDisplay: () => number | null;
  onState: (s: DisplaysState) => void;
  onCursor: (displayId: number | null) => void;
}

/**
 * Mirrors every display except the one hosting the app window into the 3D
 * space. Owns viture-display-helper (virtual displays, main-display switch,
 * cursor warp, keeping windows off the glasses) and maps displays to
 * desktopCapturer sources.
 */
export class Displays {
  private child: ChildProcessWithoutNullStreams | null = null;
  private virtual: HelperDisplay[] = [];
  private vdStatus: DisplaysState['status'] = 'off';
  private vdDetail: string | undefined;
  private accessibility: boolean | null = null;
  private state: DisplaysState = { status: 'off', displays: [], permission: 'unknown', accessibility: null, immersive: false };
  private stopping = false;
  private cursorTimer: NodeJS.Timeout | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private cursorOn: number | null = null;
  private immersive = false;
  private paused = false;
  private onReleased: (() => void) | null = null;
  private onMain: (() => void) | null = null;

  constructor(private readonly opts: DisplaysOptions) {}

  getState(): DisplaysState {
    return this.state;
  }

  start(): void {
    for (const ev of ['display-added', 'display-removed', 'display-metrics-changed'] as const) {
      screen.on(ev as 'display-added', () => this.refresh());
    }
    this.startCursorPoll();
    if (!this.opts.binary) {
      this.vdStatus = 'unavailable';
      this.vdDetail = 'viture-display-helper not built (make -C helper)';
      this.refresh();
      return;
    }
    this.stopping = false;
    this.spawnChild();
  }

  /** Exit the helper; it restores the display arrangement before the virtual displays vanish. */
  stop(): void {
    this.stopping = true;
    if (this.cursorTimer) clearInterval(this.cursorTimer);
    if (this.child) {
      this.child.stdin.write('quit\n');
      const c = this.child;
      setTimeout(() => c.exitCode === null && c.kill('SIGTERM'), 1500);
    }
    this.child = null;
  }

  /**
   * Remove the virtual displays (resolves once they're gone). Needed before the
   * glasses switch to 3D: on base Apple Silicon there isn't enough display
   * bandwidth for 3840-wide glasses plus virtual displays, and macOS would turn
   * the glasses off.
   */
  pauseVirtual(): Promise<void> {
    if (!this.child || !this.virtual.length) return Promise.resolve();
    this.paused = true;
    return new Promise((resolve) => {
      this.onReleased = resolve;
      this.child!.stdin.write('release\n');
      setTimeout(resolve, 3000); // don't hang if the helper doesn't answer
    });
  }

  /** Bring the virtual displays back (after leaving 3D). */
  resumeVirtual(): void {
    if (!this.paused) return;
    this.paused = false;
    this.vdStatus = 'starting';
    this.child?.stdin.write('create\n');
    this.refresh();
  }

  /** Move the cursor onto a display at normalised (u, v), v measured from the bottom. */
  warp(displayId: number, u: number, v: number): void {
    const d = screen.getAllDisplays().find((x) => x.id === displayId);
    if (!d || !this.child) return;
    const x = Math.round(Math.min(Math.max(u, 0), 1) * (d.bounds.width - 1));
    const y = Math.round((1 - Math.min(Math.max(v, 0), 1)) * (d.bounds.height - 1));
    this.child.stdin.write(`warp ${displayId} ${x} ${y}\n`);
  }

  /** Move the cursor to an absolute global point (used to bring it back to the app window). */
  warpGlobal(x: number, y: number): void {
    const target = screen.getDisplayNearestPoint({ x, y });
    this.child?.stdin.write(`warp ${target.id} ${x - target.bounds.x} ${y - target.bounds.y}\n`);
  }

  /** Re-evaluate host display / immersive mode and rebuild the mirrored display list (debounced). */
  refresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => void this.rebuild(), REFRESH_DEBOUNCE_MS);
  }

  private async rebuild(): Promise<void> {
    const host = this.opts.hostDisplay();
    let sources: Electron.DesktopCapturerSource[] = [];
    try {
      sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
    } catch (err) {
      console.warn('[displays] desktopCapturer.getSources failed:', (err as Error).message);
    }
    const sourceFor = (id: number) => sources.find((s) => s.display_id === String(id))?.id ?? null;
    const mainId = screen.getPrimaryDisplay().id;
    const all = screen.getAllDisplays();

    const virtual: MirrorDisplay[] = this.virtual.map((d, i) => ({
      id: d.id,
      key: `vd${i + 1}`,
      name: d.name,
      kind: 'virtual',
      width: d.width,
      height: d.height,
      sourceId: sourceFor(d.id),
      isMain: d.id === mainId,
    }));
    // Our virtual displays appear on the system a moment before the helper reports
    // "ready"; match them by name too so they're never mistaken for monitors.
    const isOurs = (d: Electron.Display) => this.virtual.some((v) => v.id === d.id) || /^VOW Virtual/i.test(d.label ?? '');
    const physical: MirrorDisplay[] = all
      .filter((d) => d.id !== host && !isOurs(d))
      .map((d) => {
        const pw = Math.round(d.size.width * d.scaleFactor);
        const ph = Math.round(d.size.height * d.scaleFactor);
        const k = Math.min(1, MAX_CAPTURE_WIDTH / pw);
        return {
          id: d.id,
          key: d.internal ? 'display-builtin' : `display-${d.id}`,
          name: d.label || (d.internal ? 'Built-in Display' : `Display ${d.id}`),
          kind: 'physical' as const,
          width: Math.round(pw * k),
          height: Math.round(ph * k),
          sourceId: sourceFor(d.id),
          isMain: d.id === mainId,
        };
      });

    this.state = {
      status: this.vdStatus,
      detail: this.vdDetail,
      displays: [...virtual, ...physical],
      permission: screenPermission(),
      accessibility: this.accessibility,
      immersive: this.immersive,
    };
    this.opts.onState(this.state);
  }

  /**
   * Before going fullscreen on the glasses: make the first virtual display the
   * macOS main display (menu bar, Dock, new windows land in 3D) and keep windows
   * off the glasses. Resolves once the display change has happened.
   *
   * Must run while the app window is NOT fullscreen: rearranging displays under
   * a fullscreen window can detach its fullscreen Space from the glasses, leaving
   * the app running somewhere the user cannot reach.
   */
  beginImmersive(glassesId: number): Promise<void> {
    if (!this.child || !this.virtual.length || this.immersive) return Promise.resolve();
    this.immersive = true;
    this.child.stdin.write(`protect ${glassesId} ${process.pid}\n`);
    return new Promise((resolve) => {
      this.onMain = resolve;
      this.child!.stdin.write(`main ${this.virtual[0].id}\n`);
      setTimeout(resolve, 2500); // don't hang if the helper doesn't answer
    });
  }

  /** After leaving fullscreen: stop guarding the glasses and restore the original arrangement. */
  endImmersive(): void {
    if (!this.immersive || !this.child) return;
    this.immersive = false;
    this.child.stdin.write('protect 0 0\n');
    this.child.stdin.write('restore\n');
    this.refresh();
  }

  private spawnChild(): void {
    this.vdStatus = 'starting';
    this.vdDetail = undefined;
    this.refresh();
    const child = spawn(this.opts.binary!, this.opts.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    let buf = '';
    let lastErr = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line) this.handleLine(line);
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      process.stderr.write(chunk);
      lastErr = chunk.trim().split('\n').pop() ?? lastErr;
    });
    child.on('error', (err) => (lastErr = err.message));
    child.on('exit', (code, signal) => {
      if (this.child !== child) return;
      this.child = null;
      this.virtual = [];
      this.immersive = false;
      if (this.stopping) return;
      this.vdStatus = 'error';
      this.vdDetail = `display helper exited (${signal ?? code})${lastErr ? ` — ${lastErr}` : ''}; retrying`;
      this.refresh();
      setTimeout(() => !this.stopping && this.spawnChild(), RESTART_DELAY_MS);
    });
  }

  private handleLine(line: string): void {
    let msg: { event?: string; message?: string; displays?: HelperDisplay[]; trusted?: boolean; moved?: number };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    switch (msg.event) {
      case 'error':
        this.vdStatus = 'error';
        this.vdDetail = msg.message;
        break;
      case 'ready':
        this.virtual = msg.displays ?? [];
        this.vdStatus = 'ready';
        this.vdDetail = undefined;
        console.log(`[displays] virtual displays ready: ${this.virtual.map((d) => `${d.width}x${d.height}@${Math.round((d as HelperDisplay & { hz?: number }).hz ?? 0)}`).join(', ')}`);
        break;
      case 'released':
        this.virtual = [];
        this.immersive = false;
        this.vdStatus = 'off';
        this.vdDetail = 'paused while the glasses are in 3D (not enough display bandwidth for both)';
        this.onReleased?.();
        this.onReleased = null;
        break;
      case 'ax':
        this.accessibility = !!msg.trusted;
        break;
      case 'windows':
        console.log(`[displays] moved ${msg.moved} window(s) off the glasses display`);
        return;
      case 'main':
        this.onMain?.();
        this.onMain = null;
        break;
      default:
        return;
    }
    this.refresh();
  }

  private startCursorPoll(): void {
    if (this.cursorTimer) clearInterval(this.cursorTimer);
    this.cursorTimer = setInterval(() => {
      const p = screen.getCursorScreenPoint();
      const d = screen.getDisplayNearestPoint(p);
      const inside = p.x >= d.bounds.x && p.x < d.bounds.x + d.bounds.width && p.y >= d.bounds.y && p.y < d.bounds.y + d.bounds.height;
      const mirrored = inside && this.state.displays.some((m) => m.id === d.id);
      const id = mirrored ? d.id : null;
      if (id !== this.cursorOn) {
        this.cursorOn = id;
        this.opts.onCursor(id);
      }
    }, CURSOR_POLL_MS);
  }
}

function screenPermission(): DisplaysState['permission'] {
  try {
    return systemPreferences.getMediaAccessStatus('screen') as DisplaysState['permission'];
  } catch {
    return 'unknown';
  }
}
