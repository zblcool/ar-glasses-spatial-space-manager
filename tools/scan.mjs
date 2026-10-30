#!/usr/bin/env node
// One command for the 3D scanner:  npm run scan   (or double-click Scan.command)
//
//   1. builds the native helpers if needed (make -C helper), and the Object
//      Capture tool (tools/capture, Swift) that turns recordings into models;
//   2. makes a Python environment in tools/recon/.venv with numpy + OpenCV,
//      the first time and whenever requirements.txt changes;
//   3. starts the camera stream (tools/camera-viewer, port 8787) and the
//      reconstruction page (tools/recon, port 8788), and opens the page.
//
// The page calibrates the cameras on first use, then reconstructs. Ctrl-C
// stops everything. Arguments after `--` go to recon.py (see its --help).

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const recon = join(root, 'tools/recon');
const venv = join(recon, '.venv');
const python = join(venv, 'bin/python3');
const VIEWER_PORT = 8787, RECON_PORT = 8788;

const step = (msg) => console.log(`\n▸ ${msg}`);
const fail = (msg) => {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
};
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { stdio: 'inherit', cwd: root, ...opts }).status === 0;
const portBusy = (port) =>
  new Promise((resolve) => {
    const s = connect(port, '127.0.0.1');
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => resolve(false));
  });

if (process.platform !== 'darwin') fail('the glasses SDK is macOS (Apple Silicon) only');

step('native helpers');
if (!run('make', ['-C', 'helper', '--no-print-directory']))
  fail('building the helper failed. Is Xcode Command Line Tools installed?  xcode-select --install');

step('Object Capture tool');
const ocSrc = join(root, 'tools/capture/object_capture.swift'), ocBin = join(root, 'tools/capture/build/object-capture');
if (!existsSync(ocBin) || statSync(ocBin).mtimeMs < statSync(ocSrc).mtimeMs) {
  mkdirSync(dirname(ocBin), { recursive: true });
  // Not fatal: live scanning works without it, and the page tries again when you build a model.
  if (!run('swiftc', ['-O', '-parse-as-library', '-swift-version', '5', ocSrc, '-o', ocBin]))
    console.warn('could not build it (Xcode Command Line Tools?); photo models will not work, live scanning will');
}
console.log('ok');

step('Python environment');
const req = readFileSync(join(recon, 'requirements.txt'));
const want = createHash('sha1').update(req).digest('hex');
const stamp = join(venv, '.requirements-sha1');
if (!existsSync(stamp) || readFileSync(stamp, 'utf8') !== want) {
  if (!existsSync(python)) {
    console.log('first run: creating tools/recon/.venv (one minute or two)…');
    if (!run('python3', ['-m', 'venv', venv])) fail('python3 not found. Install it from python.org or with: brew install python');
  }
  if (!run(python, ['-m', 'pip', 'install', '--quiet', '--upgrade', 'pip']) || !run(python, ['-m', 'pip', 'install', '--quiet', '-r', join(recon, 'requirements.txt')]))
    fail('installing numpy / OpenCV failed (network?)');
  writeFileSync(stamp, want);
}
console.log('ok');

for (const port of [VIEWER_PORT, RECON_PORT])
  if (await portBusy(port)) fail(`port ${port} is in use. Is a previous scan still running? Close its terminal, then try again.`);

step('starting');
const children = [
  spawn(process.execPath, [join(root, 'tools/camera-viewer/server.mjs'), '--no-rgb', '--port', String(VIEWER_PORT)], { stdio: 'inherit' }),
  spawn(python, [join(recon, 'recon.py'), '--port', String(RECON_PORT), '--viewer-port', String(VIEWER_PORT), ...process.argv.slice(2)], { stdio: 'inherit', cwd: recon }),
];
let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  for (const c of children) c.kill('SIGTERM');
  setTimeout(() => process.exit(code), 300);
};
for (const c of children) c.on('exit', (code) => !stopping && (console.error('\n✗ a part stopped; shutting down'), stop(code || 1)));
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());

for (let i = 0; i < 100 && !(await portBusy(RECON_PORT)); i++) await new Promise((r) => setTimeout(r, 200));
const url = `http://localhost:${RECON_PORT}`;
spawn('open', [url], { stdio: 'ignore' }).on('error', () => {});
console.log(`\n✓ ${url} is open in your browser. Quit Viture Open Walker if it is running (both use the glasses). Ctrl-C here stops everything.\n`);
