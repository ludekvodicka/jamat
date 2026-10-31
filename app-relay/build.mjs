import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';

await mkdir(new URL('./dist/web/', import.meta.url), { recursive: true });
await Promise.all(['login.html', 'index.html', 'shared.js', 'computer.html'].map(file =>
  copyFile(new URL(`./web/${file}`, import.meta.url), new URL(`./dist/web/${file}`, import.meta.url))));
await build({ entryPoints: ['web/computer.js', 'web/computer.css'], bundle: true, platform: 'browser', format: 'esm',
  target: 'es2022', outdir: 'dist/web', logLevel: 'info' });
await build({ entryPoints: ['web/wakeServiceModel.ts'], bundle: true, platform: 'browser', format: 'iife',
  globalName: 'WakeServiceModel', target: 'es2022', outfile: 'dist/web/wakeServiceModel.js', logLevel: 'info' });
if (!process.argv.includes('--web-only'))
  await build({ entryPoints: ['start.ts'], bundle: true, platform: 'node', format: 'esm', packages: 'external',
    target: 'node24', outfile: 'dist/start.js', logLevel: 'info' });
