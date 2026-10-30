import { Camera, Euler, MathUtils } from 'three';
import type { DisplaysState, HelperStatus } from '../../../shared/types';
import type { HeadTracker } from '../pose/HeadTracker';
import type { ScreenManager } from '../screens/ScreenManager';
import { HELP } from '../interaction/Interaction';
import type { Hud } from './Hud';

const fmt = (v: number, digits = 1) => (Number.isFinite(v) ? v.toFixed(digits) : '—');
const TOAST_MS = 2200;
const STATUS_COLORS: Record<string, string> = {
  tracking: '#3ddc84',
  mock: '#4aa3ff',
  starting: '#f5c542',
  searching: '#f5c542',
};

/**
 * Debug overlay, status badge, help panel and toast. HTML in mono view; in
 * side-by-side stereo the same content goes to the head-locked 3D HUD.
 * Refreshed at 4 Hz.
 */
export class Overlay {
  private readonly debugEl = document.getElementById('debug')!;
  private readonly statusEl = document.getElementById('status')!;
  private readonly helpEl = document.getElementById('help')!;
  private readonly toastEl = document.getElementById('toast')!;
  private toastText: string | null = null;
  private toastTimer: number | null = null;
  private frames = 0;
  private lastTick = performance.now();
  private status: HelperStatus = { state: 'starting', mode: 'mock', restarts: 0 };
  private statusText = '';
  private displays: DisplaysState = { status: 'off', displays: [], permission: 'unknown', accessibility: null, immersive: false };
  private warned = new Set<string>();
  private readonly euler = new Euler(0, 0, 0, 'YXZ');
  private stereo = false;
  panoramaName = '';

  constructor(
    private readonly tracker: HeadTracker,
    private readonly screens: ScreenManager,
    private readonly camera: Camera,
    private readonly hud: Hud,
  ) {
    this.helpEl.innerHTML = HELP.map(([k, v]) => `<kbd>${k}</kbd>${v}`).join('\n');
    window.setInterval(() => this.refresh(), 250);
  }

  get debugVisible(): boolean {
    return !this.debugEl.hidden;
  }

  setStatus(s: HelperStatus): void {
    this.status = s;
    this.renderStatus();
  }

  setDisplays(st: DisplaysState): void {
    this.displays = st;
    // Tell the user (once each) which permission is the blocker.
    if (st.displays.length && st.permission !== 'granted') this.warnOnce('rec', 'Screen Recording permission needed to show your displays — press P');
    if (st.accessibility === false) this.warnOnce('ax', 'Allow Accessibility so windows can be moved off the glasses');
  }

  /** Side-by-side stereo: hide HTML (it would only reach one eye), show the 3D HUD. */
  setStereo(on: boolean): void {
    this.stereo = on;
    document.body.classList.toggle('stereo', on);
    this.hud.visible = on;
    this.refresh();
  }

  frame(): void {
    this.frames++;
  }

  toggleDebug(): void {
    this.debugEl.hidden = !this.debugEl.hidden;
    this.refresh();
  }

  toggleHelp(): void {
    this.helpEl.hidden = !this.helpEl.hidden;
  }

