import { CanvasTexture, Color, Group, MathUtils, Matrix4, Mesh, MeshBasicMaterial, PlaneGeometry, Vector3 } from 'three';
import { canvasTexture, drawIcon, glassCard, makeCanvas, roundedAlphaMap, UI_FONT, type IconName } from '../ui/canvasKit';
import type { ScreenSource } from './ScreenSource';

/** Persisted transform of one screen, relative to the workspace. Angles in degrees, sizes in metres. */
export interface ScreenLayout {
  id: string;
  /** Heading around the user; positive = to the left. */
  yaw: number;
  /** Elevation; positive = up. */
  pitch: number;
  /** Distance from the user to the screen centre. */
  distance: number;
  width: number;
  height: number;
  /** When true, resizing preserves width/height ratio. */
  aspectLocked: boolean;
}

export const LIMITS = {
  minSize: 0.2,
  /** Big enough for a cinema screen far away (see push()). */
  maxSize: 40,
  minDistance: 0.6,
  maxDistance: 60,
  maxPitch: 80,
};

const BORDER_IDLE = new Color('#ffffff');
const BORDER_SELECTED = new Color('#8fc3ff');
const BORDER_ACTIVE = new Color('#3ddc84');
const SIZE_LABEL_MS = 1400;
/** Resize arcs sit on the two bottom corners. */
const CORNERS: Array<[number, number]> = [
  [-1, -1],
  [1, -1],
];
const ORIGIN = new Vector3();
const UP = new Vector3(0, 1, 0);
const PLANE = new PlaneGeometry(1, 1);

/** The white quarter-circle resize arc, drawn for the bottom-right corner. */
function arcTexture(): CanvasTexture {
  const [c, g] = makeCanvas(128, 128);
  g.strokeStyle = 'rgba(255,255,255,0.95)';
  g.lineWidth = 14;
  g.lineCap = 'round';
  g.shadowColor = 'rgba(0,0,0,0.35)';
  g.shadowBlur = 8;
  g.beginPath();
  g.arc(20, 20, 84, 0.08 * Math.PI, 0.42 * Math.PI);
  g.stroke();
  return canvasTexture(c);
}
let ARC: CanvasTexture | null = null;

/**
 * A flat screen floating on a sphere around the user, always facing the
 * workspace origin. Content comes from a ScreenSource texture.
 */
export class VirtualScreen {
  readonly group = new Group();
  readonly content: Mesh<PlaneGeometry, MeshBasicMaterial>;
  /** Icon + name pill above the screen; drag it to move the screen. */
  readonly pill: Mesh<PlaneGeometry, MeshBasicMaterial>;
  /** Resize arcs (bottom corners). */
  readonly handles: Mesh<PlaneGeometry, MeshBasicMaterial>[] = [];
  private readonly border: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private readonly sizeLabel: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private readonly pillCanvas = makeCanvas(640, 112);
  private readonly sizeCanvas = makeCanvas(256, 112);
  private readonly lookMatrix = new Matrix4();
  private pillKey = '';
  private sizeShownAt = -Infinity;
  private selected = false;
  private active = false;
  private hover = false;
  icon: IconName = 'display';

  constructor(
    public layout: ScreenLayout,
    readonly source: ScreenSource,
  ) {
    this.border = new Mesh(
      PLANE,
      new MeshBasicMaterial({ color: BORDER_IDLE, transparent: true, opacity: 0.1, depthWrite: false, toneMapped: false }),
    );
    this.border.position.z = -0.004;

    this.content = new Mesh(PLANE, new MeshBasicMaterial({ map: source.texture, transparent: true, toneMapped: false }));
    this.content.userData.screen = this;

    this.pill = new Mesh(
      PLANE,
      new MeshBasicMaterial({ map: canvasTexture(this.pillCanvas[0]), transparent: true, depthWrite: false, toneMapped: false }),
    );
    this.pill.userData.screen = this;
    this.pill.userData.pill = true;

    ARC ??= arcTexture();
    for (const [sx, sy] of CORNERS) {
      const h = new Mesh(PLANE, new MeshBasicMaterial({ map: ARC, transparent: true, depthTest: false, toneMapped: false }));
      h.userData.screen = this;
      h.userData.corner = [sx, sy];
      h.renderOrder = 10;
      h.visible = false;
      this.handles.push(h);
    }

    this.sizeLabel = new Mesh(
      PLANE,
      new MeshBasicMaterial({ map: canvasTexture(this.sizeCanvas[0]), transparent: true, depthTest: false, toneMapped: false }),
    );
    this.sizeLabel.renderOrder = 11;
    this.sizeLabel.visible = false;

    this.group.add(this.border, this.content, this.pill, this.sizeLabel, ...this.handles);
    this.apply();
  }

