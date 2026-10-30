import { Vector2 } from 'three';
import type { HandLandmarker, NormalizedLandmark } from '@mediapipe/tasks-vision';
import { OneEuro } from './OneEuro';

/** Hand landmarks used (MediaPipe numbering). */
const WRIST = 0;
const THUMB_TIP = 4;
const INDEX_MCP = 5;
const INDEX_TIP = 8;

/**
 * Part of the camera image that maps to the full view, so the hand doesn't
 * have to reach the edges of the frame: centre and half-size in normalised
 * image coordinates. Hands sit a little low in a laptop camera's frame.
 */
const REGION = { cx: 0.5, cy: 0.55, hw: 0.3, hh: 0.25 };
/** The pointer may go a bit past the edge of the view. */
const NDC_LIMIT = 1.15;
/**
 * Pinch = thumb tip to index tip, relative to hand size (wrist to index
 * knuckle). Two thresholds so a pinch held near the limit doesn't flicker.
 */
const PINCH_ON = 0.25;
const PINCH_OFF = 0.4;
/**
 * The Mac camera's mapping magnifies the middle of the frame ~3×; drawn at
 * that scale the hand outline would cover half the view, so it is shrunk
 * around the pointer to roughly hand size. (The glasses' mapping is 1:1.)
 */
const MAC_OUTLINE_SCALE = 0.4;
/** Keep the pointer this long after the hand drops out of a few frames. */
const LOST_GRACE_MS = 200;
/**
 * The glasses' RGB camera (Luma Pro / Cyber / Ultra) is a plain UVC camera,
 * USB 0c45:636b; macOS lists it as "USB Camera". It looks where you look, so
 * the ray goes from your eyes through your hand. Its image is not mirrored:
 * the image's left is your left.
 */
export const GLASSES_CAMERA = /0c45:636b|viture/i;
/**
 * Assumed horizontal FOV of the glasses' camera (degrees); maps the image to
 * view directions. Not in the SDK docs. Raise it if the dot runs ahead of
 * your hand, lower it if it lags behind.
 */
export const GLASSES_CAMERA_HFOV = 75;

export type HandCamera = 'glasses' | 'mac';

const PLAY_TIMEOUT_MS = 8000;
const NO_VIDEO = 'the camera sends no video — is another app using it? (or try the other Hand Cam)';

export type HandState = 'off' | 'starting' | 'tracking' | 'no-hand' | 'error';

export interface HandCallbacks {
  /**
   * Per camera frame: pointer in NDC + pinch, or null when no hand is seen.
   * reach grows as the hand moves away from you (log of its apparent size,
   * sign-corrected for the camera), for pushing screens back.
   */
  pointer(ndc: Vector2 | null, pinched: boolean, reach: number): void;
  state(state: HandState, detail?: string): void;
  /** tan(half FOV) of the view, horizontally and vertically (glasses camera mapping). */
  viewTan(): { x: number; y: number };
  /**
   * The whole hand for drawing its outline: the 21 landmarks in NDC (shifted
   * to sit on the smoothed pointer), or null when no hand is seen.
   */
  hand?(points: Vector2[] | null, pinched: boolean): void;
}

/**
 * Hand pointer from a camera, like Viture's own ray + pinch: the Mac's camera
 * or the glasses' own front camera (a setting; falls back to the Mac's). MediaPipe HandLandmarker
 * finds the hand, a ray through the index finger's knuckle becomes the pointer (the knuckle barely moves when you
 * pinch, unlike the fingertip), smoothed with a One-Euro filter, and
 * thumb–index pinch is the button. Everything runs locally: the WASM runtime
 * and model are served from assets/public/mediapipe/.
 */
