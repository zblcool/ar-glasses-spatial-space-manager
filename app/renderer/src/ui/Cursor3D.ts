import { Camera, Sprite, SpriteMaterial, Vector3 } from 'three';
import { canvasTexture, makeCanvas } from './canvasKit';

/** Angular size of the dot (fraction of its distance). */
const SIZE = 0.016;
/** The dot shrinks a little while pressed (mouse button / pinch), like Viture's pointer. */
const PRESSED_SCALE = 0.7;
/** Where the dot floats when the ray hits nothing. */
const FREE_DISTANCE = 3;

/**
 * Viture-style pointer: a soft white dot drawn in 3D at whatever the mouse
 * or hand ray hits, so it appears at the right depth in both eyes in stereo mode.
 */
export class Cursor3D {
  readonly sprite: Sprite;
  private readonly tmp = new Vector3();
  private pressed = false;

  constructor() {
    const [c, g] = makeCanvas(64, 64);
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.32, 'rgba(255,255,255,1)');
    grad.addColorStop(0.42, 'rgba(160,190,255,0.55)');
    grad.addColorStop(1, 'rgba(120,160,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    this.sprite = new Sprite(new SpriteMaterial({ map: canvasTexture(c), depthTest: false, depthWrite: false, transparent: true, toneMapped: false }));
    this.sprite.renderOrder = 100;
    this.sprite.visible = false;
  }

  /** Place at a hit point, or along the ray when nothing was hit. */
  place(camera: Camera, hit: Vector3 | null, rayDir: Vector3): void {
    const p = hit ?? this.tmp.copy(rayDir).multiplyScalar(FREE_DISTANCE).add(camera.getWorldPosition(new Vector3()));
    this.sprite.position.copy(p);
    const d = p.distanceTo(camera.getWorldPosition(this.tmp));
    this.sprite.scale.setScalar(d * SIZE * (this.pressed ? PRESSED_SCALE : 1));
    this.sprite.visible = true;
  }

  setPressed(on: boolean): void {
    if (on === this.pressed) return;
    const k = on ? PRESSED_SCALE : 1 / PRESSED_SCALE;
    this.pressed = on;
    this.sprite.scale.multiplyScalar(k);
  }

  hide(): void {
    this.sprite.visible = false;
  }
}
