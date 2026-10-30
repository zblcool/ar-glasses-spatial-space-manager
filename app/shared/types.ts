// Types shared by the main process, preload, and renderer.

/**
 * One head-pose sample. Identical shape for the real helper and mock mode.
 * Coordinates are OpenGL / three.js: x right, y up, z backward.
 */
export interface PoseSample {
  /** Wall-clock time (epoch ms) when the pose was read; compare with performance.timeOrigin + performance.now(). */
  t: number;
  /** Orientation quaternion [x, y, z, w]. */
  q: [number, number, number, number];
  /** Position in metres; present only when 6DoF tracking is active. */
  p?: [number, number, number];
}

export type HelperState =
  | 'mock' // no helper; renderer generates poses from the mouse
  | 'starting'
  | 'searching' // helper running, no glasses on the USB bus
  | 'tracking'
  | 'lost' // glasses unplugged mid-session
  | 'error' // helper reported an SDK error (it retries on its own)
  | 'crashed' // helper process exited unexpectedly; main will restart it
  | 'stopped';

export interface HelperStatus {
  state: HelperState;
  mode: 'real' | 'mock';
  detail?: string;
  device?: string;
  dof?: number;
  stable?: boolean;
  restarts: number;
  /** Epoch ms of the next restart attempt when state === 'crashed'. */
  retryAt?: number;
  /** Glasses display mode as reported by the helper (null mode = could not be read). */
  display?: { mode: number | null; is3d: boolean; error?: string };
}

export interface AppConfig {
  mock: boolean;
  /** Head-tracking mode the helper was started with. */
  dof: 3 | 6;
  /** Vertical FOV (degrees) while the window is on the VITURE display. */
  fovGlasses: number;
  /** Vertical FOV (degrees) on any other display (laptop / monitor). */
  fovDesktop: number;
}

export interface PanoramaPayload {
  name: string;
  mime: string;
  data: ArrayBuffer;
}

/** A display mirrored into the 3D space: one of our virtual displays or a physical one. */
export interface MirrorDisplay {
  /** CGDirectDisplayID. */
  id: number;
  /** Stable key for the saved layout ("vd1", "vd2", "display-<id>"). */
  key: string;
  name: string;
  kind: 'virtual' | 'physical';
  /** Capture size in pixels (aspect = display aspect). */
  width: number;
  height: number;
  /** desktopCapturer source id for getUserMedia, or null if not (yet) visible to capture. */
  sourceId: string | null;
  /** Currently the macOS main display (menu bar, Dock, new windows). */
  isMain: boolean;
}

export interface DisplaysState {
  /** Status of the virtual displays (physical displays are mirrored regardless). */
  status: 'off' | 'unavailable' | 'starting' | 'ready' | 'error';
  detail?: string;
  /** Every display except the one the app window is on, virtual ones first. */
  displays: MirrorDisplay[];
  /** macOS Screen Recording permission for this app. */
  permission: 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown';
  /** Accessibility permission (needed to move windows off the glasses); null = not needed yet. */
  accessibility: boolean | null;
  /** True while the app is on the glasses: main display switched, glasses kept clear of windows. */
  immersive: boolean;
}

/** Permission / onboarding state for the setup screen. */
export interface SetupState {
  screen: DisplaysState['permission'];
  accessibility: boolean;
  /** The VITURE display is connected. */
  glassesConnected: boolean;
  /** The app window is currently fullscreen on the glasses. */
  immersive: boolean;
}

/** Renderer preferences persisted in <userData>/prefs.json. */
export interface Prefs {
  anchor: 'spatial' | 'smooth' | 'head';
  ambient: boolean;
  /** Side-by-side stereo preview when no glasses are in 3D mode. */
  stereoPreview: boolean;
  smoothing: number;
  ipd: number;
  /** Go fullscreen on the glasses at launch without showing the setup card. */
  autoEnter: boolean;
  /** Hand-tracking pointer from the Mac's camera (ray + pinch). */
  hands: boolean;
  /** Camera for Hands: the Mac's (default, more reliable) or the glasses' front camera. */
  handsCamera: 'mac' | 'glasses';
  /**
   * Background: the panorama image, or none (black, so the grid and screens
   * stand alone). A string so more skyboxes can be added later.
   */
  skybox: 'panorama' | 'off';
  /** Glowing wireframe floor to the horizon (depth cue). */
  grid: boolean;
}

/** API exposed on window.vow by the preload script. */
export interface VowApi {
  getConfig(): Promise<AppConfig>;
  getStatus(): Promise<HelperStatus>;
  /** Whether the app window is currently on the glasses' display. */
  onWindowOnGlasses(cb: (onGlasses: boolean) => void): () => void;
  getPanorama(): Promise<PanoramaPayload | null>;
  loadLayout(): Promise<unknown | null>;
  saveLayout(layout: unknown): Promise<void>;
  onPose(cb: (pose: PoseSample) => void): () => void;
  onStatus(cb: (status: HelperStatus) => void): () => void;
  toggleFullscreen(): void;
  moveToNextDisplay(): void;
  getDisplays(): Promise<DisplaysState>;
  onDisplays(cb: (state: DisplaysState) => void): () => void;
  /** Move the real cursor onto a mirrored display at normalised (u, v); v = 0 is the bottom edge. */
  enterDisplay(displayId: number, u: number, v: number): void;
  /** Fired when the cursor moves onto (id) or off (null) a virtual display. */
  onCursorDisplay(cb: (displayId: number | null) => void): () => void;
  openScreenRecordingSettings(): void;
  openAccessibilitySettings(): void;
  /** Ask the glasses to switch to SBS 3D (true) or 2D. */
  setGlasses3d(on: boolean): void;
  /** Restart head tracking in 3DoF or 6DoF (persisted). */
  setDof(dof: 3 | 6): void;
  getSetup(): Promise<SetupState>;
  /** Trigger the macOS Screen Recording prompt and open its settings page. */
  requestScreenRecording(): void;
  /** Trigger the macOS Accessibility prompt and open its settings page. */
  requestAccessibility(): void;
  /** Quit and reopen (permissions take effect after a relaunch). */
  relaunch(): void;
  /** Go fullscreen on the glasses (immersive mode). */
  enterImmersive(): void;
  /** Main tells the renderer to show the setup screen (e.g. after ⌃⌥Q). */
  onShowSetup(cb: () => void): () => void;
  loadPrefs(): Promise<Partial<Prefs> | null>;
  savePrefs(prefs: Prefs): Promise<void>;
}
