#!/usr/bin/env node
// Camera viewer: shows what the glasses' three cameras see, in a browser.
//
//   node tools/camera-viewer/server.mjs [--port 8787] [--no-rgb] [--log-level 0-3] [--fake]
//
// Runs helper/build/viture-camera-helper and relays its packets (see the
// header of helper/src/camera_helper.m) to the page over one streaming HTTP
// response per tab. --fake makes synthetic frames instead, to try the page
// without glasses. No dependencies beyond Node itself.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const port = Number(option('--port', 8787));
const helperPath = option('--helper', join(here, '../../helper/build/viture-camera-helper'));

const MAGIC = 0x4d414356;
const HEADER = 24;
const KIND = { stereo: 1, rgb: 2, status: 3 };

/** Open /stream responses; a client that can't keep up skips frames until it drains. */
const clients = new Set();
/** Status packets are replayed to new tabs so they know the current state. */
const lastStatus = new Map();

function broadcast(packet, kind) {
  if (kind === KIND.status) {
    const json = JSON.parse(packet.subarray(HEADER).toString());
    for (const key of Object.keys(json)) lastStatus.set(key, packet);
  }
  for (const c of clients) {
    if (c.busy && kind !== KIND.status) continue;
    if (!c.res.write(packet)) {
      c.busy = true;
      c.res.once('drain', () => (c.busy = false));
    }
  }
}

function packet(kind, width, height, payload) {
  const p = Buffer.alloc(HEADER + payload.length);
  p.writeUInt32LE(MAGIC, 0);
  p.writeUInt8(kind, 4);
  p.writeUInt16LE(width, 8);
  p.writeUInt16LE(height, 10);
  p.writeUInt32LE(payload.length, 12);
  p.writeDoubleLE(Date.now(), 16);
  payload.copy(p, HEADER);
  return p;
}

const status = (obj) => broadcast(packet(KIND.status, 0, 0, Buffer.from(JSON.stringify(obj))), KIND.status);

// ---- source: the native helper ----------------------------------------------

let helper = null;

function startHelper() {
  if (!existsSync(helperPath)) {
    console.error(`helper not found: ${helperPath}\nbuild it with:  make -C helper   (or run with --fake)`);
    process.exit(1);
  }
  const helperArgs = flag('--no-rgb') ? ['--no-rgb'] : [];
  if (option('--log-level')) helperArgs.push('--log-level', option('--log-level'));
  helper = spawn(helperPath, helperArgs, { stdio: ['pipe', 'pipe', 'inherit'] });
  let buf = Buffer.alloc(0);
  helper.stdout.on('data', (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= HEADER) {
      if (buf.readUInt32LE(0) !== MAGIC) {
        // Out of sync (should not happen): resync on the next magic.
        const next = buf.indexOf(Buffer.from('VCAM'), 1);
        buf = next < 0 ? Buffer.alloc(0) : buf.subarray(next);
        continue;
      }
      const total = HEADER + buf.readUInt32LE(12);
      if (buf.length < total) break;
      const p = Buffer.from(buf.subarray(0, total));
      buf = buf.subarray(total);
      broadcast(p, p.readUInt8(4));
    }
  });
  helper.on('exit', (code, signal) => {
    status({ status: 'error', message: `camera helper exited (${signal ?? code})` });
    console.error(`camera helper exited (${signal ?? code})`);
    helper = null;
  });
}

// ---- source: synthetic frames (--fake) -----------------------------------------

function startFake() {
  const W = 640, H = 480;
  status({ status: 'streaming', device: 'fake glasses', pid: 0 });
  status({ rgb: 'unsupported' });
  let t = 0;
  setInterval(() => {
    t++;
    const plane = Buffer.alloc(W * H * 2);
    // A checkerboard room with a moving bright blob; the right eye is shifted
    // a few pixels, like a real stereo pair.
    for (let eye = 0; eye < 2; eye++) {
      const shift = eye ? -12 : 0;
      const bx = W / 2 + Math.sin(t / 20) * 180 + shift, by = H / 2 + Math.cos(t / 27) * 120;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const cx = x - shift;
          let v = ((cx >> 5) + (y >> 5)) & 1 ? 70 : 40;
          v += (y / H) * 40;
          const d = (x - bx) ** 2 + (y - by) ** 2;
          if (d < 3600) v = 230 - d / 40;
          plane[eye * W * H + y * W + x] = v;
        }
      }
    }
    broadcast(packet(KIND.stereo, W, H, plane), KIND.stereo);
  }, 1000 / 30);
}

// ---- HTTP ------------------------------------------------------------------------

const server = createServer(async (req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(await readFile(join(here, 'index.html')));
  } else if (req.method === 'GET' && req.url === '/checkerboard') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(await readFile(join(here, 'checkerboard.html')));
  } else if (req.method === 'GET' && req.url === '/stream') {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store' });
    const c = { res, busy: false };
    for (const p of new Set(lastStatus.values())) res.write(p);
    clients.add(c);
    req.on('close', () => clients.delete(c));
  } else if (req.method === 'POST' && req.url === '/cmd') {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const line = body.trim();
      if (!/^(exposure (auto|[\d.]+ \d+)|pair [01]|rgb [01])$/.test(line)) {
        res.writeHead(400).end('bad command');
        return;
      }
      if (helper) helper.stdin.write(line + '\n');
      res.writeHead(204).end();
    });
  } else {
    res.writeHead(404).end();
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`camera viewer: http://localhost:${port}`);
  if (flag('--fake')) startFake();
  else startHelper();
});

const quit = () => {
  helper?.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGINT', quit);
process.on('SIGTERM', quit);
