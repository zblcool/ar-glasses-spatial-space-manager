import { Camera, CanvasTexture, Mesh, MeshBasicMaterial, PlaneGeometry, Vector2, Vector3 } from 'three';
import type { Prefs } from '../../../shared/types';
import { canvasTexture, drawIcon, glassCard, makeCanvas, roundRect, UI_FONT, type IconName } from './canvasKit';

const W = 1300;
const H = 940;
/** Panel width in metres and distance in front of the user when opened. */
const PANEL_W = 1.15;
const PANEL_DIST = 1.7;

export type ControlAction =
  | { kind: 'anchor'; anchor: Prefs['anchor'] }
  | { kind: 'recenter' }
  | { kind: 'stereo' }
  | { kind: 'dof' }
  | { kind: 'ambient' }
  | { kind: 'debug' }
  | { kind: 'hands' }
  | { kind: 'handsCamera' }
  | { kind: 'grid' }
  | { kind: 'skybox' }
  | { kind: 'cinema' }
  | { kind: 'seeThrough' }
  | { kind: 'close' };

export interface ControlState {
  anchor: Prefs['anchor'];
  stereo: boolean;
  /** Stereo is being shown on the glasses (vs. a preview on a normal screen). */
  stereoOnGlasses: boolean;
  dof: 3 | 6;
  ambient: boolean;
  debug: boolean;
  /** Hand pointer on, and what it is doing (e.g. "Tracking", "Show a hand"). */
  hands: boolean;
  handsLine: string;
  handsCamera: 'mac' | 'glasses';
  grid: boolean;
  skybox: Prefs['skybox'];
  /** A screen is in cinema mode. */
  cinema: boolean;
  /** See-through on, and what it shows (e.g. "Glasses cam", "Starting…"). */
  seeThrough: boolean;
  seeThroughLine: string;
  /** e.g. "Luma Ultra · 3DoF" or "Waiting for glasses…" */
  deviceLine: string;
}

interface Button {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  sub?: string;
  icon: IconName;
  action: ControlAction;
  on?: boolean;
  /** Row style (icon + label in a list) vs. tile style (icon above label). */
  row?: boolean;
}

/**
 * Viture-style control center: a glass panel that opens in front of the user,
 * with anchor modes, recenter, 3D, 6DoF, scenery, grid, cinema, see-through, hands and debug toggles.
 * Drawn into a canvas; clicks are resolved from the ray hit's UV.
 */
export class ControlCenter {
  readonly mesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private readonly canvas = makeCanvas(W, H);
  private buttons: Button[] = [];
  private hovered: Button | null = null;
  private state: ControlState | null = null;
  private battery: { level: number; charging: boolean } | null = null;
  private lastMinute = -1;

  constructor() {
    this.mesh = new Mesh(
      new PlaneGeometry(PANEL_W, PANEL_W * (H / W)),
      new MeshBasicMaterial({ map: canvasTexture(this.canvas[0]), transparent: true, depthTest: false, toneMapped: false }),
    );
    this.mesh.renderOrder = 50;
    this.mesh.visible = false;
    this.mesh.userData.controlCenter = true;
    const nav = navigator as Navigator & { getBattery?: () => Promise<{ level: number; charging: boolean; addEventListener: (e: string, f: () => void) => void }> };
    void nav.getBattery?.().then((b) => {
      const read = () => {
        this.battery = { level: b.level, charging: b.charging };
        this.redraw();
      };
      b.addEventListener('levelchange', read);
      b.addEventListener('chargingchange', read);
      read();
    });
  }

  get open(): boolean {
    return this.mesh.visible;
  }

  /** Open in front of the user's current gaze (level, at a comfortable distance). */
  show(camera: Camera): void {
    const pos = camera.getWorldPosition(new Vector3());
    const dir = camera.getWorldDirection(new Vector3());
    dir.y = Math.max(-0.35, Math.min(0.2, dir.y));
    dir.normalize();
    this.mesh.position.copy(pos).addScaledVector(dir, PANEL_DIST);
    this.mesh.lookAt(pos);
    this.mesh.visible = true;
    this.redraw();
  }

  hide(): void {
    this.mesh.visible = false;
    this.hovered = null;
  }

  setState(s: ControlState): void {
    this.state = s;
    if (this.open) this.redraw();
  }

  /** Per-frame: keep the clock current. */
  update(): void {
    const m = new Date().getMinutes();
    if (this.open && m !== this.lastMinute) this.redraw();
  }

  /** Hover feedback from a ray hit (uv on the panel) — returns whether a button is under the cursor. */
  hover(uv: Vector2 | null): boolean {
    const b = uv ? this.buttonAt(uv) : null;
    if (b !== this.hovered) {
      this.hovered = b;
      this.redraw();
    }
    return !!b;
  }

  /** Resolve a click at panel uv. */
  click(uv: Vector2): ControlAction | null {
    return this.buttonAt(uv)?.action ?? null;
  }

