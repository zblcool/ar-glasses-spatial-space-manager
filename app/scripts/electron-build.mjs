// Bundles the Electron main process and preload script with Vite (lib mode, CJS).
import { builtinModules } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const external = ['electron', ...builtinModules, ...builtinModules.map((m) => `node:${m}`)];

export async function buildElectron({ mode = 'production' } = {}) {
  for (const name of ['main', 'preload']) {
    await build({
      configFile: false,
      root: APP_DIR,
      mode,
      logLevel: 'warn',
      build: {
        outDir: 'dist-electron',
        emptyOutDir: false,
        minify: false,
        sourcemap: mode !== 'production',
        target: 'node22',
        lib: {
          entry: path.join(APP_DIR, `electron/${name}.ts`),
          formats: ['cjs'],
          fileName: () => `${name}.cjs`,
        },
        rolldownOptions: { external },
      },
    });
  }
}
