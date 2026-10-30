import {
  BackSide,
  CanvasTexture,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
  SRGBColorSpace,
  Texture,
} from 'three';
import type { PanoramaPayload } from '../../../shared/types';

export const PANORAMA_RADIUS = 500;
/** Panorama texture width; 8192×4096 keeps GPU memory reasonable (~170 MB with mipmaps). */
const TEX_W = 8192;
const TEX_H = TEX_W / 2;

/**
 * Large inverted sphere showing an equirectangular image. The image centre
 * (u = 0.5) faces the default forward direction (-Z).
 */
export class Panorama {
  readonly mesh: Mesh<SphereGeometry, MeshBasicMaterial>;
  name = 'procedural';

  constructor() {
    const geometry = new SphereGeometry(PANORAMA_RADIUS, 96, 64);
    const material = new MeshBasicMaterial({ side: BackSide, depthWrite: false, toneMapped: false });
    this.mesh = new Mesh(geometry, material);
    // BackSide renders the inside of the sphere mirrored; flip x to un-mirror,
    // then rotate so u = 0.5 is in front of the viewer instead of at -X.
    this.mesh.scale.set(-1, 1, 1);
    this.mesh.rotation.y = -Math.PI / 2;
    this.mesh.renderOrder = -1;
    this.setTexture(proceduralPanorama());
  }

  /**
   * Load an image. A 2:1 image is used as a full equirectangular panorama. Any
   * other aspect is treated as a 360°-or-less strip: it is mirror-tiled to
   * cover 360° (so both joins match), centred on the horizon in front of the
   * viewer, and the sky/ground above and below are filled with colours sampled
   * from its top/bottom edges.
   */
  async load(payload: PanoramaPayload | null): Promise<void> {
    if (!payload) return;
    const blob = new Blob([payload.data], { type: payload.mime });
    const size = await imageSize(blob);
    const aspect = size.width / size.height;
    const canvas = document.createElement('canvas');
    canvas.width = TEX_W;
    canvas.height = TEX_H;
    const g = canvas.getContext('2d')!;

    if (Math.abs(aspect - 2) < 0.05) {
      const bmp = await createImageBitmap(blob, { resizeWidth: TEX_W, resizeHeight: TEX_H, resizeQuality: 'high' });
      g.drawImage(bmp, 0, 0);
      bmp.close();
      this.name = payload.name;
    } else {
      const tileW = TEX_W / 2; // one copy + one mirrored copy = 360°
      const tileH = Math.min(TEX_H, Math.round(tileW / aspect));
      const bmp = await createImageBitmap(blob, { resizeWidth: tileW, resizeHeight: tileH, resizeQuality: 'high' });
      const top = (TEX_H - tileH) / 2;
      const [skyColor, groundColor] = edgeColors(bmp);

      // Sky and ground fills, slightly darker toward zenith/nadir.
      const sky = g.createLinearGradient(0, 0, 0, top);
      sky.addColorStop(0, shade(skyColor, 0.75));
      sky.addColorStop(1, skyColor);
      g.fillStyle = sky;
      g.fillRect(0, 0, TEX_W, top + 2);
      const ground = g.createLinearGradient(0, top + tileH, 0, TEX_H);
      ground.addColorStop(0, groundColor);
      ground.addColorStop(1, shade(groundColor, 0.6));
      g.fillStyle = ground;
      g.fillRect(0, top + tileH - 2, TEX_W, TEX_H - top - tileH + 2);

      // Original centred in front (u = 0.5); mirrored copies on both sides fill the rest.
      const x0 = TEX_W / 2 - tileW / 2;
      g.drawImage(bmp, x0, top);
      for (const x of [x0 + tileW, x0 - tileW]) {
        g.save();
        g.translate(x + tileW, 0);
        g.scale(-1, 1);
        g.drawImage(bmp, 0, top);
        g.restore();
      }
      bmp.close();

      // Feather the image's top and bottom edges into the fills.
      const feather = tileH * 0.12;
      const fadeTop = g.createLinearGradient(0, top, 0, top + feather);
      fadeTop.addColorStop(0, skyColor);
      fadeTop.addColorStop(1, withAlpha(skyColor, 0));
      g.fillStyle = fadeTop;
      g.fillRect(0, top, TEX_W, feather);
      const fadeBottom = g.createLinearGradient(0, top + tileH - feather, 0, top + tileH);
      fadeBottom.addColorStop(0, withAlpha(groundColor, 0));
      fadeBottom.addColorStop(1, groundColor);
      g.fillStyle = fadeBottom;
      g.fillRect(0, top + tileH - feather, TEX_W, feather);

      const vCover = (180 * tileH) / TEX_H;
      this.name = `${payload.name} (mirrored to 360°, ${vCover.toFixed(0)}° tall)`;
    }
    this.setTexture(new CanvasTexture(canvas));
  }

