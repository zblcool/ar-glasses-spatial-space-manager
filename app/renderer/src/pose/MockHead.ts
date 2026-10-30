import { Euler, MathUtils, Quaternion } from 'three';
import type { PoseSample } from '../../../shared/types';
import { epochNow } from '../vow';

const RATE_HZ = 120;
const DEG_PER_PX = 0.15;

/**
 * Fake head orientation driven by mouse drag (yaw/pitch). Emits PoseSamples at
 * a fixed rate, exactly like the native helper, so the rest of the pipeline is
 * identical in mock and real mode.
 */
export class MockHead {
  yaw = 0; // degrees, positive = turn left
  pitch = 0; // degrees, positive = look up
  /**
   * Whether mouse-look drives the camera. Always true in mock mode; in real
   * mode it is switched on only while the glasses are not tracking.
   */
  enabled = true;
  private timer: number | null = null;
  private readonly euler = new Euler(0, 0, 0, 'YXZ');
  private readonly q = new Quaternion();

  constructor(private readonly emit: (pose: PoseSample) => void) {}

  start(): void {
    this.timer = window.setInterval(() => this.enabled && this.tick(), 1000 / RATE_HZ);
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** Apply a mouse drag delta in CSS pixels ("grab the world" feel). */
  drag(dx: number, dy: number): void {
    if (!this.enabled) return;
    this.yaw += dx * DEG_PER_PX;
    this.pitch = MathUtils.clamp(this.pitch + dy * DEG_PER_PX, -85, 85);
    this.tick();
  }

  private tick(): void {
    this.euler.set(MathUtils.degToRad(this.pitch), MathUtils.degToRad(this.yaw), 0);
    this.q.setFromEuler(this.euler);
    this.emit({ t: epochNow(), q: [this.q.x, this.q.y, this.q.z, this.q.w] });
  }
}
