// `npm run build`: production renderer bundle (dist/) + main/preload (dist-electron/).
// Run the result with `npm start`. Packaging into a .app is intentionally not set
// up yet because it involves redistributing the Viture SDK dylibs.
import path from 'node:path';
import { build } from 'vite';
import { APP_DIR, buildElectron } from './electron-build.mjs';

await build({ configFile: path.join(APP_DIR, 'vite.config.ts') });
await buildElectron();
console.log('[build] done — run `npm start`');
