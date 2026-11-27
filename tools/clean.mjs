import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const targets = [
  'packages/shared/dist',
  'packages/shared/tsconfig.tsbuildinfo',
  'packages/core/dist',
  'packages/core/tsconfig.tsbuildinfo',
  'packages/runtime/dist',
  'packages/runtime/tsconfig.tsbuildinfo',
  'packages/desktop/dist',
  'packages/desktop/tsconfig.tsbuildinfo',
  'packages/desktop/src-tauri/resources',
  'coverage',
];

for (const rel of targets) {
  fs.rmSync(path.join(rootDir, rel), { recursive: true, force: true });
}

console.log(`Cleaned ${targets.length} build paths.`);
