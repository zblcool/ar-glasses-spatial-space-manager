import { Color, LinearFilter, Mesh, PerspectiveCamera, PlaneGeometry, Quaternion, ShaderMaterial, SRGBColorSpace, Texture, Vector2, Vector3, VideoTexture } from 'three';
import { describe, GLASSES_CAMERA_HFOV, openCamera, type HandCamera } from '../interaction/HandTracker';

/** How far away the camera image hangs (m): far enough to read as background, with almost no stereo disparity. */
const DISTANCE = 100;
/** Capture resolution asked for: the glasses' camera's full 1920×1080 (MJPEG). */
const WIDTH = 1920;
const HEIGHT = 1080;
/**
 * Camera → screen latency assumed when the browser gives no capture time for
 * a frame (ms). The image is placed where the head was this long ago, so the
 * real world stays put when you turn instead of swimming along with you.
 */
const FALLBACK_LATENCY_MS = 90;
/**
 * The camera's mounting relative to the eyes (deg): positive pitch = the
 * image is moved up. Tune if the camera image sits above / below the real world.
 */
const PITCH_OFFSET_DEG = 0;
/** Head orientations kept for latency compensation (ms). */
const HISTORY_MS = 1000;
const PLAY_TIMEOUT_MS = 8000;

export type PassthroughState = 'off' | 'starting' | 'on' | 'error';
/** camera: the picture, lightly sharpened · outline: only the edges of things, glowing on black. */
export type PassthroughStyle = 'camera' | 'outline';

/** Outline colour (the grid's cyan). */
const LINE_COLOR = '#5fe8ff';
/**
 * Edge strength (contrast-normalised gradient) where a line starts / is fully
 * on. Raise both to keep only stronger outlines, lower them for more detail.
 */
const EDGE_LO = 0.1;
const EDGE_HI = 0.28;
/** Camera style: unsharp-mask amount on brightness (0 = off). */
const SHARPEN = 0.6;

/**
 * One pass over the camera image, all on the GPU (17 texture reads per pixel).
 * Outlines: a Sobel gradient of brightness at two scales, each divided by the
 * local mean brightness so edges in dark corners count as much as in bright
 * ones. The fine scale (1.5 px, smoothed for free by bilinear sampling) puts
 * the line in the right place and keeps it thin; the coarse scale (5 px) must
 * agree, which drops fine texture (carpet, wood grain, sensor noise) and keeps
 * the outlines of things. Black is transparent on the glasses' optics.
 */
const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const FRAGMENT = /* glsl */ `
uniform sampler2D map;
uniform vec2 texel;
uniform float outline;
uniform float brightness;
uniform vec3 lineColor;
uniform vec2 edge;
uniform float sharpen;
varying vec2 vUv;

float lum(vec2 uv) {
  // sqrt: roughly perceptual, so edges in shadows are not underweighted.
  return sqrt(dot(texture2D(map, uv).rgb, vec3(0.2126, 0.7152, 0.0722)));
}

// Contrast-normalised Sobel magnitude at radius r (pixels); mean = average of the 8 taps.
float sobel(vec2 uv, float r, out float mean) {
  vec2 d = texel * r;
  float tl = lum(uv + vec2(-d.x, d.y)), t = lum(uv + vec2(0.0, d.y)), tr = lum(uv + d);
  float l = lum(uv - vec2(d.x, 0.0)), rt = lum(uv + vec2(d.x, 0.0));
  float bl = lum(uv - d), b = lum(uv - vec2(0.0, d.y)), br = lum(uv + vec2(d.x, -d.y));
  float gx = (tr + 2.0 * rt + br) - (tl + 2.0 * l + bl);
  float gy = (tl + 2.0 * t + tr) - (bl + 2.0 * b + br);
  mean = (tl + t + tr + l + rt + bl + b + br) / 8.0;
  return length(vec2(gx, gy)) / (4.0 * (mean + 0.08));
}

void main() {
  // Soft border, so the picture's edge doesn't cut a hard line through the view.
  vec2 e = smoothstep(vec2(0.0), vec2(0.03), vUv) * smoothstep(vec2(0.0), vec2(0.03), 1.0 - vUv);
  float border = e.x * e.y;
  float meanFine, meanCoarse;
  float fine = sobel(vUv, 1.5, meanFine);
  vec3 c;
  if (outline > 0.5) {
    float coarse = sobel(vUv, 5.0, meanCoarse);
    float line = smoothstep(edge.x, edge.y, fine) * smoothstep(edge.x * 0.7, edge.y * 0.7, coarse);
    c = lineColor * line;
  } else {
    c = texture2D(map, vUv).rgb;
    float l = lum(vUv);
    float boosted = max(0.0, l + sharpen * (l - meanFine));
    c *= min(4.0, (boosted * boosted) / max(l * l, 1e-4));
  }
  gl_FragColor = vec4(c * brightness * border, 1.0);
  #include <colorspace_fragment>
}`;

type FrameMeta = { captureTime?: number; expectedDisplayTime: number };
type VideoWithFrames = HTMLVideoElement & { requestVideoFrameCallback?(cb: (now: number, meta: FrameMeta) => void): number };

