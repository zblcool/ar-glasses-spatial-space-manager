import { AdditiveBlending, CircleGeometry, Color, Group, Mesh, MeshBasicMaterial, PlaneGeometry, Quaternion, ShaderMaterial, Texture, Vector3 } from 'three';
import type { VirtualScreen } from '../screens/VirtualScreen';
import { canvasTexture, makeCanvas } from '../ui/canvasKit';

/** Floor height below the eyes (m): roughly a seated / standing eye height. */
export const FLOOR_Y = -1.5;
/** How far the grid reaches; it fades out well before the edge, into the horizon. */
const RADIUS = 600;
/** Footprint depth (m, front to back) of the glow under each screen. */
const FOOTPRINT_DEPTH = 0.5;

/**
 * A glowing wireframe floor that runs off to the horizon, after the "edge of
 * the simulation" grids in The Thirteenth Floor and Tron: fine lines every
 * 2 m, brighter major lines every 10 m, a scan wave that sweeps outward from
 * you every few seconds, and a glow where the grid meets the horizon.
 *
 * Mostly a depth cue: lines converging to the horizon (perspective), and
 * screens standing at a visible spot on the floor, make a big far screen
 * read as far rather than merely close and small. Each screen also casts a
 * glowing footprint on the floor right below it, so you can see where in the
 * room it stands as you push it back or pull it in.
 */
export class Grid {
  readonly mesh: Mesh<CircleGeometry, ShaderMaterial>;
  /** Footprints live in world space (the floor), not under the grid mesh, which is rotated flat. */
  readonly footprints = new Group();
  private readonly prints: Mesh<PlaneGeometry, MeshBasicMaterial>[] = [];
  private footprintTex: Texture | null = null;

  constructor() {
    const material = new ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: new Color('#5fe8ff') },
        uRadius: { value: RADIUS },
      },
      vertexShader: /* glsl */ `
        varying vec2 vXZ;
        void main() {
          vec4 world = modelMatrix * vec4(position, 1.0);
          vXZ = world.xz;
          gl_Position = projectionMatrix * viewMatrix * world;
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform vec3 uColor;
        uniform float uRadius;
        varying vec2 vXZ;

        // Anti-aliased grid line intensity for a given cell size.
        float lines(vec2 p, float cell, float width) {
          vec2 g = abs(fract(p / cell - 0.5) - 0.5) * cell;
          vec2 w = fwidth(p) * width;
          vec2 l = 1.0 - smoothstep(vec2(0.0), w, g);
          // Fade lines out when cells shrink below a pixel (no moire near the horizon).
          float fade = 1.0 - smoothstep(0.25, 0.6, max(fwidth(p).x, fwidth(p).y) / cell);
          return max(l.x, l.y) * fade;
        }

        void main() {
          float r = length(vXZ);
          float minor = lines(vXZ, 2.0, 1.5) * 0.55;
          float major = lines(vXZ, 10.0, 2.5);
          // Scan wave: a bright ring sweeping out from the user, every 6 s.
          float wave = fract(uTime / 6.0) * 160.0;
          float scan = exp(-pow((r - wave) / 3.0, 2.0)) * (1.0 - wave / 160.0);
          float grid = max(minor, major) * (0.9 + 1.8 * scan) + scan * 0.12;
          // Gentle near-field fade (don't draw lines under your feet), long fade into the haze.
          float near = smoothstep(1.0, 4.0, r);
          float far = 1.0 - smoothstep(uRadius * 0.15, uRadius * 0.6, r);
          // Horizon glow: a soft band the grid dissolves into.
          float horizon = smoothstep(uRadius * 0.08, uRadius * 0.5, r) * far * 0.22;
          float a = (grid * near * far) + horizon;
          gl_FragColor = vec4(uColor * a, a);
        }`,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      toneMapped: false,
    });
    this.mesh = new Mesh(new CircleGeometry(RADIUS, 96), material);
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.position.y = FLOOR_Y;
    this.mesh.renderOrder = -0.4; // after the panorama, before screens
  }

  set enabled(on: boolean) {
    this.mesh.visible = on;
    this.footprints.visible = on;
  }

  get enabled(): boolean {
    return this.mesh.visible;
  }

  update(t: number, screens: VirtualScreen[]): void {
    if (!this.mesh.visible) return;
    this.mesh.material.uniforms.uTime.value = t;
    const pos = new Vector3();
    const right = new Vector3();
    const q = new Quaternion();
    screens.forEach((s, i) => {
      const m = (this.prints[i] ??= this.newFootprint());
      s.group.getWorldPosition(pos);
      right.set(1, 0, 0).applyQuaternion(s.group.getWorldQuaternion(q));
      m.position.set(pos.x, FLOOR_Y + 0.01, pos.z);
      m.rotation.set(-Math.PI / 2, 0, 0);
      m.rotateOnWorldAxis(new Vector3(0, 1, 0), Math.atan2(-right.z, right.x));
      m.scale.set(s.layout.width * 1.1, FOOTPRINT_DEPTH, 1);
      // Fainter when the screen floats far above the floor.
      const gap = pos.y - s.layout.height / 2 - FLOOR_Y;
      m.material.opacity = 0.9 / (1 + Math.max(0, gap) * 0.25);
      m.visible = true;
    });
    for (let i = screens.length; i < this.prints.length; i++) this.prints[i].visible = false;
  }

  private newFootprint(): Mesh<PlaneGeometry, MeshBasicMaterial> {
    this.footprintTex ??= footprintTexture();
    const m = new Mesh(
      new PlaneGeometry(1, 1),
      new MeshBasicMaterial({ map: this.footprintTex, color: new Color('#5fe8ff'), transparent: true, depthWrite: false, blending: AdditiveBlending, toneMapped: false }),
    );
    m.renderOrder = -0.3;
    this.footprints.add(m);
    this.prints.push(m);
    return m;
  }
}

/** Soft glowing bar: bright core line along x, fading out to the sides and the ends. */
function footprintTexture(): Texture {
  const [c, g] = makeCanvas(256, 64);
  const across = g.createLinearGradient(0, 0, 0, 64);
  across.addColorStop(0, 'rgba(255,255,255,0)');
  across.addColorStop(0.45, 'rgba(255,255,255,0.55)');
  across.addColorStop(0.5, 'rgba(255,255,255,1)');
  across.addColorStop(0.55, 'rgba(255,255,255,0.55)');
  across.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = across;
  g.fillRect(0, 0, 256, 64);
  // Fade the ends.
  g.globalCompositeOperation = 'destination-in';
  const along = g.createLinearGradient(0, 0, 256, 0);
  along.addColorStop(0, 'rgba(0,0,0,0)');
  along.addColorStop(0.1, 'rgba(0,0,0,1)');
  along.addColorStop(0.9, 'rgba(0,0,0,1)');
  along.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = along;
  g.fillRect(0, 0, 256, 64);
  return canvasTexture(c);
}
