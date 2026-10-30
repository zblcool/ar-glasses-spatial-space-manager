// `npm run dev`: Vite dev server for the renderer + bundled main/preload + Electron.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import { APP_DIR, buildElectron } from './electron-build.mjs';

const require = createRequire(import.meta.url);
const electronBin = require('electron'); // path to the Electron executable

const server = await createServer({ configFile: path.join(APP_DIR, 'vite.config.ts') });
await server.listen();
const url = server.resolvedUrls.local[0];
console.log(`[dev] renderer at ${url}`);

await buildElectron({ mode: 'development' });

const child = spawn(electronBin, ['.'], {
  cwd: APP_DIR,
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: url },
});

const shutdown = async (code) => {
  await server.close();
  process.exit(code ?? 0);
};
child.on('exit', (code) => void shutdown(code));
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => child.kill('SIGTERM'));
}