/**
 * See-through: the glasses' front RGB camera shown as the background, so you
 * see the room around the floating screens. The camera looks where you look;
 * each frame is placed at the head orientation from when it was captured
 * (from a short pose history), so the room stays still while you turn and only
 * lags at its edges. Shares the camera with Hands (Chromium serves both from
 * one capture). Falls back to the Mac's camera so the mode can be tried
 * without glasses, though that one is not see-through. Shown either as the
 * picture or as an outline-only world (see FRAGMENT).
 */
export class Passthrough {
  readonly mesh: Mesh<PlaneGeometry, ShaderMaterial>;
  /** Which camera is showing. */
  camera: HandCamera = 'glasses';
  private video: VideoWithFrames | null = null;
  private stream: MediaStream | null = null;
  private wanted = false;
  private readonly history: Array<{ t: number; q: Quaternion }> = [];
  /** performance.now() when the frame on screen was captured; null until the first frame. */
  private frameTime: number | null = null;
  private readonly frameQ = new Quaternion();
  private readonly pitch = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), (PITCH_OFFSET_DEG * Math.PI) / 180);
  private readonly fwd = new Vector3();

  constructor(private readonly onState: (state: PassthroughState, detail?: string) => void) {
    const material = new ShaderMaterial({
      uniforms: {
        map: { value: null },
        texel: { value: new Vector2(1 / WIDTH, 1 / HEIGHT) },
        outline: { value: 0 },
        brightness: { value: 1 },
        lineColor: { value: new Color(LINE_COLOR) },
        edge: { value: new Vector2(EDGE_LO, EDGE_HI) },
        sharpen: { value: SHARPEN },
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.mesh = new Mesh(new PlaneGeometry(1, 1), material);
    this.mesh.renderOrder = -2; // first: everything else draws over it
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  get running(): boolean {
    return this.wanted;
  }

  async start(): Promise<void> {
    if (this.wanted) return;
    this.wanted = true;
    this.onState('starting');
    try {
      const opened = await openCamera('glasses', WIDTH, HEIGHT);
      if (!this.wanted) {
        opened.stream.getTracks().forEach((t) => t.stop());
        return;
      }
      this.stream = opened.stream;
      this.camera = opened.camera;
      const video: VideoWithFrames = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = opened.stream;
      await Promise.race([
        video.play(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('the camera sends no video — is another app using it?')), PLAY_TIMEOUT_MS)),
      ]);
      if (!this.wanted) return;
      this.video = video;
      const tex = new VideoTexture(video);
      tex.colorSpace = SRGBColorSpace;
      tex.minFilter = LinearFilter;
      tex.generateMipmaps = false;
      this.mesh.material.uniforms.map.value = tex;
      this.frameTime = null;
      this.watchFrames(video);
      this.mesh.visible = true;
      this.onState('on');
    } catch (err) {
      this.stop();
      this.onState('error', describe(err));
    }
  }

  stop(): void {
    this.wanted = false;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.video) this.video.srcObject = null;
    this.video = null;
    (this.mesh.material.uniforms.map.value as Texture | null)?.dispose();
    this.mesh.material.uniforms.map.value = null;
    this.mesh.visible = false;
    this.onState('off');
  }

  /** Per render frame, after the head pose is applied to the camera. */
  update(camera: PerspectiveCamera, now: number): void {
    this.history.push({ t: now, q: camera.quaternion.clone() });
    while (this.history.length > 2 && this.history[0].t < now - HISTORY_MS) this.history.shift();
    const video = this.video;
    if (!video || !this.mesh.visible || !video.videoWidth) return;

    const t = this.frameTime ?? now - FALLBACK_LATENCY_MS;
    this.headAt(t, this.frameQ).multiply(this.pitch);
    this.mesh.quaternion.copy(this.frameQ);
    this.fwd.set(0, 0, -DISTANCE).applyQuaternion(this.frameQ);
    this.mesh.position.copy(camera.position).add(this.fwd);
    const w = 2 * DISTANCE * Math.tan((GLASSES_CAMERA_HFOV * Math.PI) / 360);
    this.mesh.scale.set(w, (w * video.videoHeight) / video.videoWidth, 1);
    (this.mesh.material.uniforms.texel.value as Vector2).set(1 / video.videoWidth, 1 / video.videoHeight);
  }

  /** Dim with the scenery (Cinema). */
  setBrightness(k: number): void {
    this.mesh.material.uniforms.brightness.value = k;
  }

  setStyle(style: PassthroughStyle): void {
    this.mesh.material.uniforms.outline.value = style === 'outline' ? 1 : 0;
  }

  /** Remember when each new camera frame was captured. */
  private watchFrames(video: VideoWithFrames): void {
    if (!video.requestVideoFrameCallback) return;
    const onFrame = (now: number, meta: FrameMeta) => {
      if (this.video !== video) return;
      this.frameTime = meta.captureTime ?? now - FALLBACK_LATENCY_MS;
      video.requestVideoFrameCallback!(onFrame);
    };
    video.requestVideoFrameCallback(onFrame);
  }

  /** Head orientation at time t, interpolated from the history. */
  private headAt(t: number, out: Quaternion): Quaternion {
    const h = this.history;
    if (t <= h[0].t) return out.copy(h[0].q);
    for (let i = h.length - 1; i > 0; i--) {
      if (h[i - 1].t <= t) {
        const a = h[i - 1];
        const b = h[i];
        return out.slerpQuaternions(a.q, b.q, b.t > a.t ? Math.min(1, (t - a.t) / (b.t - a.t)) : 1);
      }
    }
    return out.copy(h[h.length - 1].q);
  }
}
