import { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, screen, session, shell, systemPreferences } from 'electron';
import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AppConfig, DisplaysState, HelperStatus, PanoramaPayload, Prefs, SetupState } from '../shared/types';
import { Displays } from './displays';
import { HelperProcess } from './helper';

// app/ in dev and `npm start`; the packaged (linked) app's loader points this at the repository.
const APP_ROOT = process.env.VOW_APP_ROOT ?? app.getAppPath();
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;

/** Optional user settings in <userData>/settings.json; env vars take precedence. */
interface Settings {
  panoramaPath?: string;
  fovY?: number;
  helperPath?: string;
  dof?: 3 | 6;
  maxHz?: number;
  predictMs?: number;
  /** Number of macOS virtual displays to create (0 disables). Default 2. */
  virtualDisplays?: number;
  virtualDisplayWidth?: number;
  virtualDisplayHeight?: number;
  virtualDisplayHiDPI?: boolean;
  virtualDisplayHz?: number;
}

/** Global shortcut that brings the cursor back from a mirrored display. */
const RETURN_SHORTCUT = 'Control+Alt+Escape';
/** Global escape hatch: leave immersive fullscreen and show the setup screen. */
const EXIT_SHORTCUT = 'Control+Alt+Q';

const userFile = (name: string) => path.join(app.getPath('userData'), name);

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Write-then-rename so a crash mid-write never leaves a truncated file. */
async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(`${file}.tmp`, JSON.stringify(value, null, 2));
  await rename(`${file}.tmp`, file);
}

/** Native helper binary: next to the app in a packaged build, else helper/build/ in the repo. */
function resolveBinary(name: string, override?: string): string | null {
  const candidates = [
    override,
    path.join(process.resourcesPath ?? '', `helper/${name}`),
    path.resolve(APP_ROOT, `../helper/build/${name}`),
  ].filter((p): p is string => !!p);
  return candidates.find((p) => existsSync(p)) ?? null;
}

function resolvePanorama(settings: Settings): string | null {
  const candidates = [
    process.env.PANORAMA_PATH,
    settings.panoramaPath,
    ...['jpg', 'jpeg', 'png', 'webp'].map((ext) => path.join(APP_ROOT, `assets/panorama.${ext}`)),
    // Dev convenience: a bg.* image in the repository root.
    ...['jpg', 'jpeg', 'png', 'webp'].map((ext) => path.resolve(APP_ROOT, `../bg.${ext}`)),
  ].filter((p): p is string => !!p);
  return candidates.find((p) => existsSync(p)) ?? null;
}

const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

const isGlasses = (d: Electron.Display) => /viture/i.test(d.label ?? '');

/**
 * Mirror everything written to stdout/stderr (our logs and the helpers' stderr)
 * into ~/Library/Logs/viture-open-walker/main.log, so problems in the packaged
 * app — which has no terminal — can be diagnosed afterwards.
 */
function startFileLog(): string {
  const dir = app.getPath('logs');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'main.log');
  let big = false;
  try {
    big = statSync(file).size > 5_000_000;
  } catch {
    /* no log yet */
  }
  const out = createWriteStream(file, { flags: big ? 'w' : 'a' });
  out.write(`\n===== ${new Date().toISOString()} start (pid ${process.pid}, root ${APP_ROOT}) =====\n`);
  for (const stream of [process.stdout, process.stderr]) {
    const orig = stream.write.bind(stream) as (chunk: unknown, ...rest: unknown[]) => boolean;
    stream.write = ((chunk: unknown, ...rest: unknown[]) => {
      out.write(typeof chunk === 'string' || chunk instanceof Uint8Array ? chunk : String(chunk));
      return orig(chunk, ...rest);
    }) as typeof stream.write;
  }
  return file;
}

function screenPermission(): SetupState['screen'] {
  try {
    return systemPreferences.getMediaAccessStatus('screen') as SetupState['screen'];
  } catch {
    return 'unknown';
  }
}

function setupState(): SetupState {
  return {
    screen: screenPermission(),
    accessibility: systemPreferences.isTrustedAccessibilityClient(false),
    glassesConnected: screen.getAllDisplays().some(isGlasses),
    immersive,
  };
}

/** Everything needed for immersive mode to be usable (otherwise the glasses would show nothing but us). */
const permissionsReady = () => screenPermission() === 'granted';

