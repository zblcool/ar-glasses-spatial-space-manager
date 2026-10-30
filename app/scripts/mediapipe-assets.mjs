// Puts the hand-tracking runtime under assets/public/mediapipe/ (served next to
// the renderer, so nothing is fetched from a CDN at runtime):
//   - the MediaPipe Tasks Vision WASM, copied from node_modules (pinned in package.json)
//   - the HandLandmarker model, downloaded once and checked against a pinned hash
// Runs on `npm install`; safe to re-run (it skips files that are already right).
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { APP_DIR } from './electron-build.mjs';

const require = createRequire(import.meta.url);
const OUT = path.join(APP_DIR, 'assets/public/mediapipe');
const WASM_DIR = path.join(path.dirname(require.resolve('@mediapipe/tasks-vision')), 'wasm');
const WASM = ['vision_wasm_internal.js', 'vision_wasm_internal.wasm'];
const MODEL = {
  file: 'hand_landmarker.task',
  url: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
  sha256: 'fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1',
};

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const same = (a, b) => existsSync(b) && sha256(readFileSync(a)) === sha256(readFileSync(b));

mkdirSync(OUT, { recursive: true });
for (const f of WASM) {
  const src = path.join(WASM_DIR, f);
  const dst = path.join(OUT, f);
  if (!same(src, dst)) copyFileSync(src, dst);
}

const model = path.join(OUT, MODEL.file);
if (existsSync(model) && sha256(readFileSync(model)) === MODEL.sha256) {
  console.log('[mediapipe] assets ready');
} else {
  console.log(`[mediapipe] downloading ${MODEL.file}…`);
  try {
    const res = await fetch(MODEL.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (sha256(buf) !== MODEL.sha256) throw new Error('checksum mismatch');
    writeFileSync(`${model}.part`, buf);
    renameSync(`${model}.part`, model);
    console.log('[mediapipe] assets ready');
  } catch (err) {
    // Not fatal: everything else works, the Hands toggle just reports the missing model.
    console.warn(`[mediapipe] could not fetch the hand model (${err.message}); hand tracking stays unavailable until \`node scripts/mediapipe-assets.mjs\` succeeds`);
  }
}
