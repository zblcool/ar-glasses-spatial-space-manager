import { Camera, MathUtils, Quaternion, Vector3 } from 'three';
import type { PoseSample } from '../../../shared/types';
import { epochNow } from '../vow';

const WINDOW_MS = 1000;
const UP = new Vector3(0, 1, 0);

/**
 * Turns PoseSamples into a camera transform: smoothing (frame-rate independent
 * slerp), yaw-only recentering, and the latency/rate statistics shown in the
 * debug overlay.
 */
export class HeadTracker {
  /**
   * Fraction of the remaining error kept per 1/60 s. 0 = no smoothing (lowest
   * latency); 0.9 = heavy smoothing. Converted to a time constant so the result
   * does not depend on the render frame rate.
   */
  smoothing = 0.2;

  private readonly target = new Quaternion();
  private readonly current = new Quaternion();
  private readonly recenter = new Quaternion();
  private readonly targetPos = new Vector3();
  private readonly currentPos = new Vector3();
  private readonly originPos = new Vector3();
  private hasPose = false;
  private hasPosition = false;
  private latest: PoseSample | null = null;

  // Stats (rolling 1 s windows).
  private arrivals: number[] = [];
  private transit: number[] = [];
  private ages: number[] = [];

  push(sample: PoseSample): void {
    const [x, y, z, w] = sample.q;
    this.target.set(x, y, z, w).normalize();
    if (sample.p) {
      this.targetPos.fromArray(sample.p);
      this.hasPosition = true;
    }
    if (!this.hasPose) {
      this.current.copy(this.target);
      this.currentPos.copy(this.targetPos);
      this.hasPose = true;
    }
    this.latest = sample;
    const now = epochNow();
    this.arrivals.push(now);
    this.transit.push(now - sample.t);
  }

  /** Set the current heading as "forward" (yaw only; pitch/roll stay gravity-aligned). */
  recenterNow(): void {
    const fwd = new Vector3(0, 0, -1).applyQuaternion(this.target);
    const yaw = Math.atan2(-fwd.x, -fwd.z);
    this.recenter.setFromAxisAngle(UP, -yaw);
    this.originPos.copy(this.targetPos);
  }

  /** Advance smoothing by dt seconds and write the result into the camera. */
  update(camera: Camera, dt: number): void {
    if (!this.hasPose) return;
    const keep = MathUtils.clamp(this.smoothing, 0, 0.99);
    const alpha = keep === 0 ? 1 : 1 - Math.pow(keep, dt * 60);
    this.current.slerp(this.target, alpha);
    this.currentPos.lerp(this.targetPos, alpha);

    camera.quaternion.copy(this.recenter).multiply(this.current);
    if (this.hasPosition) {
      camera.position.copy(this.currentPos).sub(this.originPos).applyQuaternion(this.recenter);
    }

    if (this.latest) this.ages.push(epochNow() - this.latest.t);
  }

  stats() {
    const now = epochNow();
    const cutoff = now - WINDOW_MS;
    // Keep transit/age arrays bounded to roughly the same window.
    while (this.arrivals.length && this.arrivals[0] < cutoff) {
      this.arrivals.shift();
      this.transit.shift();
    }
    const ages = this.ages.splice(0);
    const transit = this.transit;
    return {
      rateHz: this.arrivals.length * (1000 / WINDOW_MS),
      ageMean: mean(ages),
      ageP95: percentile(ages, 0.95),
      transitMean: mean(transit),
      hasPosition: this.hasPosition,
      lastSampleAge: this.latest ? now - this.latest.t : NaN,
    };
  }
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}

function percentile(xs: number[], p: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))];
}