let win: BrowserWindow | null = null;
let helper: HelperProcess | null = null;
let displays: Displays | null = null;
let status: HelperStatus = { state: 'mock', mode: 'mock', restarts: 0 };
let immersive = false;

function sendStatus(s: HelperStatus) {
  status = s;
  win?.webContents.send('helper:status', s);
}

/**
 * Display the window is fullscreen on, pinned when entering fullscreen. Window
 * coordinates shift when the main display changes (the display arrangement is
 * moved), so re-deriving it from bounds would flip-flop.
 */
let fullscreenDisplayId: number | null = null;

/** The display the app window is on. */
function hostDisplay(): Electron.Display | null {
  if (!win) return null;
  if (fullscreenDisplayId !== null) {
    const pinned = screen.getAllDisplays().find((d) => d.id === fullscreenDisplayId);
    if (pinned) return pinned;
  }
  return screen.getDisplayMatching(win.getBounds());
}

/**
 * Immersive = cover one display completely: simple (Space-less) fullscreen at
 * screen-saver level, so other apps' windows on that display stay in the same
 * Space (where the display helper can find and move them) and never draw on top.
 */
/** Put the (non-fullscreen) window in the middle of a display. */
function placeOn(display: Electron.Display) {
  if (!win) return;
  const wa = display.workArea;
  const w = Math.min(1400, wa.width - 60);
  const h = Math.min(900, wa.height - 60);
  win.setBounds({ x: Math.round(wa.x + (wa.width - w) / 2), y: Math.round(wa.y + (wa.height - h) / 2), width: w, height: h });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const displayById = (id: number | null) => screen.getAllDisplays().find((d) => d.id === id);

/** Leave fullscreen and wait until macOS has finished the transition. */
function leaveFullscreen(): Promise<void> {
  if (!win?.isFullScreen()) return Promise.resolve();
  return new Promise((resolve) => {
    win!.once('leave-full-screen', () => resolve());
    win!.setFullScreen(false);
    setTimeout(resolve, 3000);
  });
}

/**
 * Immersive = native macOS fullscreen on the given display (what the first
 * version did, and what works on the glasses).
 *
 * Order matters: display reconfiguration (main-display switch, restore, 3D
 * mode) must never happen while the window is fullscreen — macOS can detach
 * the fullscreen Space from the glasses, leaving the app unreachable. So:
 * enter = switch main display → let it settle → go fullscreen;
 * leave = leave fullscreen → restore (in the leave-full-screen handler).
 */
async function setImmersive(on: boolean, display = hostDisplay()) {
  if (!win || !display) return;
  console.log(`[main] immersive ${on ? 'on' : 'off'} requested (${display.label || display.id})`);
  if (!on) {
    await leaveFullscreen();
    return;
  }
  if (win.isFullScreen()) {
    if (fullscreenDisplayId === display.id) return;
    await leaveFullscreen();
    await sleep(500);
  }
  placeOn(display);
  if (isGlasses(display) && permissionsReady() && displays) {
    await displays.beginImmersive(display.id);
    await sleep(800); // let WindowServer finish rearranging before fullscreen
  }
  // The arrangement may have moved the glasses; place the window on them again.
  const target = displayById(display.id) ?? display;
  placeOn(target);
  fullscreenDisplayId = target.id;
  win.setFullScreen(true);
}

/** Run a display reconfiguration (e.g. 3D switch) with fullscreen paused around it. */
async function withFullscreenPaused(fn: () => Promise<void>) {
  const was = win?.isFullScreen() ? fullscreenDisplayId : null;
  if (was !== null) {
    await leaveFullscreen();
    await sleep(1200); // leave-full-screen also restores the arrangement
  }
  await fn();
  const d = displayById(was);
  if (d) await setImmersive(true, d);
}

function createWindow(autoEnter: boolean) {
  const glasses = screen.getAllDisplays().find(isGlasses);
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    backgroundColor: '#000000',
    title: 'Viture Open Walker',
    webPreferences: {
      preload: path.join(APP_ROOT, 'dist-electron/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Keep rendering at full rate when the glasses display is not focused.
      backgroundThrottling: false,
    },
  });
  // Always start as a normal window (on the glasses if connected) showing the
  // setup card. Go fullscreen straight away only if the user opted in and capture works.
  if (glasses) placeOn(glasses);
  win.once('ready-to-show', () => {
    win?.show();
    if (glasses && autoEnter && permissionsReady()) void setImmersive(true, glasses);
  });
  win.on('enter-full-screen', () => {
    // Fullscreen entered by other means (green button) — pin whatever it's on now.
    fullscreenDisplayId ??= screen.getDisplayMatching(win!.getBounds()).id;
    const d = hostDisplay();
    immersive = !!d && isGlasses(d);
    console.log(`[main] fullscreen on ${d?.label || d?.id}${immersive ? ' (glasses: immersive)' : ''}`);
    displays?.refresh();
  });
  win.on('leave-full-screen', () => {
    const was = fullscreenDisplayId;
    fullscreenDisplayId = null;
    immersive = false;
    console.log('[main] left fullscreen');
    // Only now (no longer fullscreen) put the display arrangement back.
    displays?.endImmersive();
    setTimeout(() => {
      const d = displayById(was);
      if (d) placeOn(d);
    }, 900);
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    if (!DEV_SERVER_URL || !url.startsWith(DEV_SERVER_URL)) e.preventDefault();
  });
  win.webContents.on('did-finish-load', () => {
    win?.webContents.send('helper:status', status);
    if (displays) win?.webContents.send('displays:state', displays.getState());
    if (process.env.VOW_SCREENSHOT) void captureAndQuit(process.env.VOW_SCREENSHOT);
  });
  win.webContents.on('console-message', (e) => {
    if (DEV_SERVER_URL || e.level === 'error') console.log(`[renderer:${e.level}] ${e.message}`);
  });
  win.webContents.on('render-process-gone', (_e, d) => console.error(`[main] renderer gone: ${d.reason}`));
  win.on('closed', () => (win = null));

  // When the window changes display: pick the FOV, re-cover the display in
  // immersive mode (e.g. glasses switched to 3840-wide SBS), refresh mirroring.
  const onDisplayChange = () => {
    const d = hostDisplay();
    if (!win || !d) return;
    win.webContents.send('window:on-glasses', isGlasses(d));
    displays?.refresh();
  };
  // Glasses plugged in while running: bring the window over and show the setup card.
  let hadGlasses = !!glasses;
  screen.on('display-added', () => {
    const g = screen.getAllDisplays().find(isGlasses);
    if (g && !hadGlasses && win && !win.isFullScreen()) {
      placeOn(g);
      win.webContents.send('setup:show');
    }
    hadGlasses = !!g;
  });
  screen.on('display-removed', () => {
    hadGlasses = screen.getAllDisplays().some(isGlasses);
  });
  for (const ev of ['moved', 'resize', 'enter-full-screen', 'leave-full-screen'] as const) win.on(ev as 'moved', onDisplayChange);
  win.webContents.on('did-finish-load', onDisplayChange);
  for (const ev of ['display-added', 'display-removed', 'display-metrics-changed'] as const) screen.on(ev as 'display-added', onDisplayChange);

  if (DEV_SERVER_URL) void win.loadURL(DEV_SERVER_URL);
  else void win.loadFile(path.join(APP_ROOT, 'dist/index.html'));
}

