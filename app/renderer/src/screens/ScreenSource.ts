import { CanvasTexture, LinearFilter, SRGBColorSpace, Texture, VideoTexture } from 'three';
import type { MirrorDisplay } from '../../../shared/types';

/**
 * Something that produces pixels for a virtual screen.
 *
 * TestPatternSource draws a placeholder; DisplayCaptureSource streams a macOS
 * display, virtual or physical (ScreenCaptureKit via desktopCapturer →
 * MediaStream → VideoTexture). WindowCaptureSource is reserved for capturing
 * individual windows later.
 */
export interface ScreenSource {
  readonly id: string;
  readonly kind: 'test-pattern' | 'display-capture' | 'window-capture';
  readonly label: string;
  /** Texture sampled by the screen mesh. May be replaced when the source resizes. */
  readonly texture: Texture;
  /** Native pixel size of the content; the default screen aspect ratio. */
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  start(): Promise<void>;
  /** Called once per rendered frame; refresh the texture if new content is available. */
  update(nowMs: number): void;
  stop(): void;
  dispose(): void;
}

/** Labelled test pattern (colour bars, grid, live clock) drawn into a canvas. */
export class TestPatternSource implements ScreenSource {
  readonly kind = 'test-pattern';
  readonly texture: CanvasTexture;
  private readonly canvas: HTMLCanvasElement;
  private lastSecond = -1;

  constructor(
    readonly id: string,
    readonly label: string,
    readonly pixelWidth: number,
    readonly pixelHeight: number,
    private readonly accent: string,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = pixelWidth;
    this.canvas.height = pixelHeight;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.draw(new Date());
  }

  async start(): Promise<void> {}

  update(nowMs: number): void {
    const second = Math.floor(nowMs / 1000);
    if (second === this.lastSecond) return;
    this.lastSecond = second;
    this.draw(new Date(nowMs));
    this.texture.needsUpdate = true;
  }

  stop(): void {}

  dispose(): void {
    this.texture.dispose();
  }

  private draw(now: Date): void {
    const { width: W, height: H } = this.canvas;
    const g = this.canvas.getContext('2d')!;
    const u = Math.min(W, H) / 100; // layout unit

    g.fillStyle = '#14161c';
    g.fillRect(0, 0, W, H);

    // Colour bars across the top third.
    const bars = ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0'];
    const barH = H * 0.3;
    bars.forEach((c, i) => {
      g.fillStyle = c;
      g.fillRect((i * W) / bars.length, 0, W / bars.length + 1, barH);
    });

    // Fine grid to judge sharpness.
    g.strokeStyle = 'rgba(255,255,255,0.08)';
    g.lineWidth = 1;
    const step = Math.round(u * 5);
    for (let x = 0; x <= W; x += step) {
      g.beginPath();
      g.moveTo(x + 0.5, barH);
      g.lineTo(x + 0.5, H);
      g.stroke();
    }
    for (let y = barH; y <= H; y += step) {
      g.beginPath();
      g.moveTo(0, y + 0.5);
      g.lineTo(W, y + 0.5);
      g.stroke();
    }

    // Label + info.
    g.fillStyle = this.accent;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `bold ${Math.round(u * 14)}px system-ui, sans-serif`;
    g.fillText(this.label, W / 2, barH + (H - barH) * 0.35);
    g.fillStyle = '#e8eef7';
    g.font = `${Math.round(u * 5)}px ui-monospace, Menlo, monospace`;
    g.fillText(`${W}×${H}  ·  ${now.toLocaleTimeString()}`, W / 2, barH + (H - barH) * 0.65);
    g.font = `${Math.round(u * 3.5)}px system-ui, sans-serif`;
    g.fillStyle = 'rgba(232,238,247,0.6)';
    g.fillText('test pattern source', W / 2, barH + (H - barH) * 0.82);

    // Border so the edges are obvious.
    g.strokeStyle = this.accent;
    g.lineWidth = u * 0.8;
    g.strokeRect(g.lineWidth / 2, g.lineWidth / 2, W - g.lineWidth, H - g.lineWidth);
  }
}

/**
 * Phase 2 placeholder. Will wrap a ScreenCaptureKit stream of one window.
 * Constructing it is fine (it shows a "not available" card), but start() rejects.
 */
export class WindowCaptureSource implements ScreenSource {
  readonly kind = 'window-capture';
  readonly pixelWidth = 1280;
  readonly pixelHeight = 720;
  private readonly inner: TestPatternSource;

  constructor(readonly id: string, readonly windowTitle: string) {
    this.inner = new TestPatternSource(id, `Window: ${windowTitle}`, this.pixelWidth, this.pixelHeight, '#888888');
  }

  get label(): string {
    return this.inner.label;
  }

  get texture(): Texture {
    return this.inner.texture;
  }

  async start(): Promise<void> {
    throw new Error('Window capture is a Phase 2 feature and is not implemented yet');
  }

