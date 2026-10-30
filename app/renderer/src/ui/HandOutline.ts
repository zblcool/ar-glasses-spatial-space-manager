import { CanvasTexture, Mesh, MeshBasicMaterial, PerspectiveCamera, PlaneGeometry, Vector2 } from 'three';
import { canvasTexture, makeCanvas } from './canvasKit';

/** Where the outline floats in front of the eyes (m): about where a hand is. */
const DISTANCE = 0.6;
/** Canvas width; the height follows the view's aspect. */
const CANVAS_W = 640;
/** Finger thickness relative to hand size (wrist → middle knuckle). */
const FINGER = 0.2;
const THUMB = 0.24;

/** MediaPipe hand: finger chains (wrist = 0) and the palm polygon. */
const FINGERS = [
  [1, 2, 3, 4],
  [5, 6, 7, 8],
  [9, 10, 11, 12],
  [13, 14, 15, 16],
  [17, 18, 19, 20],
];
const PALM = [0, 1, 5, 9, 13, 17];

/**
 * The tracked hand drawn as a glowing outline (a soft silhouette with a
 * bright rim), like the hand ghosts of other headsets, so you can see what
 * the camera sees. Drawn into a canvas on a plane that fills the view at
 * hand distance, so it sits in front of everything (and at hand depth in
 * stereo). The pointer dot stays the precise target.
 */
export class HandOutline {
  readonly mesh: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  /** Interior silhouette, drawn opaque here and composited faintly (no overlap seams). */
  private readonly fill = makeCanvas(CANVAS_W, CANVAS_W);
  private readonly px: Array<{ x: number; y: number }> = Array.from({ length: 21 }, () => ({ x: 0, y: 0 }));

  constructor(private readonly camera: PerspectiveCamera) {
    [this.canvas, this.g] = makeCanvas(CANVAS_W, CANVAS_W);
    this.mesh = new Mesh(
      new PlaneGeometry(1, 1),
      new MeshBasicMaterial({ map: canvasTexture(this.canvas), transparent: true, depthTest: false, depthWrite: false, toneMapped: false }),
    );
    this.mesh.position.z = -DISTANCE;
    this.mesh.renderOrder = 90; // over the scene, under the pointer dot
    this.mesh.visible = false;
    this.mesh.frustumCulled = false;
  }

  /** Draw a hand (21 landmarks in view NDC), or hide when null. */
  update(points: Vector2[] | null, pinched: boolean): void {
    if (!points) {
      this.mesh.visible = false;
      return;
    }
    // Fill the view at DISTANCE (aspect / FOV may change with stereo or display).
    const h = 2 * DISTANCE * Math.tan((this.camera.fov * Math.PI) / 360);
    const w = h * this.camera.aspect;
    this.mesh.scale.set(w, h, 1);
    const cw = CANVAS_W;
    const ch = Math.max(1, Math.round(CANVAS_W / this.camera.aspect));
    if (this.canvas.height !== ch) {
      // A resized canvas needs a new GPU texture.
      this.canvas.height = this.fill[0].height = ch;
      this.mesh.material.map?.dispose();
      this.mesh.material.map = canvasTexture(this.canvas);
    }

    points.forEach((p, i) => {
      this.px[i].x = ((p.x + 1) / 2) * cw;
      this.px[i].y = ((1 - p.y) / 2) * ch;
    });
    const size = Math.hypot(this.px[9].x - this.px[0].x, this.px[9].y - this.px[0].y);
    const rim = Math.max(2, size * 0.035);

    // Silhouette (opaque) into the fill canvas.
    const [, f] = this.fill;
    f.clearRect(0, 0, cw, ch);
    this.shape(f, size, 0, '#fff');

    const g = this.g;
    g.clearRect(0, 0, cw, ch);
    // Rim: the silhouette grown by `rim`, with a glow, then the silhouette cut out of it.
    g.save();
    g.shadowColor = pinched ? 'rgba(255,255,255,0.9)' : 'rgba(95,232,255,0.9)';
    g.shadowBlur = rim * 4;
    this.shape(g, size, rim * 2, pinched ? '#ffffff' : '#7fefff');
    g.restore();
    g.globalCompositeOperation = 'destination-out';
    g.drawImage(this.fill[0], 0, 0);
    // Faint interior.
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = pinched ? 0.22 : 0.12;
    g.drawImage(this.fill[0], 0, 0);
    g.globalAlpha = 1;

    (this.mesh.material.map as CanvasTexture).needsUpdate = true;
    this.mesh.visible = true;
  }

  /** The hand's silhouette: palm polygon plus round-capped finger strokes, grown by `grow` px. */
  private shape(g: CanvasRenderingContext2D, size: number, grow: number, color: string): void {
    const p = this.px;
    g.strokeStyle = g.fillStyle = color;
    g.lineCap = g.lineJoin = 'round';
    g.beginPath();
    PALM.forEach((i, k) => (k ? g.lineTo(p[i].x, p[i].y) : g.moveTo(p[i].x, p[i].y)));
    g.closePath();
    g.lineWidth = size * FINGER + grow;
    g.fill();
    g.stroke();
    FINGERS.forEach((chain, k) => {
      g.lineWidth = size * (k === 0 ? THUMB : FINGER) * (k === 4 ? 0.85 : 1) + grow;
      g.beginPath();
      g.moveTo(p[k === 0 ? 0 : chain[0]].x, p[k === 0 ? 0 : chain[0]].y);
      for (const i of chain) g.lineTo(p[i].x, p[i].y);
      g.stroke();
    });
  }
}