export class HandTracker {
  private landmarker: HandLandmarker | null = null;
  private video: HTMLVideoElement | null = null;
  private stream: MediaStream | null = null;
  private raf = 0;
  private lastVideoTime = -1;
  private lastSeen = 0;
  private pinched = false;
  private seen = false;
  private wanted = false;
  private readonly fx = new OneEuro(1.2, 1.5);
  private readonly fy = new OneEuro(1.2, 1.5);
  private readonly freach = new OneEuro(0.8, 0.5);
  /** Which camera is in use (a test stream counts as the Mac's). */
  camera: HandCamera = 'mac';
  private readonly ndc = new Vector2();
  private readonly points = Array.from({ length: 21 }, () => new Vector2());

  constructor(private readonly cb: HandCallbacks) {}

  get running(): boolean {
    return this.wanted;
  }

  /** Start a camera (or another video stream, e.g. a canvas in a scripted test). */
  async start(prefer: HandCamera = 'mac', source?: MediaStream): Promise<void> {
    if (this.wanted) return;
    this.wanted = true;
    this.cb.state('starting');
    try {
      this.landmarker ??= await createLandmarker();
      const opened = source ? { stream: source, camera: 'mac' as const } : await openCamera(prefer);
      const stream = opened.stream;
      this.camera = opened.camera;
      if (!this.wanted) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      this.stream = stream;
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      // A camera that's busy or blocked can open without ever sending a frame.
      await Promise.race([
        video.play(),
        new Promise((_, reject) => setTimeout(() => reject(new Error(NO_VIDEO)), PLAY_TIMEOUT_MS)),
      ]);
      this.video = video;
      this.seen = false;
      this.cb.state('no-hand');
      this.loop();
    } catch (err) {
      this.stop();
      this.cb.state('error', describe(err));
    }
  }

  stop(): void {
    this.wanted = false;
    cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.video) this.video.srcObject = null;
    this.video = null;
    this.lastVideoTime = -1;
    this.release();
    this.cb.state('off');
  }

  private loop = (): void => {
    if (!this.wanted) return;
    this.raf = requestAnimationFrame(this.loop);
    const video = this.video;
    const lm = this.landmarker;
    if (!video || !lm || video.readyState < 2 || video.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = video.currentTime;
    const now = performance.now();
    const hand = lm.detectForVideo(video, now).landmarks[0];
    if (hand) this.onHand(hand, video.videoWidth / video.videoHeight, now);
    else if (now - this.lastSeen > LOST_GRACE_MS) this.release();
  };

  private onHand(hand: NormalizedLandmark[], aspect: number, now: number): void {
    this.lastSeen = now;
    if (!this.seen) {
      this.seen = true;
      this.cb.state('tracking');
    }
    const p = hand[INDEX_MCP];
    const t = now / 1000;
    const raw = this.toNdc(p, aspect, new Vector2());
    const x = clamp(raw.x, NDC_LIMIT);
    const y = clamp(raw.y, NDC_LIMIT);
    this.ndc.set(this.fx.filter(x, t), this.fy.filter(y, t));
    if (this.cb.hand) {
      // Same mapping for every landmark, anchored on the smoothed dot (and shrunk for the Mac camera).
      const k = this.camera === 'glasses' ? 1 : MAC_OUTLINE_SCALE;
      hand.forEach((l, i) => this.toNdc(l, aspect, this.points[i]).sub(raw).multiplyScalar(k).add(this.ndc));
    }

    const size = dist(hand[WRIST], hand[INDEX_MCP], aspect);
    // Away from you = bigger in the Mac's camera (nearer to it), smaller in the glasses'.
    const reach = size > 0 ? this.freach.filter((this.camera === 'glasses' ? -1 : 1) * Math.log(size), t) : 0;
    const pinch = size > 0 ? dist(hand[THUMB_TIP], hand[INDEX_TIP], aspect) / size : Infinity;
    this.pinched = this.pinched ? pinch < PINCH_OFF : pinch < PINCH_ON;
    this.cb.pointer(this.ndc, this.pinched, reach);
    this.cb.hand?.(this.points, this.pinched);
  }

  /** Image point → view NDC (unclamped). */
  private toNdc(p: NormalizedLandmark, aspect: number, out: Vector2): Vector2 {
    if (this.camera === 'glasses') {
      // Head-mounted, facing forward: image direction → view direction (no mirroring).
      const view = this.cb.viewTan();
      const tx = Math.tan((GLASSES_CAMERA_HFOV * Math.PI) / 360);
      return out.set(((p.x - 0.5) * 2 * tx) / view.x, ((0.5 - p.y) * 2 * (tx / aspect)) / view.y);
    }
    // Facing you: mirror x (your right is the image's left), and use only the middle of the frame.
    return out.set((REGION.cx - p.x) / REGION.hw, (REGION.cy - p.y) / REGION.hh);
  }

  /** No hand: drop the pointer (and any pinch) and reset the filters. */
  private release(): void {
    this.pinched = false;
    this.fx.reset();
    this.fy.reset();
    this.freach.reset();
    if (this.seen) {
      this.seen = false;
      if (this.wanted) this.cb.state('no-hand');
    }
    this.cb.pointer(null, false, 0);
    this.cb.hand?.(null, false);
  }
}

