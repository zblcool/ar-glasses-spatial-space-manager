import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { DisplaysState, HelperStatus, PoseSample, VowApi } from '../shared/types';

function subscribe<T>(channel: string, cb: (value: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, value: T) => cb(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: VowApi = {
  getConfig: () => ipcRenderer.invoke('config:get'),
  getStatus: () => ipcRenderer.invoke('status:get'),
  onWindowOnGlasses: (cb) => subscribe<boolean>('window:on-glasses', cb),
  getPanorama: () => ipcRenderer.invoke('panorama:get'),
  loadLayout: () => ipcRenderer.invoke('layout:load'),
  saveLayout: (layout) => ipcRenderer.invoke('layout:save', layout),
  onPose: (cb) => subscribe<PoseSample>('pose', cb),
  onStatus: (cb) => subscribe<HelperStatus>('helper:status', cb),
  toggleFullscreen: () => ipcRenderer.send('window:toggle-fullscreen'),
  moveToNextDisplay: () => ipcRenderer.send('window:next-display'),
  getDisplays: () => ipcRenderer.invoke('displays:get'),
  onDisplays: (cb) => subscribe<DisplaysState>('displays:state', cb),
  enterDisplay: (displayId, u, v) => ipcRenderer.send('displays:enter', displayId, u, v),
  onCursorDisplay: (cb) => subscribe<number | null>('displays:cursor', cb),
  openScreenRecordingSettings: () => ipcRenderer.send('displays:open-settings'),
  openAccessibilitySettings: () => ipcRenderer.send('displays:open-accessibility'),
  setGlasses3d: (on) => ipcRenderer.send('glasses:3d', on),
  setDof: (dof) => ipcRenderer.send('glasses:dof', dof),
  getSetup: () => ipcRenderer.invoke('setup:get'),
  requestScreenRecording: () => ipcRenderer.send('setup:request-screen'),
  requestAccessibility: () => ipcRenderer.send('setup:request-ax'),
  relaunch: () => ipcRenderer.send('app:relaunch'),
  enterImmersive: () => ipcRenderer.send('window:enter-immersive'),
  onShowSetup: (cb) => subscribe<void>('setup:show', cb),
  loadPrefs: () => ipcRenderer.invoke('prefs:load'),
  savePrefs: (prefs) => ipcRenderer.invoke('prefs:save', prefs),
};

contextBridge.exposeInMainWorld('vow', api);