  toast(msg: string): void {
    this.toastText = msg;
    this.toastEl.textContent = msg;
    this.toastEl.hidden = false;
    if (this.toastTimer !== null) clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      this.toastEl.hidden = true;
      this.toastText = null;
    }, TOAST_MS);
  }

  private warnOnce(key: string, msg: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.toast(msg);
  }

  private renderStatus(): void {
    const s = this.status;
    let text: string;
    switch (s.state) {
      case 'mock':
        text = 'Mock head (mouse)';
        break;
      case 'tracking':
        text = `${s.device ?? 'Glasses'} · ${s.dof ?? 3}DoF${s.display?.is3d ? ' · 3D' : ''}${s.stable === false ? ' · stabilizing' : ''}`;
        break;
      case 'crashed': {
        const secs = s.retryAt ? Math.max(0, Math.ceil((s.retryAt - Date.now()) / 1000)) : 0;
        text = `Helper crashed · retry in ${secs}s`;
        break;
      }
      case 'searching':
        text = 'Waiting for glasses…';
        break;
      default:
        text = `Helper ${s.state}`;
    }
    this.statusText = text;
    this.statusEl.dataset.state = s.state;
    this.statusEl.textContent = text;
    this.statusEl.title = s.detail ?? '';
  }

  /** Short device line for the control center. */
  deviceLine(): string {
    return this.statusText;
  }

  /** Camera orientation as yaw/pitch/roll in degrees (yaw positive = left). */
  private headAngles(): string {
    this.euler.setFromQuaternion(this.camera.quaternion, 'YXZ');
    const d = (r: number) => fmt(MathUtils.radToDeg(r));
    return `${d(this.euler.y)}° ${d(this.euler.x)}° ${d(this.euler.z)}°`;
  }

  private refresh(): void {
    const now = performance.now();
    const fps = (this.frames * 1000) / (now - this.lastTick);
    this.frames = 0;
    this.lastTick = now;
    if (this.status.state === 'crashed') this.renderStatus();

    let debug: string | null = null;
    if (!this.debugEl.hidden) {
      const st = this.tracker.stats();
      const s = this.status;
      const dsp = this.displays;
      const sel = this.screens.selected;
      const lines = [
        `FPS            ${fmt(fps, 0)}`,
        `pose rate      ${fmt(st.rateHz, 0)} Hz`,
        `pose latency   ${fmt(st.ageMean)} ms avg · ${fmt(st.ageP95)} p95`,
        `  ipc transit  ${fmt(st.transitMean)} ms`,
        `head y/p/r     ${this.headAngles()}`,
        `smoothing      ${this.tracker.smoothing.toFixed(2)}`,
        `mode           ${s.mode}${st.hasPosition ? ' · 6DoF' : ''}${this.stereo ? ' · stereo' : ''}`,
        `helper         ${s.state}${s.restarts ? ` · ${s.restarts} restarts` : ''}`,
        ...(s.detail ? [`  ${s.detail.slice(0, 60)}`] : []),
        ...(s.display ? [`  glasses mode ${s.display.mode === null ? `? (${s.display.error})` : `0x${s.display.mode.toString(16)}${s.display.is3d ? ' 3D' : ' 2D'}`}`] : []),
        `panorama       ${this.panoramaName}`,
        `displays       ${dsp.displays.length} mirrored · virtual ${dsp.status}${dsp.immersive ? ' · immersive' : ''}`,
        `  screen rec.  ${dsp.permission}`,
        `  access.      ${dsp.accessibility === null ? 'n/a' : dsp.accessibility ? 'granted' : 'needed'}`,
        ...(dsp.detail ? [`  ${dsp.detail.slice(0, 60)}`] : []),
        '',
        sel
          ? [
              `selected       ${sel.source.label}`,
              `  yaw/pitch    ${fmt(sel.layout.yaw)}° / ${fmt(sel.layout.pitch)}°`,
              `  distance     ${fmt(sel.layout.distance, 2)} m`,
              `  size         ${fmt(sel.layout.width, 2)} × ${fmt(sel.layout.height, 2)} m (${fmt(Math.hypot(sel.layout.width, sel.layout.height) / 0.0254, 0)}″)`,
              `  resize       ${sel.layout.aspectLocked ? 'aspect locked' : 'free'}`,
            ].join('\n')
          : 'selected       —',
      ];
      debug = lines.join('\n');
      this.debugEl.textContent = debug;
    }

    if (this.stereo) {
      this.hud.draw({
        status: this.statusText,
        statusColor: STATUS_COLORS[this.status.state] ?? '#ff5a5a',
        toast: this.toastText,
        debug,
      });
    }
  }
}
