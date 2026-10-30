import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  Points,
  PointsMaterial,
  Sprite,
  SpriteMaterial,
  Vector3,
} from 'three';
import { canvasTexture, makeCanvas } from '../ui/canvasKit';

/**
 * Moving scenery in front of the (flat) panorama, at several depths, so head
 * movement, stereo and 6DoF have something to separate:
 *   - clouds drifting far away (~200–320 m),
 *   - a flock of birds gliding on wide loops (~18–55 m),
 *   - faint floating motes behind the screens (~3–10 m).
 */
export class Ambient {
  readonly group = new Group();
  private readonly clouds: Array<{ sprite: Sprite; radius: number; angle: number; height: number; speed: number }> = [];
  private readonly birds: Array<{ bird: Group; wings: Mesh[]; radius: number; angle: number; height: number; speed: number; phase: number; wobble: number }> = [];
  private readonly motes: Points;
  private readonly moteSeeds: Float32Array;
  private readonly moteBase: Float32Array;

  constructor() {
    this.buildClouds();
    this.buildBirds();
    const { points, seeds, base } = this.buildMotes();
    this.motes = points;
    this.moteSeeds = seeds;
    this.moteBase = base;
    this.group.add(this.motes);
  }

  set enabled(on: boolean) {
    this.group.visible = on;
  }

  get enabled(): boolean {
    return this.group.visible;
  }

  update(t: number, dt: number): void {
    if (!this.group.visible) return;
    for (const c of this.clouds) {
      c.angle += c.speed * dt;
      c.sprite.position.set(Math.sin(c.angle) * c.radius, c.height, -Math.cos(c.angle) * c.radius);
    }
    const prev = new Vector3();
    for (const b of this.birds) {
      prev.copy(b.bird.position);
      b.angle += b.speed * dt;
      // Loops that breathe in and out, so the flock occasionally passes closer.
      const r = b.radius * (1 + 0.25 * Math.sin(t * 0.07 + b.phase));
      b.bird.position.set(Math.sin(b.angle) * r, b.height + Math.sin(t * 0.5 + b.phase) * b.wobble, -Math.cos(b.angle) * r);
      // lookAt aims +Z; the bird's nose is at -Z, so aim +Z back at where it was.
      if (dt > 0) b.bird.lookAt(prev);
      const flap = Math.sin(t * 9 + b.phase) * 0.55;
      b.wings[0].rotation.z = flap;
      b.wings[1].rotation.z = -flap;
    }
    const pos = this.motes.geometry.getAttribute('position') as BufferAttribute;
    const arr = pos.array as Float32Array;
    for (let i = 0; i < arr.length; i += 3) {
      const s = this.moteSeeds[i / 3];
      arr[i] = this.moteBase[i] + Math.sin(t * 0.13 + s * 7) * 0.35;
      arr[i + 1] = this.moteBase[i + 1] + Math.sin(t * 0.09 + s * 13) * 0.25;
      arr[i + 2] = this.moteBase[i + 2] + Math.cos(t * 0.11 + s * 5) * 0.35;
    }
    pos.needsUpdate = true;
  }

  private buildClouds(): void {
    for (let k = 0; k < 4; k++) {
      const tex = canvasTexture(cloudCanvas(k));
      for (let i = 0; i < 4; i++) {
        const mat = new SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.5 + Math.random() * 0.3, toneMapped: false });
        const sprite = new Sprite(mat);
        const w = 70 + Math.random() * 90;
        sprite.scale.set(w, w * 0.45, 1);
        sprite.renderOrder = -0.5;
        this.group.add(sprite);
        this.clouds.push({
          sprite,
          radius: 200 + Math.random() * 120,
          angle: Math.random() * Math.PI * 2,
          height: 55 + Math.random() * 110,
          speed: 0.004 + Math.random() * 0.004, // rad/s, all with the same wind
        });
      }
    }
  }

  private buildBirds(): void {
    const mat = new MeshBasicMaterial({ color: 0x23262d, side: DoubleSide, toneMapped: false });
    const body = new BufferGeometry();
    body.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, -0.35, 0.06, 0, 0.3, -0.06, 0, 0.3]), 3));
    // One wing in local +X; the other is the same mesh mirrored.
    const wingGeo = new BufferGeometry();
    wingGeo.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, -0.12, 0.7, 0.05, 0.1, 0, 0, 0.18]), 3));
    const flockAngle = Math.random() * Math.PI * 2;
    for (let i = 0; i < 11; i++) {
      const bird = new Group();
      bird.add(new Mesh(body, mat));
      const left = new Mesh(wingGeo, mat);
      const right = new Mesh(wingGeo, mat);
      right.scale.x = -1;
      bird.add(left, right);
      bird.scale.setScalar(0.9 + Math.random() * 0.6);
      this.group.add(bird);
      this.birds.push({
        bird,
        wings: [left, right],
        radius: 18 + Math.random() * 37,
        angle: flockAngle + (Math.random() - 0.5) * 0.5,
        height: 7 + Math.random() * 10,
        speed: 0.05 + Math.random() * 0.02,
        phase: Math.random() * 10,
        wobble: 0.6 + Math.random(),
      });
    }
  }

  private buildMotes() {
    const n = 260;
    const base = new Float32Array(n * 3);
    const seeds = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      // Spherical shell 3–10 m: behind the screens, so they never cover text.
      const r = 3 + Math.random() * 7;
      const th = Math.random() * Math.PI * 2;
      const ph = Math.acos(Math.random() * 1.4 - 0.7);
      base[i * 3] = r * Math.sin(ph) * Math.cos(th);
      base[i * 3 + 1] = r * Math.cos(ph);
      base[i * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
      seeds[i] = Math.random();
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(base.slice(), 3));
    const [c, g] = makeCanvas(32, 32);
    const grad = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, 'rgba(255,250,235,1)');
    grad.addColorStop(1, 'rgba(255,250,235,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 32, 32);
    const mat = new PointsMaterial({
      map: canvasTexture(c),
      size: 0.05,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      blending: AdditiveBlending,
      toneMapped: false,
    });
    return { points: new Points(geo, mat), seeds, base };
  }
}

/** Soft procedural cloud: overlapping radial puffs, slightly shaded underneath. */
function cloudCanvas(seed: number): HTMLCanvasElement {
  const [c, g] = makeCanvas(512, 230);
  let s = seed * 9301 + 49297;
  const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  for (let i = 0; i < 26; i++) {
    const x = 90 + rnd() * 330;
    const y = 95 + (rnd() - 0.5) * 70;
    const r = 40 + rnd() * 60;
    const grad = g.createRadialGradient(x, y - r * 0.2, 0, x, y, r);
    grad.addColorStop(0, 'rgba(255,255,255,0.55)');
    grad.addColorStop(0.6, 'rgba(240,244,250,0.25)');
    grad.addColorStop(1, 'rgba(225,232,242,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 512, 230);
  }
  return c;
}