  private setTexture(tex: Texture): void {
    tex.colorSpace = SRGBColorSpace;
    const old = this.mesh.material.map;
    this.mesh.material.map = tex;
    this.mesh.material.needsUpdate = true;
    old?.dispose();
  }
}

/** Placeholder: sky/ground gradient plus a 15° grid with compass labels. */
function proceduralPanorama(): CanvasTexture {
  const W = 4096;
  const H = 2048;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;

  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, '#060b1f');
  grad.addColorStop(0.35, '#1b2a5c');
  grad.addColorStop(0.49, '#e0875a');
  grad.addColorStop(0.5, '#2a1f2e');
  grad.addColorStop(1, '#07070b');
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);

  // Grid: x maps longitude (-180..180, centre = forward), y maps latitude (90..-90).
  for (let deg = -180; deg <= 180; deg += 15) {
    const x = ((deg + 180) / 360) * W;
    g.strokeStyle = deg % 90 === 0 ? 'rgba(255,255,255,0.55)' : deg % 45 === 0 ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.12)';
    g.lineWidth = deg % 45 === 0 ? 3 : 1.5;
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, H);
    g.stroke();
  }
  for (let lat = -75; lat <= 75; lat += 15) {
    const y = ((90 - lat) / 180) * H;
    g.strokeStyle = lat === 0 ? 'rgba(255,220,180,0.8)' : 'rgba(255,255,255,0.12)';
    g.lineWidth = lat === 0 ? 3 : 1.5;
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(W, y);
    g.stroke();
  }

  // Compass labels: yaw measured clockwise from forward.
  const labels: Record<number, string> = { 0: 'FRONT 0°', 90: 'RIGHT 90°', 180: 'BACK 180°', [-90]: 'LEFT 270°', [-180]: 'BACK 180°' };
  g.textAlign = 'center';
  g.textBaseline = 'bottom';
  for (let deg = -180; deg <= 180; deg += 15) {
    const x = ((deg + 180) / 360) * W;
    const label = labels[deg];
    g.fillStyle = label ? '#ffffff' : 'rgba(255,255,255,0.6)';
    g.font = label ? 'bold 44px system-ui, sans-serif' : '26px system-ui, sans-serif';
    g.fillText(label ?? `${(deg + 360) % 360}°`, x, H / 2 - 14);
  }
  g.font = '28px system-ui, sans-serif';
  g.fillStyle = 'rgba(255,255,255,0.5)';
  g.fillText('placeholder panorama — put an equirectangular image in app/assets/panorama.jpg', W / 2, H / 2 + 60);

  return new CanvasTexture(c);
}

async function imageSize(blob: Blob): Promise<{ width: number; height: number }> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('could not read image'));
    });
    return { width: img.naturalWidth, height: img.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Average colour of the top and bottom few rows, as CSS rgb() strings. */
function edgeColors(bmp: ImageBitmap): [string, string] {
  const w = 64;
  const h = 32;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(bmp, 0, 0, w, h);
  const avg = (y0: number, rows: number) => {
    const d = g.getImageData(0, y0, w, rows).data;
    let r = 0, gg = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) {
      r += d[i];
      gg += d[i + 1];
      b += d[i + 2];
    }
    const n = d.length / 4;
    return `rgb(${Math.round(r / n)}, ${Math.round(gg / n)}, ${Math.round(b / n)})`;
  };
  return [avg(0, 2), avg(h - 2, 2)];
}

function parseRgb(c: string): [number, number, number] {
  const m = c.match(/\d+/g)!.map(Number);
  return [m[0], m[1], m[2]];
}

function shade(c: string, k: number): string {
  const [r, g, b] = parseRgb(c);
  return `rgb(${Math.round(r * k)}, ${Math.round(g * k)}, ${Math.round(b * k)})`;
}

function withAlpha(c: string, a: number): string {
  const [r, g, b] = parseRgb(c);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}
