import type { VowApi } from '../../shared/types';

declare global {
  interface Window {
    vow?: VowApi;
  }
}

const LAYOUT_KEY = 'vow.layout';

/**
 * Fallback used when the renderer is opened in a plain browser (e.g. the Vite
 * URL), so the scene can still be developed without Electron. Always mock.
 */
const browserFallback: VowApi = {
  getConfig: async () => ({ mock: true, dof: 3, fovGlasses: 29, fovDesktop: 50 }),
  onWindowOnGlasses: () => () => {},
  getStatus: async () => ({ state: 'mock', mode: 'mock', detail: 'browser preview', restarts: 0 }),
  getPanorama: async () => null,
  loadLayout: async () => {
    try {
      const raw = localStorage.getItem(LAYOUT_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },
  saveLayout: async (layout) => {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    } catch {
      /* storage unavailable */
    }
  },
  onPose: () => () => {},
  onStatus: () => () => {},
  toggleFullscreen: () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen();
  },
  moveToNextDisplay: () => {},
  getDisplays: async () => ({ status: 'off', detail: 'browser preview', displays: [], permission: 'unknown', accessibility: null, immersive: false }),
  onDisplays: () => () => {},
  enterDisplay: () => {},
  onCursorDisplay: () => () => {},
  openScreenRecordingSettings: () => {},
  openAccessibilitySettings: () => {},
  setGlasses3d: () => {},
  setDof: () => {},
  getSetup: async () => ({ screen: 'unknown', accessibility: false, glassesConnected: false, immersive: false }),
  requestScreenRecording: () => {},
  requestAccessibility: () => {},
  relaunch: () => location.reload(),
  enterImmersive: () => {},
  onShowSetup: () => () => {},
  loadPrefs: async () => {
    try {
      return JSON.parse(localStorage.getItem('vow.prefs') ?? 'null');
    } catch {
      return null;
    }
  },
  savePrefs: async (prefs) => {
    try {
      localStorage.setItem('vow.prefs', JSON.stringify(prefs));
    } catch {
      /* storage unavailable */
    }
  },
};

export const vow: VowApi = window.vow ?? browserFallback;
export const inElectron = !!window.vow;

/** Wall-clock milliseconds on the same timebase as the helper's `t` field. */
export const epochNow = (): number => performance.timeOrigin + performance.now();
