// `npm run package`: build the code and make sure "Viture Open Walker.app"
// exists, for this Mac only (ad-hoc signed, not notarized).
//
// The bundle is a *linked* launcher: Electron's runtime plus a tiny constant
// loader that runs the app code from this repository (app/dist, app/dist-electron,
// helper/build). Rebuilding the code therefore never changes the signed bundle,
// so its code identity (cdhash) stays the same and macOS keeps the Screen
// Recording / Accessibility permissions you granted. (An ad-hoc signed app's
// identity *is* its cdhash; any change to the bundle makes macOS treat it as a
// new app that must be granted again.)
//
// The bundle is only re-created when the loader or the Electron version changes;
// the script prints the cdhash and says whether permissions need re-granting.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { APP_DIR } from './electron-build.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(APP_DIR, '..');
const NAME = 'Viture Open Walker';
const OUT_DIR = path.join(APP_DIR, 'release');
const APP = path.join(OUT_DIR, `${NAME}.app`);
const APP_RES = path.join(APP, 'Contents/Resources/app');
const force = process.argv.includes('--force');

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', ...opts });
const step = (msg) => console.log(`\n[package] ${msg}`);
// codesign prints its details on stderr.
const cdhash = () => spawnSync('codesign', ['-dvvv', APP], { encoding: 'utf8' }).stderr.match(/CDHash=(\w+)/)?.[1] ?? null;

step('building renderer + main');
run('node', [path.join(APP_DIR, 'scripts/build.mjs')]);

step('building native helpers');
run('make', ['-C', path.join(ROOT, 'helper')]);

// Everything inside the bundle is derived from these, so identical inputs give an identical bundle.
const electronVersion = require('electron/package.json').version;
const loader = [
  '// Linked build: run the app code from the repository, so rebuilding the code',
  '// never changes this signed bundle (and macOS keeps its permissions).',
  `process.env.VOW_APP_ROOT = ${JSON.stringify(APP_DIR)};`,
  `require(${JSON.stringify(path.join(APP_DIR, 'dist-electron/main.cjs'))});`,
  '',
].join('\n');
const pkg = JSON.stringify({ name: 'viture-open-walker', version: '1.0.0', main: 'loader.cjs', electron: electronVersion }, null, 2) + '\n';

const upToDate =
  !force &&
  existsSync(path.join(APP_RES, 'loader.cjs')) &&
  readFileSync(path.join(APP_RES, 'loader.cjs'), 'utf8') === loader &&
  readFileSync(path.join(APP_RES, 'package.json'), 'utf8') === pkg;

const before = existsSync(APP) ? cdhash() : null;
if (upToDate) {
  step('app bundle unchanged (code runs from the repo) — not touching it');
} else {
  step('creating the app bundle');
  const electronApp = path.join(path.dirname(require.resolve('electron/package.json')), 'dist/Electron.app');
  rmSync(APP, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  run('ditto', [electronApp, APP]); // ditto keeps framework symlinks intact
  const plist = path.join(APP, 'Contents/Info.plist');
  for (const [key, value] of [
    ['CFBundleName', NAME],
    ['CFBundleDisplayName', NAME],
    ['CFBundleIdentifier', 'local.viture-open-walker'],
    // Electron's own string is generic; macOS shows this in the camera prompt (Hands toggle).
    ['NSCameraUsageDescription', 'Viture Open Walker uses the camera only for hand tracking (point and pinch), when you turn on Hands. Video stays on this Mac.'],
  ]) {
    run('plutil', ['-replace', key, '-string', value, plist]);
  }
  rmSync(path.join(APP, 'Contents/Resources/default_app.asar'), { force: true });
  mkdirSync(APP_RES, { recursive: true });
  writeFileSync(path.join(APP_RES, 'package.json'), pkg);
  writeFileSync(path.join(APP_RES, 'loader.cjs'), loader);
  step('ad-hoc signing the bundle');
  run('codesign', ['--force', '--deep', '--sign', '-', APP]);
}
run('codesign', ['--verify', '--deep', '--strict', APP]);

const after = cdhash();
console.log(`\n[package] done: ${path.relative(ROOT, APP)}`);
console.log(`  code identity (cdhash): ${after}`);
if (before && before === after) console.log('  ✓ same identity as before: existing permissions still apply');
else if (before) console.log('  ⚠ identity changed: re-grant Screen Recording and Accessibility (toggle off/on in System Settings)');
else console.log('  first build: grant Screen Recording and Accessibility on first launch');
console.log(`  Uses the code in ${path.relative(ROOT, APP_DIR) || '.'}/ and helper/build/ — keep the repository where it is.`);
console.log('  Open it with:  open "app/release/Viture Open Walker.app"');