/**
 * Verification aid: VOW_SCREENSHOT=/path/out.png captures the window once the
 * scene is ready (plus VOW_SCREENSHOT_DELAY ms, default 1500) and quits.
 * VOW_EVAL runs a script in the page first.
 */
async function captureAndQuit(file: string) {
  const w = win;
  if (!w) return;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !(await w.webContents.executeJavaScript('!!window.__vowReady'))) {
    await new Promise((r) => setTimeout(r, 100));
  }
  if (process.env.VOW_EVAL) console.log('[main] VOW_EVAL ->', await w.webContents.executeJavaScript(process.env.VOW_EVAL));
  await new Promise((r) => setTimeout(r, Number(process.env.VOW_SCREENSHOT_DELAY) || 1500));
  const stats = await w.webContents.executeJavaScript("document.getElementById('debug').textContent");
  console.log(`[main] debug overlay at capture:\n${stats}`);
  const img = await w.webContents.capturePage();
  await writeFile(file, img.toPNG());
  console.log(`[main] screenshot written to ${file}`);
  app.quit();
}

function helperArgs(settings: Settings, dof: 3 | 6): string[] {
  return [
    '--dof', String(dof),
    '--max-hz', String(Number(process.env.VITURE_MAX_HZ) || settings.maxHz || 250),
    '--predict-ms', String(Number(process.env.VITURE_PREDICT_MS) || settings.predictMs || 0),
  ];
}