  get id(): string {
    return this.layout.id;
  }

  get aspect(): number {
    return this.layout.width / this.layout.height;
  }

  setSelected(on: boolean): void {
    this.selected = on;
    this.refreshChrome();
  }

  /** The real cursor is on this screen's display. */
  setActive(on: boolean): void {
    if (on === this.active) return;
    this.active = on;
    this.refreshChrome();
  }

  setHover(on: boolean): void {
    if (on === this.hover) return;
    this.hover = on;
    this.refreshChrome();
  }

  /** Flash the diagonal size (in inches) on the screen, like Viture's resize readout. */
  showSize(): void {
    this.sizeShownAt = performance.now();
    const inches = Math.hypot(this.layout.width, this.layout.height) / 0.0254;
    const [c, g] = this.sizeCanvas;
    g.clearRect(0, 0, c.width, c.height);
    g.font = `600 84px ${UI_FONT}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.shadowColor = 'rgba(0,0,0,0.55)';
    g.shadowBlur = 12;
    g.fillStyle = '#fff';
    g.fillText(`${Math.round(inches)}″`, c.width / 2, c.height / 2);
    (this.sizeLabel.material.map as CanvasTexture).needsUpdate = true;
    this.sizeLabel.visible = true;
  }

  /** Per-frame: follow source texture swaps (status card → live video), refresh the pill, fade the size label. */
  update(): void {
    if (this.content.material.map !== this.source.texture) {
      this.content.material.map = this.source.texture;
      this.content.material.needsUpdate = true;
    }
    const pillKey = `${this.source.label}|${this.icon}|${this.active}`;
    if (pillKey !== this.pillKey) this.drawPill(pillKey);
    if (this.sizeLabel.visible && performance.now() - this.sizeShownAt > SIZE_LABEL_MS) this.sizeLabel.visible = false;
  }

  private refreshChrome(): void {
    const m = this.border.material;
    m.color.copy(this.active ? BORDER_ACTIVE : this.selected ? BORDER_SELECTED : BORDER_IDLE);
    m.opacity = this.active ? 0.85 : this.selected ? 0.7 : this.hover ? 0.35 : 0.1;
    for (const h of this.handles) h.visible = this.selected || this.hover;
    this.apply();
  }

  private drawPill(key: string): void {
    this.pillKey = key;
    const [c, g] = this.pillCanvas;
    g.clearRect(0, 0, c.width, c.height);
    g.font = `600 44px ${UI_FONT}`;
    const label = this.active ? `${this.source.label} · ⌃⌥⎋` : this.source.label;
    const textW = Math.min(g.measureText(label).width, c.width - 150);
    const w = textW + 140;
    const x = (c.width - w) / 2;
    glassCard(g, x, 8, w, 96, 48, 0.62);
    // Icon in a white circle, like the app badges on Viture's panels.
    g.fillStyle = this.active ? '#3ddc84' : '#ffffff';
    g.beginPath();
    g.arc(x + 54, 56, 34, 0, Math.PI * 2);
    g.fill();
    drawIcon(g, this.icon, x + 34, 36, 40, '#1b2230');
    g.fillStyle = '#fff';
    g.textBaseline = 'middle';
    g.fillText(label, x + 104, 58, textW);
    (this.pill.material.map as CanvasTexture).needsUpdate = true;
  }

  /** Clamp the layout and push it into the scene graph (relative to the workspace). */
  apply(): void {
    const l = this.layout;
    l.width = MathUtils.clamp(l.width, LIMITS.minSize, LIMITS.maxSize);
    l.height = MathUtils.clamp(l.height, LIMITS.minSize, LIMITS.maxSize);
    l.distance = MathUtils.clamp(l.distance, LIMITS.minDistance, LIMITS.maxDistance);
    l.pitch = MathUtils.clamp(l.pitch, -LIMITS.maxPitch, LIMITS.maxPitch);
    l.yaw = ((((l.yaw + 180) % 360) + 360) % 360) - 180;

    // Face the workspace origin, in workspace-local space (independent of how the workspace is rotated).
    this.group.position.copy(directionFromAngles(l.yaw, l.pitch)).multiplyScalar(l.distance);
    this.group.quaternion.setFromRotationMatrix(this.lookMatrix.lookAt(ORIGIN, this.group.position, UP));

    this.content.scale.set(l.width, l.height, 1);
    // Chrome keeps a constant angular size (readable at any distance), but never
    // grows past a fraction of the screen itself: a screen pushed far away
    // should look like a small far object, not a small panel with a huge frame.
    const side = Math.min(l.width, l.height);
    const chrome = (perMetre: number, ofScreen: number) => Math.min(perMetre * l.distance, ofScreen * side);
    const rim = chrome(this.selected || this.active ? 0.012 : 0.008, this.selected || this.active ? 0.03 : 0.02);
    const rounded = roundedAlphaMap(this.aspect);
    if (this.content.material.alphaMap !== rounded) {
      this.content.material.alphaMap = rounded;
      this.content.material.needsUpdate = true;
    }
    const borderMap = roundedAlphaMap((l.width + rim * 2) / (l.height + rim * 2));
    if (this.border.material.alphaMap !== borderMap) {
      this.border.material.alphaMap = borderMap;
      this.border.material.needsUpdate = true;
    }
    // Soft glass rim; thickness scales with distance so it reads the same at any depth.
    this.border.scale.set(l.width + rim * 2, l.height + rim * 2, 1);

    // Pill: constant angular size, centred above the screen.
    const pillH = chrome(0.05, 0.14);
    this.pill.scale.set(pillH * (640 / 112), pillH, 1);
    this.pill.position.set(0, l.height / 2 + rim + pillH * 0.75, 0.002);

    const hs = chrome(0.07, 0.2);
    this.handles.forEach((h, i) => {
      const [sx, sy] = CORNERS[i];
      h.scale.set(sx * hs, hs, 1); // negative x mirrors the arc for the left corner
      h.position.set(sx * (l.width / 2 + hs * 0.18), sy * (l.height / 2 + hs * 0.18), 0.004);
    });

    const sl = chrome(0.09, 0.25);
    this.sizeLabel.scale.set(sl * (256 / 112), sl, 1);
    this.sizeLabel.position.set(0, l.height / 2 - sl * 0.9, 0.006);
  }

  /** Resize keeping the centre fixed. Preserves the aspect ratio when aspectLocked. */
  resize(width: number, height: number): void {
    if (this.layout.aspectLocked) {
      const a = this.aspect;
      const sw = width / this.layout.width;
      const sh = height / this.layout.height;
      const s = Math.abs(sw - 1) >= Math.abs(sh - 1) ? sw : sh;
      width = this.layout.width * s;
      height = width / a;
      const k = Math.min(1, LIMITS.maxSize / Math.max(width, height));
      const m = Math.max(1, LIMITS.minSize / Math.min(width * k, height * k));
      width *= k * m;
      height *= k * m;
    }
    this.layout.width = width;
    this.layout.height = height;
    this.apply();
  }

  scaleBy(s: number): void {
    const a = this.aspect;
    let w = this.layout.width * s;
    w = MathUtils.clamp(w, LIMITS.minSize * Math.max(1, a), LIMITS.maxSize * Math.min(1, a));
    this.layout.width = w;
    this.layout.height = w / a;
    this.apply();
  }

  /** Match a new content aspect (e.g. the display changed resolution). */
  fitAspect(aspect: number): void {
    if (!this.layout.aspectLocked || Math.abs(this.aspect / aspect - 1) < 0.01) return;
    this.layout.height = this.layout.width / aspect;
    this.apply();
  }

  dispose(): void {
    this.content.material.dispose();
    this.border.material.dispose();
    this.pill.material.map?.dispose();
    this.pill.material.dispose();
    this.sizeLabel.material.map?.dispose();
    this.sizeLabel.material.dispose();
    for (const h of this.handles) h.material.dispose();
    this.group.removeFromParent();
    this.source.dispose();
  }
}

/** Unit vector for yaw (left-positive) and pitch (up-positive), forward = -Z. */
export function directionFromAngles(yawDeg: number, pitchDeg: number, out = new Vector3()): Vector3 {
  const yaw = MathUtils.degToRad(yawDeg);
  const pitch = MathUtils.degToRad(pitchDeg);
  return out.set(-Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw) * Math.cos(pitch));
}

export function anglesFromDirection(dir: Vector3): { yaw: number; pitch: number } {
  const d = dir.clone().normalize();
  return {
    yaw: MathUtils.radToDeg(Math.atan2(-d.x, -d.z)),
    pitch: MathUtils.radToDeg(Math.asin(MathUtils.clamp(d.y, -1, 1))),
  };
}
