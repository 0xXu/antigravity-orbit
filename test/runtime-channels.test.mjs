import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { CHANNEL_IDS } from '../packages/shared/dist/index.js';
import { DiskChannelLoader } from '../packages/core/dist/main.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHANNELS_DIR = path.resolve(__dirname, '../packages/runtime/dist/channels');

const CHANNEL_BUDGET_BYTES = {
  'ch01-core': 850 * 1024,
  'ch02-hud': 80 * 1024,
  'ch03-i18n': 550 * 1024,
  'ch04-workbench': 80 * 1024,
  'ch05-translator': 60 * 1024,
  'ch06-omni': 60 * 1024,
  'ch07-inline-diff': 60 * 1024,
  'ch08-chat-mode': 60 * 1024,
  'ch09-optics-picker': 1500 * 1024,
  'ch11-optics-wallpaper': 60 * 1024,
  'ch12-settings': 80 * 1024,
};

describe('runtime/channels: build manifest and DiskChannelLoader', () => {
  it('compiles all 11 channels with valid SHA-256 hashes under strict size budgets', () => {
    const loader = new DiskChannelLoader(CHANNELS_DIR);
    const manifest = loader.loadManifest();
    assert.ok(manifest, 'manifest.json must exist');
    assert.equal(Object.keys(manifest.channels).length, CHANNEL_IDS.length);

    for (const id of CHANNEL_IDS) {
      const entry = manifest.channels[id];
      assert.ok(entry, `Missing channel entry in manifest: ${id}`);
      assert.equal(entry.id, id);
      assert.equal(entry.codeHash.length, 16);
      assert.ok(entry.bytes > 500, `${id} must be a compiled bundle (got ${entry.bytes}B)`);
      assert.ok(
        entry.bytes <= CHANNEL_BUDGET_BYTES[id],
        `${id} exceeded budget: ${entry.bytes} > ${CHANNEL_BUDGET_BYTES[id]}`,
      );

      const loaded = loader.readChannelCode(id);
      assert.ok(loaded, `Failed to read compiled code for ${id}`);
      assert.equal(loaded.codeHash, entry.codeHash);
      const computedHash = crypto.createHash('sha256').update(loaded.code).digest('hex').slice(0, 16);
      assert.equal(computedHash, entry.codeHash);
    }
  });

  it('returns null when manifest directory or channel id does not exist', () => {
    const missingLoader = new DiskChannelLoader(path.join(CHANNELS_DIR, 'nonexistent-dir'));
    assert.equal(missingLoader.loadManifest(), null);
    assert.equal(missingLoader.readChannelCode('ch01-core'), null);

    const loader = new DiskChannelLoader(CHANNELS_DIR);
    assert.equal(loader.readChannelCode('ch99-missing'), null);
  });
});
