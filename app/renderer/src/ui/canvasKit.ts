import { CanvasTexture, SRGBColorSpace } from 'three';

/** Shared 2D-canvas drawing helpers for the glass-style UI (panels, pills, icons). */

export const UI_FONT = 'system-ui, -apple-system, "Helvetica Neue", sans-serif';

export function makeCanvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

export function canvasTexture(c: HTMLCanvasElement): CanvasTexture {
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  return t;
}

export function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2));
}

/** Frosted-glass card: translucent fill, faint top highlight, hairline border. */
export function glassCard(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number, alpha = 0.55): void {
  roundRect(g, x, y, w, h, r);
  g.fillStyle = `rgba(28, 32, 40, ${alpha})`;
  g.fill();
  const hl = g.createLinearGradient(0, y, 0, y + h);
  hl.addColorStop(0, 'rgba(255,255,255,0.16)');
  hl.addColorStop(0.5, 'rgba(255,255,255,0.04)');
  hl.addColorStop(1, 'rgba(255,255,255,0.02)');
  g.fillStyle = hl;
  g.fill();
  g.strokeStyle = 'rgba(255,255,255,0.22)';
  g.lineWidth = 2;
  g.stroke();
}

export type IconName =
  | 'display'
  | 'laptop'
  | 'virtual'
  | 'pattern'
  | 'head'
  | 'follow'
  | 'anchor'
  | 'recenter'
  | 'stereo'
  | 'dof'
  | 'ambient'
  | 'debug'
  | 'lock'
  | 'hand'
  | 'grid'
  | 'sky'
  | 'cinema'
  | 'eye'
  | 'close';

/** Simple line icons drawn in a size×size box at (x, y). */
export function drawIcon(g: CanvasRenderingContext2D, name: IconName, x: number, y: number, size: number, color = '#fff'): void {
  const s = size / 24;
  g.save();
  g.translate(x, y);
  g.scale(s, s);
  g.strokeStyle = color;
  g.fillStyle = color;
  g.lineWidth = 1.8;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const path = (d: string) => g.stroke(new Path2D(d));
  switch (name) {
    case 'display':
      path('M3 5h18v11H3z M9 20h6 M12 16v4');
      break;
    case 'laptop':
      path('M5 6h14v9H5z M2 18h20');
      break;
    case 'virtual':
      path('M3 5h18v11H3z M9 20h6 M12 16v4 M8 8l4 6 4-6');
      break;
    case 'pattern':
      path('M3 5h18v14H3z M3 10h18 M9 5v14 M15 5v14');
      break;
    case 'head':
      path('M4 4h4 M4 4v4 M20 4h-4 M20 4v4 M4 20h4 M4 20v-4 M20 20h-4 M20 20v-4');
      g.beginPath();
      g.arc(12, 10, 3, 0, Math.PI * 2);
      g.fill();
      path('M7 18c1-3 9-3 10 0');
      break;
    case 'follow':
      path('M4 6h12v9H4z M8 18h12V9');
      break;
    case 'anchor':
      path('M3 5h18v11H3z M9 20h6 M12 16v4');
      g.beginPath();
      g.arc(12, 10.5, 2, 0, Math.PI * 2);
      g.fill();
      break;
    case 'recenter':
      g.beginPath();
      g.arc(12, 12, 7, 0, Math.PI * 2);
      g.stroke();
      path('M12 2v5 M12 17v5 M2 12h5 M17 12h5');
      g.beginPath();
      g.arc(12, 12, 1.5, 0, Math.PI * 2);
      g.fill();
      break;
    case 'stereo':
      path('M2 9h20v7a2 2 0 0 1-2 2h-5l-3-3-3 3H4a2 2 0 0 1-2-2z');
      g.beginPath();
      g.arc(7, 13, 1.6, 0, Math.PI * 2);
      g.arc(17, 13, 1.6, 0, Math.PI * 2);
      g.fill();
      break;
    case 'dof':
      path('M12 3l8 4.5v9L12 21l-8-4.5v-9z M12 12l8-4.5 M12 12v9 M12 12L4 7.5');
      break;
    case 'ambient':
      path('M3 15c3-5 6-5 9 0s6 5 9 0 M5 8l2-2 2 2 M15 6l2-2 2 2');
      break;
    case 'debug':
      path('M4 19V9 M10 19V5 M16 19v-7 M22 19H2');
      break;
    case 'lock':
      path('M6 11h12v9H6z M8 11V8a4 4 0 0 1 8 0v3');
      break;
    case 'hand':
      // Pointing hand with a ray from the index finger.
      path('M9 21v-5l-3-3.5a1.4 1.4 0 0 1 2-2L10 12V5.5a1.5 1.5 0 0 1 3 0V11 M13 10.5a1.5 1.5 0 0 1 3 0V12 M16 11.5a1.5 1.5 0 0 1 3 0V16c0 3-2 5-4 5H9');
      path('M11.5 1.5v1 M15.5 2.5l-.8.8 M7.5 2.5l.8.8');
      break;
    case 'grid':
      // Floor grid in perspective, lines meeting at the horizon.
      path('M2 20L9 9h6l7 11z M12 9v11 M5.5 14.5h13 M9 20l1.5-11 M15 20l-1.5-11 M2 6h20');
      break;
    case 'sky':
      // Sun over mountains.
      path('M2 19l6-8 4 5 3-3 7 6z');
      g.beginPath();
      g.arc(17, 6, 2.5, 0, Math.PI * 2);
      g.stroke();
      break;
    case 'cinema':
      // A big screen far above a row of seats.
      path('M3 3h18v10H3z M5 20c0-2 2-3 3.5-3S12 18 12 20 M12 20c0-2 2-3 3.5-3S19 18 19 20');
      break;
    case 'eye':
      path('M2 12c3-5 6.5-7 10-7s7 2 10 7c-3 5-6.5 7-10 7s-7-2-10-7z');
      g.beginPath();
      g.arc(12, 12, 3, 0, Math.PI * 2);
      g.stroke();
      break;
    case 'close':
      path('M6 6l12 12 M18 6L6 18');
      break;
  }
  g.restore();
}

const alphaMaps = new Map<string, CanvasTexture>();

/** White rounded rectangle on black, for use as an alphaMap (cached per aspect). */
export function roundedAlphaMap(aspect: number, radiusFrac = 0.035): CanvasTexture {
  const key = `${aspect.toFixed(2)}|${radiusFrac}`;
  let t = alphaMaps.get(key);
  if (t) return t;
  const H = 256;
  const W = Math.max(16, Math.round(H * aspect));
  const [c, g] = makeCanvas(W, H);
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#fff';
  roundRect(g, 0, 0, W, H, H * radiusFrac * 2);
  g.fill();
  t = new CanvasTexture(c);
  alphaMaps.set(key, t);
  return t;
}