  private buttonAt(uv: Vector2): Button | null {
    const x = uv.x * W;
    const y = (1 - uv.y) * H;
    return this.buttons.find((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) ?? null;
  }

  private layoutButtons(s: ControlState): Button[] {
    const pad = 40;
    const top = 210;
    const colW = 380;
    const rowH = 118;
    const gx = pad + colW + 26;
    const cols = 4;
    const tileW = (W - gx - pad - (cols - 1) * 22) / cols;
    const rows = 3;
    const tileH = (H - top - pad - (rows - 1) * 22) / rows;
    const anchors: Array<[Prefs['anchor'], string, IconName]> = [
      ['head', 'Head-Locked', 'head'],
      ['smooth', 'Smooth Follow', 'follow'],
      ['spatial', 'Spatial Anchor', 'anchor'],
    ];
    const b: Button[] = anchors.map(([anchor, label, icon], i) => ({
      x: pad + 14,
      y: top + 14 + i * (rowH + 12),
      w: colW - 28,
      h: rowH,
      label,
      icon,
      row: true,
      on: s.anchor === anchor,
      action: { kind: 'anchor', anchor },
    }));
    const tiles: Array<[string, string | undefined, IconName, ControlAction, boolean]> = [
      ['Recenter', undefined, 'recenter', { kind: 'recenter' }, false],
      ['3D', s.stereo ? (s.stereoOnGlasses ? 'On (glasses)' : 'Preview') : 'Off', 'stereo', { kind: 'stereo' }, s.stereo],
      ['6DoF', s.dof === 6 ? 'On' : 'Off (3DoF)', 'dof', { kind: 'dof' }, s.dof === 6],
      ['Scenery', s.ambient ? 'Animated' : 'Still', 'ambient', { kind: 'ambient' }, s.ambient],
      ['Sky', s.skybox === 'off' ? 'Off' : 'Panorama', 'sky', { kind: 'skybox' }, s.skybox !== 'off'],
      ['Grid', s.grid ? 'On' : 'Off', 'grid', { kind: 'grid' }, s.grid],
      ['Cinema', s.cinema ? 'On' : 'Off', 'cinema', { kind: 'cinema' }, s.cinema],
      ['See-through', s.seeThroughLine, 'eye', { kind: 'seeThrough' }, s.seeThrough],
      ['Hands', s.handsLine, 'hand', { kind: 'hands' }, s.hands],
      ['Hand Cam', s.handsCamera === 'glasses' ? 'Glasses' : 'Mac', s.handsCamera === 'glasses' ? 'head' : 'laptop', { kind: 'handsCamera' }, false],
      ['Debug', s.debug ? 'Shown' : 'Hidden', 'debug', { kind: 'debug' }, s.debug],
      ['Close', undefined, 'close', { kind: 'close' }, false],
    ];
    tiles.forEach(([label, sub, icon, action, on], i) => {
      b.push({ x: gx + (i % cols) * (tileW + 22), y: top + Math.floor(i / cols) * (tileH + 22), w: tileW, h: tileH, label, sub, icon, action, on });
    });
    return b;
  }

  private redraw(): void {
    const s = this.state;
    if (!s) return;
    const [, g] = this.canvas;
    g.clearRect(0, 0, W, H);
    glassCard(g, 4, 4, W - 8, H - 8, 56, 0.6);
    this.buttons = this.layoutButtons(s);

    // Header: time, date, device, battery.
    const now = new Date();
    this.lastMinute = now.getMinutes();
    g.fillStyle = '#fff';
    g.textBaseline = 'alphabetic';
    g.font = `600 92px ${UI_FONT}`;
    g.fillText(now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }), 48, 128);
    g.font = `400 32px ${UI_FONT}`;
    g.fillStyle = 'rgba(255,255,255,0.75)';
    g.fillText(now.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }), 52, 176);
    g.fillText(s.deviceLine, 330, 176);
    if (this.battery) {
      const pct = Math.round(this.battery.level * 100);
      const bx = 330;
      const by = 98;
      g.strokeStyle = 'rgba(255,255,255,0.8)';
      g.lineWidth = 3;
      roundRect(g, bx, by, 56, 28, 6);
      g.stroke();
      g.fillStyle = pct <= 20 ? '#ff5a5a' : '#3ddc84';
      roundRect(g, bx + 4, by + 4, 48 * this.battery.level, 20, 3);
      g.fill();
      g.fillStyle = '#fff';
      g.font = `500 30px ${UI_FONT}`;
      g.fillText(`${pct}%${this.battery.charging ? ' ⚡︎' : ''}`, bx + 70, by + 26);
    }

    // Anchor-mode card (left column).
    const a0 = this.buttons[0];
    glassCard(g, a0.x - 14, a0.y - 14, a0.w + 28, 3 * a0.h + 2 * 12 + 28, 36, 0.35);

    for (const b of this.buttons) {
      const hover = b === this.hovered;
      if (!b.row) glassCard(g, b.x, b.y, b.w, b.h, 32, hover ? 0.75 : 0.42);
      else if (hover) {
        roundRect(g, b.x, b.y, b.w, b.h, 26);
        g.fillStyle = 'rgba(255,255,255,0.12)';
        g.fill();
      }
      const badge = b.row ? 34 : 44;
      const cx = b.row ? b.x + 22 + badge : b.x + b.w / 2;
      const cy = b.row ? b.y + b.h / 2 : b.y + b.h * 0.38;
      g.beginPath();
      g.arc(cx, cy, badge, 0, Math.PI * 2);
      g.fillStyle = b.on ? '#2f7cf6' : 'rgba(255,255,255,0.22)';
      g.fill();
      drawIcon(g, b.icon, cx - badge * 0.6, cy - badge * 0.6, badge * 1.2, '#fff');
      g.fillStyle = '#fff';
      g.textAlign = b.row ? 'left' : 'center';
      g.font = `500 ${b.row ? 34 : 32}px ${UI_FONT}`;
      if (b.row) g.fillText(b.label, cx + badge + 22, cy + 12);
      else {
        g.fillText(b.label, cx, b.y + b.h * 0.76);
        if (b.sub) {
          g.font = `400 24px ${UI_FONT}`;
          g.fillStyle = 'rgba(255,255,255,0.65)';
          g.fillText(b.sub, cx, b.y + b.h * 0.76 + 32);
        }
      }
      g.textAlign = 'left';
    }
    (this.mesh.material.map as CanvasTexture).needsUpdate = true;
  }
}