/** Open the preferred camera; the glasses' falls back to the Mac's when it isn't there. */
export async function openCamera(prefer: HandCamera, width = 640, height = 480): Promise<{ stream: MediaStream; camera: HandCamera }> {
  const open = (deviceId?: string) =>
    navigator.mediaDevices.getUserMedia({
      video: { deviceId: deviceId ? { exact: deviceId } : undefined, width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: 30 } },
      audio: false,
    });
  const cameras = async () => (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  let list = await cameras();
  if (list.some((d) => !d.label)) {
    // Device names are hidden until camera access has been granted once.
    (await open()).getTracks().forEach((t) => t.stop());
    list = await cameras();
  }
  const glasses = prefer === 'glasses' ? list.find((d) => GLASSES_CAMERA.test(d.label)) : undefined;
  if (glasses) {
    try {
      return { stream: await open(glasses.deviceId), camera: 'glasses' };
    } catch (err) {
      console.warn('[hands] glasses camera failed, using the Mac camera:', err);
    }
  }
  const builtIn = list.find((d) => /facetime|built-in/i.test(d.label));
  return { stream: await open(builtIn?.deviceId), camera: 'mac' };
}

async function createLandmarker(): Promise<HandLandmarker> {
  // Loaded on first use only: the runtime is ~13 MB of WASM.
  const { HandLandmarker } = await import('@mediapipe/tasks-vision');
  const base = new URL('mediapipe/', document.baseURI).href;
  const fileset = { wasmLoaderPath: `${base}vision_wasm_internal.js`, wasmBinaryPath: `${base}vision_wasm_internal.wasm` };
  const options = (delegate: 'GPU' | 'CPU') => ({
    baseOptions: { modelAssetPath: `${base}hand_landmarker.task`, delegate },
    runningMode: 'VIDEO' as const,
    numHands: 1,
  });
  try {
    return await HandLandmarker.createFromOptions(fileset, options('GPU'));
  } catch (err) {
    console.warn('[hands] GPU delegate failed, using CPU:', err);
    return await HandLandmarker.createFromOptions(fileset, options('CPU'));
  }
}

/** Distance in image space, with x scaled so both axes use the same unit. */
function dist(a: NormalizedLandmark, b: NormalizedLandmark, aspect: number): number {
  return Math.hypot((a.x - b.x) * aspect, a.y - b.y, (a.z - b.z) * aspect);
}

function clamp(v: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, v));
}

export function describe(err: unknown): string {
  if (err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) {
    return 'camera access denied — allow it in System Settings → Privacy & Security → Camera';
  }
  if (err instanceof DOMException && err.name === 'NotFoundError') return 'no camera found';
  if (err instanceof Error && err.message === NO_VIDEO) return NO_VIDEO;
  if (err instanceof Event || (err instanceof Error && /fetch|load|404/i.test(err.message))) {
    return 'hand model not found — run `node scripts/mediapipe-assets.mjs` in app/';
  }
  return err instanceof Error ? err.message : String(err);
}
