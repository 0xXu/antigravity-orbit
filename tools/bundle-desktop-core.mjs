import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const resourcesDir = path.join(rootDir, 'packages', 'desktop', 'src-tauri', 'resources');
const coreOutFile = path.join(resourcesDir, 'core', 'daemon.mjs');
const channelsSrcDir = path.join(rootDir, 'packages', 'runtime', 'dist', 'channels');
const channelsOutDir = path.join(resourcesDir, 'channels');

fs.rmSync(resourcesDir, { recursive: true, force: true });
fs.mkdirSync(path.dirname(coreOutFile), { recursive: true });
fs.mkdirSync(channelsOutDir, { recursive: true });

await esbuild.build({
  entryPoints: [path.join(rootDir, 'packages', 'core', 'dist', 'main.js')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node26',
  packages: 'bundle',
  outfile: coreOutFile,
  minify: false,
  legalComments: 'none',
});

if (!fs.existsSync(path.join(channelsSrcDir, 'manifest.json'))) {
  throw new Error(`Missing runtime channels manifest at ${channelsSrcDir}. Run npm run build first.`);
}

fs.cpSync(channelsSrcDir, channelsOutDir, { recursive: true });

const bytes = fs.statSync(coreOutFile).size;
console.log(
  `Bundled desktop core daemon -> ${path.relative(rootDir, coreOutFile)} (${bytes} bytes) + runtime channels`,
);