  update(nowMs: number): void {
    this.inner.update(nowMs);
  }

  stop(): void {}

  dispose(): void {
    this.inner.dispose();
  }
}

/** Draws a simple "label + message" card into a canvas texture. */
class StatusCard {
  readonly texture: CanvasTexture;
  private readonly canvas = document.createElement('canvas');
  private last = '';

  constructor(width: number, height: number) {
    this.canvas.width = width;
    this.canvas.height = height;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
  }

  draw(title: string, message: string, accent: string): void {
    const key = `${title}|${message}|${accent}`;
    if (key === this.last) return;
    this.last = key;
    const { width: W, height: H } = this.canvas;
    const g = this.canvas.getContext('2d')!;
    const u = Math.min(W, H) / 100;
    g.fillStyle = '#101319';
    g.fillRect(0, 0, W, H);
    g.strokeStyle = accent;
    g.lineWidth = u;
    g.strokeRect(u / 2, u / 2, W - u, H - u);
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = accent;
    g.font = `bold ${Math.round(u * 9)}px system-ui, sans-serif`;
    g.fillText(title, W / 2, H * 0.4);
    g.fillStyle = '#c9d3e3';
    g.font = `${Math.round(u * 4)}px system-ui, sans-serif`;
    message.split('\n').forEach((line, i) => g.fillText(line, W / 2, H * 0.58 + i * u * 6));
    this.texture.needsUpdate = true;
  }
}

/**
 * Live view of one macOS display (a virtual one from viture-display-helper, or
 * a physical one). Shows a status card until the capture stream is running.
 */
export class DisplayCaptureSource implements ScreenSource {
  readonly kind = 'display-capture';
  pixelWidth = 1920;
  pixelHeight = 1080;
  /** CGDirectDisplayID of the bound display, or null while unbound. */
  displayId: number | null = null;
  private readonly card: StatusCard;
  private video: HTMLVideoElement | null = null;
  private videoTexture: VideoTexture | null = null;
  private stream: MediaStream | null = null;
  private sourceId: string | null = null;
  private playing = false;

  constructor(
    readonly id: string,
    public label: string,
    private readonly accent: string,
  ) {
    this.card = new StatusCard(1280, 720);
    this.card.draw(label, 'Starting…', accent);
  }

  get texture(): Texture {
    return this.playing && this.videoTexture ? this.videoTexture : this.card.texture;
  }

  get live(): boolean {
    return this.playing;
  }

  async start(): Promise<void> {}

  /** Bind to a display (or show why there is none). Restarts capture when the source changes. */
  bind(info: MirrorDisplay | null, message: string): void {
    if (!info) {
      this.displayId = null;
      this.stopCapture();
      this.card.draw(this.label, message, '#888888');
      return;
    }
    this.displayId = info.id;
    this.label = info.name;
    this.pixelWidth = info.width;
    this.pixelHeight = info.height;
    if (!info.sourceId) {
      this.stopCapture();
      this.card.draw(info.name, 'Display is not visible to screen capture.\nGrant Screen Recording permission, then restart the app.', this.accent);
      return;
    }
    if (info.sourceId === this.sourceId) return;
    this.stopCapture();
    this.sourceId = info.sourceId;
    this.card.draw(info.name, 'Connecting…', this.accent);
    void this.startCapture(info);
  }

  update(): void {}

  stop(): void {
    this.stopCapture();
  }

  dispose(): void {
    this.stopCapture();
    this.card.texture.dispose();
  }

  private async startCapture(info: MirrorDisplay): Promise<void> {
    const sourceId = info.sourceId!;
    try {
      // Chromium's desktop-capture constraints (Electron): capture the screen source directly.
      const constraints = {
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: sourceId,
            maxWidth: info.width,
            maxHeight: info.height,
            maxFrameRate: 60,
          },
        },
      } as unknown as MediaStreamConstraints;
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      if (this.sourceId !== sourceId) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      await video.play();
      const tex = new VideoTexture(video);
      tex.colorSpace = SRGBColorSpace;
      tex.minFilter = LinearFilter;
      tex.generateMipmaps = false;
      this.stream = stream;
      this.video = video;
      this.videoTexture = tex;
      this.playing = true;
      stream.getVideoTracks()[0]?.addEventListener('ended', () => {
        this.stopCapture();
        this.card.draw(info.name, 'Capture ended', this.accent);
      });
    } catch (err) {
      console.error('[capture]', err);
      this.sourceId = null;
      this.card.draw(info.name, `Capture failed: ${(err as Error).message ?? err}\nCheck Screen Recording permission (press P).`, '#ff5a5a');
    }
  }

  private stopCapture(): void {
    this.playing = false;
    this.sourceId = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.video) this.video.srcObject = null;
    this.video = null;
    this.videoTexture?.dispose();
    this.videoTexture = null;
  }
}
