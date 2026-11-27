import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const runtimeDir = path.join(rootDir, 'packages', 'runtime');
const orbitDir = path.join(runtimeDir, 'src', 'optics-engine');
const outDir = path.join(runtimeDir, 'dist', 'channels');
const rootPkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));

/**
 * Optical, theme & animation runtime modules bundled into ch01-core.
 * Built-in telemetry / mascot modules are omitted so Antigravity Orbit's
 * Hybrid HUD (ch02-hud) remains the sole telemetry surface.
 */
const ORBIT_CORE_PARTS = [
  'i18n-core.js',
  'crystal-optics-core.js',
  'animated-icons.js',
  'motion-engine.js',
  'ripple-core.js',
  'conv-aura.js',
  'smooth-caret.js',
  'home-ripple-host.js',
  'model-glyph-crystal.js',
  'stream-choreography.js',
  'optics-rim-canvas.js',
  'host-workbench-enhancer.js',
  'context-menu-btw.js',
  'ui-runtime.js',
];

/**
 * 8-module WebGL2 3D mechanical keyboard / periodic model picker
 * bundled into on-demand ch09-optics-picker (0-byte unloaded when picker3d is off or silent-eco).
 */
const PERIODIC_PICKER_PARTS = [
  'pbr-grain-assets.js',
  'audio-fx.js',
  'model-catalog.js',
  'host-bridge.js',
  'oled-cyber-screen.js',
  'keyboard-3d-gl.js',
  'bento-ui.js',
  'periodic-picker.js',
];

function compileUmdBatch(baseDir, fileNames) {
  const chunks = [];
  for (const name of fileNames) {
    const raw = fs.readFileSync(path.join(baseDir, name), 'utf8');
    const transformed = esbuild.transformSync(raw, {
      loader: 'js',
      target: 'chrome128',
      charset: 'utf8',
      minify: true,
      legalComments: 'none',
    });
    chunks.push(transformed.code.trim());
  }
  return `(function(){var module,exports;\n${chunks.join(';\n')}\n})();\n`;
}

function compileMinifiedCss(cssPath) {
  const raw = fs.readFileSync(cssPath, 'utf8');
  return esbuild.transformSync(raw, {
    loader: 'css',
    charset: 'utf8',
    minify: true,
    legalComments: 'none',
  }).code;
}

const orbitCssMin = compileMinifiedCss(path.join(orbitDir, 'style.css'));
const orbitCorePrefix = compileUmdBatch(orbitDir, ORBIT_CORE_PARTS);
const periodicPickerDir = path.join(orbitDir, 'periodic-picker');
const hasPeriodicPickerSource = PERIODIC_PICKER_PARTS.every((name) => fs.existsSync(path.join(periodicPickerDir, name)));
const periodicPickerPrefix = hasPeriodicPickerSource ? compileUmdBatch(periodicPickerDir, PERIODIC_PICKER_PARTS) : '';

const CHANNELS = [
  { id: 'ch01-core', entry: 'src/kernel/entry.ts', alwaysOn: true, maxBytes: 850 * 1024, prefix: orbitCorePrefix, define: { __ORBIT_STYLE_CSS__: JSON.stringify(orbitCssMin) } },
  { id: 'ch02-hud', entry: 'src/hud/entry.ts', alwaysOn: false, maxBytes: 80 * 1024 },
  { id: 'ch03-i18n', entry: 'src/i18n/entry.ts', alwaysOn: false, maxBytes: 550 * 1024 },
  { id: 'ch04-workbench', entry: 'src/workbench/entry.ts', alwaysOn: false, maxBytes: 80 * 1024 },
  { id: 'ch05-translator', entry: 'src/translator/entry.ts', alwaysOn: false, maxBytes: 60 * 1024 },
  { id: 'ch06-omni', entry: 'src/omni/entry.ts', alwaysOn: false, maxBytes: 60 * 1024 },
  { id: 'ch07-inline-diff', entry: 'src/inline-diff/entry.ts', alwaysOn: false, maxBytes: 60 * 1024 },
  { id: 'ch08-chat-mode', entry: 'src/chat-mode/entry.ts', alwaysOn: false, maxBytes: 60 * 1024 },
  { id: 'ch09-optics-picker', entry: 'src/optics/picker3d.ts', alwaysOn: false, maxBytes: 1500 * 1024, prefix: periodicPickerPrefix },
  { id: 'ch11-optics-wallpaper', entry: 'src/optics/wallpaper.ts', alwaysOn: false, maxBytes: 60 * 1024 },
  { id: 'ch12-settings', entry: 'src/settings/entry.ts', alwaysOn: false, maxBytes: 80 * 1024 },
];

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const manifest = {
  version: rootPkg.version,
  builtAt: new Date().toISOString(),
  channels: {},
};

for (const ch of CHANNELS) {
  const fileName = `${ch.id}.js`;
  const outFile = path.join(outDir, fileName);

  const result = await esbuild.build({
    entryPoints: [path.join(runtimeDir, ch.entry)],
    bundle: true,
    format: 'iife',
    target: 'chrome128',
    charset: 'utf8',
    minify: true,
    write: false,
    legalComments: 'none',
    define: ch.define ?? {},
  });
  const code = `${ch.prefix ?? ''}${result.outputFiles[0].text}`;

  const bytes = Buffer.byteLength(code, 'utf8');
  if (bytes > ch.maxBytes) {
    throw new Error(`Channel ${ch.id} exceeded size budget: ${bytes} > ${ch.maxBytes} bytes`);
  }

  fs.writeFileSync(outFile, code, 'utf8');
  const codeHash = crypto.createHash('sha256').update(code).digest('hex').slice(0, 16);
  manifest.channels[ch.id] = {
    id: ch.id,
    file: fileName,
    codeHash,
    bytes,
    alwaysOn: ch.alwaysOn,
  };
}

fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(
  `Built ${CHANNELS.length} runtime channels -> ${path.relative(rootDir, outDir)} (ch01-core: ${manifest.channels['ch01-core'].bytes} bytes, ch09-optics-picker: ${manifest.channels['ch09-optics-picker'].bytes} bytes)`,
);