async function main() {
  await app.whenReady();
  const logFile = startFileLog();
  console.log(`[main] logging to ${logFile}; screen recording: ${screenPermission()}, accessibility: ${systemPreferences.isTrustedAccessibilityClient(false)}`);
  const settings = (await readJson<Settings>(userFile('settings.json'))) ?? {};
  const saveSettings = (patch: Partial<Settings>) => {
    Object.assign(settings, patch);
    void writeJson(userFile('settings.json'), settings);
  };

  const helperPath = resolveBinary('viture-pose-helper', process.env.VITURE_HELPER ?? settings.helperPath);
  const mock = process.env.MOCK_HEAD === '1' || !helperPath;
  let dof: 3 | 6 = Number(process.env.VITURE_DOF) === 6 || settings.dof === 6 ? 6 : 3;
  const config: AppConfig = {
    mock,
    dof,
    // 29° ≈ vertical FOV of the glasses (assumed 52° diagonal, 16:10). On a laptop/monitor a
    // wider view is more usable. FOV_Y / settings.fovY force one value everywhere.
    fovGlasses: Number(process.env.FOV_Y) || settings.fovY || 29,
    fovDesktop: Number(process.env.FOV_Y) || settings.fovY || 50,
  };

  ipcMain.handle('config:get', () => config);
  ipcMain.handle('status:get', () => status);
  ipcMain.handle('panorama:get', async (): Promise<PanoramaPayload | null> => {
    const file = resolvePanorama(settings);
    if (!file) return null;
    const mime = MIME[path.extname(file).toLowerCase()];
    if (!mime) {
      console.warn(`[main] unsupported panorama type: ${file}`);
      return null;
    }
    const buf = await readFile(file);
    const data = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    return { name: path.basename(file), mime, data };
  });
  ipcMain.handle('layout:load', () => readJson(userFile('layout.json')));
  ipcMain.handle('layout:save', (_e, layout: unknown) => writeJson(userFile('layout.json'), layout));
  ipcMain.handle('prefs:load', () => readJson<Partial<Prefs>>(userFile('prefs.json')));
  ipcMain.handle('prefs:save', (_e, prefs: Prefs) => writeJson(userFile('prefs.json'), prefs));

  // Screen capture of mirrored displays and the camera (Hands): allow media requests from our own page only.
  const ownPage = (url: string) => (DEV_SERVER_URL ? url.startsWith(DEV_SERVER_URL) : url.startsWith('file://'));
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => cb(permission === 'media' && ownPage(wc.getURL())));
  session.defaultSession.setPermissionCheckHandler((wc, permission) => permission === 'media' && !!wc && ownPage(wc.getURL()));

  const emptyDisplays: DisplaysState = { status: 'off', displays: [], permission: 'unknown', accessibility: null, immersive: false };
  ipcMain.handle('displays:get', () => displays?.getState() ?? emptyDisplays);
  ipcMain.on('displays:enter', (_e, id: number, u: number, v: number) => displays?.warp(id, u, v));
  ipcMain.on('displays:open-settings', () =>
    void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'),
  );
  ipcMain.on('displays:open-accessibility', () =>
    void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility'),
  );
  // 3D and virtual displays don't fit in the display bandwidth together (M2): pause
  // the virtual displays before going 3D, bring them back after returning to 2D.
  ipcMain.on('glasses:3d', (_e, on: boolean) => {
    void withFullscreenPaused(async () => {
      if (on) {
        await (displays?.pauseVirtual() ?? Promise.resolve());
        helper?.send('display3d 1');
        await sleep(3000); // glasses re-sync to 3840-wide
      } else {
        helper?.send('display3d 0');
        await sleep(3000); // let the glasses settle back to 2D first
        displays?.resumeVirtual();
        await sleep(4000); // virtual displays come back (with bandwidth check)
      }
    });
  });
  ipcMain.on('glasses:dof', (_e, next: 3 | 6) => {
    if (next === dof) return;
    dof = next;
    config.dof = next;
    saveSettings({ dof: next });
    void helper?.restart(helperArgs(settings, next));
  });
  ipcMain.handle('setup:get', () => setupState());
  ipcMain.on('setup:request-screen', () => {
    // Asking for sources triggers the system prompt (first time); then show the settings page.
    void desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } }).catch(() => {});
    void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  });
  ipcMain.on('setup:request-ax', () => {
    systemPreferences.isTrustedAccessibilityClient(true); // shows the system prompt
    void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
  });
  ipcMain.on('app:relaunch', () => {
    app.relaunch();
    app.quit();
  });
  ipcMain.on('window:enter-immersive', () => {
    const d = screen.getAllDisplays().find(isGlasses) ?? hostDisplay();
    if (d) void setImmersive(true, d);
  });
  ipcMain.on('window:toggle-fullscreen', () => void setImmersive(!win?.isFullScreen()));
  ipcMain.on('window:next-display', () => {
    if (!win) return;
    const all = screen.getAllDisplays();
    const current = hostDisplay();
    const next = all[(all.findIndex((d) => d.id === current?.id) + 1) % all.length];
    if (win.isFullScreen()) void setImmersive(true, next);
    else placeOn(next);
  });

  if (mock) {
    const why = process.env.MOCK_HEAD === '1' ? 'MOCK_HEAD=1' : 'helper binary not found';
    console.log(`[main] mock head mode (${why})`);
    status = { state: 'mock', mode: 'mock', detail: why, restarts: 0 };
  } else {
    status = { state: 'starting', mode: 'real', restarts: 0 };
  }
  const prefs = (await readJson<Partial<Prefs>>(userFile('prefs.json'))) ?? {};
  createWindow(prefs.autoEnter === true);

  const vdCount = Number(process.env.VOW_VIRTUAL_DISPLAYS ?? settings.virtualDisplays ?? 2);
  displays = new Displays({
    binary: vdCount > 0 ? resolveBinary('viture-display-helper') : null,
    args: [
      '--count', String(vdCount),
      '--width', String(settings.virtualDisplayWidth ?? 1920),
      '--height', String(settings.virtualDisplayHeight ?? 1080),
      '--hidpi', settings.virtualDisplayHiDPI ? '1' : '0',
      // 50 Hz leaves display-bandwidth headroom for the glasses (the helper falls back further if needed).
      '--hz', String(settings.virtualDisplayHz ?? 50),
      '--state-file', userFile('display-arrangement.json'),
    ],
    hostDisplay: () => hostDisplay()?.id ?? null,
    onState: (s) => win?.webContents.send('displays:state', s),
    onCursor: (id) => win?.webContents.send('displays:cursor', id),
  });
  displays.start();

  const ok = globalShortcut.register(RETURN_SHORTCUT, () => {
    if (!win) return;
    const b = win.getBounds();
    displays?.warpGlobal(Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2));
    win.show();
    app.focus({ steal: true });
    win.focus();
  });
  if (!ok) console.warn(`[main] could not register ${RETURN_SHORTCUT}`);
  const okExit = globalShortcut.register(EXIT_SHORTCUT, () => {
    if (!win) return;
    void setImmersive(false);
    win.show();
    app.focus({ steal: true });
    win.focus();
    win.webContents.send('setup:show');
  });
  if (!okExit) console.warn(`[main] could not register ${EXIT_SHORTCUT}`);

  if (!mock) {
    const args = helperArgs(settings, dof);
    console.log(`[main] starting helper ${helperPath} ${args.join(' ')}`);
    helper = new HelperProcess({
      binary: helperPath!,
      args,
      onPose: (pose) => win?.webContents.send('pose', pose),
      onStatus: sendStatus,
    });
    helper.start();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(false);
  });
}

let quitting = false;
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('before-quit', (e) => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  // The display helper restores the original display arrangement on its way out;
  // the pose helper restores the glasses' 2D mode.
  displays?.stop();
  const wait = helper ? helper.stop() : Promise.resolve();
  void Promise.all([wait, new Promise((r) => setTimeout(r, 600))]).finally(() => app.quit());
});
app.on('window-all-closed', () => app.quit());

void main();
