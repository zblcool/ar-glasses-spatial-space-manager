import { CanvasTexture, Mesh, MeshBasicMaterial, PerspectiveCamera, PlaneGeometry } from 'three';
import { canvasTexture, glassCard, makeCanvas, UI_FONT } from './canvasKit';

const W = 1600;
const H = 1000;
const DIST = 1.2;

export interface HudContent {
  status: string;
  statusColor: string;
  toast: string | null;
  debug: string | null;
}

/**
 * Head-locked heads-up display rendered in 3D. HTML overlays only work for a
 * single (mono) view; in side-by-side stereo they would land in one eye, so
 * the same status/toast/debug text is drawn here instead.
 */
export class Hud {
  readonly mesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private readonly canvas = makeCanvas(W, H);
  private key = '';

  constructor(private readonly camera: PerspectiveCamera) {
    this.mesh = new Mesh(
      new PlaneGeometry(1, 1),
      new MeshBasicMaterial({ map: canvasTexture(this.canvas[0]), transparent: true, depthTest: false, depthWrite: false, toneMapped: false }),
    );
    this.mesh.renderOrder = 200;
    this.mesh.position.set(0, 0, -DIST);
    this.mesh.visible = false;
    camera.add(this.mesh);
  }

  set visible(on: boolean) {
    this.mesh.visible = on;
  }

  /** Fit the plane inside ~85% of the (per-eye) view, whichever of width/height is tighter. */
  fit(): void {
    const visH = 2 * DIST * Math.tan((this.camera.fov * Math.PI) / 360);
    const visW = visH * this.camera.aspect;
    const h = Math.min(visH, visW / (W / H)) * 0.85;
    this.mesh.scale.set(h * (W / H), h, 1);
  }

  draw(c: HudContent): void {
    const key = JSON.stringify(c);
    if (key === this.key) return;
    this.key = key;
    const [, g] = this.canvas;
    g.clearRect(0, 0, W, H);
    g.textBaseline = 'middle';

    // Status pill, top right.
    g.font = `500 34px ${UI_FONT}`;
    const sw = g.measureText(c.status).width + 80;
    glassCard(g, W - sw - 10, 10, sw, 64, 32, 0.7);
    g.fillStyle = c.statusColor;
    g.beginPath();
    g.arc(W - sw + 22, 42, 9, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#fff';
    g.fillText(c.status, W - sw + 44, 43);

    if (c.debug) {
      g.font = `28px ui-monospace, Menlo, monospace`;
      const lines = c.debug.split('\n');
      glassCard(g, 10, 10, 640, lines.length * 36 + 28, 20, 0.7);
      g.fillStyle = '#e8eef7';
      lines.forEach((l, i) => g.fillText(l, 28, 32 + i * 36));
    }

    if (c.toast) {
      g.font = `500 34px ${UI_FONT}`;
      const tw = g.measureText(c.toast).width + 60;
      glassCard(g, (W - tw) / 2, H - 100, tw, 70, 35, 0.75);
      g.fillStyle = '#fff';
      g.textAlign = 'center';
      g.fillText(c.toast, W / 2, H - 64);
      g.textAlign = 'left';
    }
    (this.mesh.material.map as CanvasTexture).needsUpdate = true;
  }
}
