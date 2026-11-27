import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { DEFAULT_CONFIG } from '../packages/shared/dist/index.js';
import {
  ConfigStore,
  LocalIpcServer,
  atomicWritePrivateFile,
  resolvePaths,
} from '../packages/core/dist/main.js';

function withTempDir(fn) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-orbit-cfg-ipc-'));
  return Promise.resolve()
    .then(() => fn(tmpDir))
    .finally(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
}

function sendIpcRaw(endpoint, rawLine) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(endpoint);
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('error', reject);
    sock.on('data', (chunk) => {
      buf += chunk;
      if (buf.includes('\n')) {
        sock.end();
        resolve(JSON.parse(buf.slice(0, buf.indexOf('\n'))));
      }
    });
    sock.write(rawLine);
  });
}

describe('core/platform & ConfigStore', () => {
  it('writes private files atomically with owner-only permissions', async () => {
    await withTempDir((tmpDir) => {
      const target = path.join(tmpDir, 'nested', 'secret.json');
      atomicWritePrivateFile(target, '{"ok":true}\n');
      assert.equal(fs.readFileSync(target, 'utf8'), '{"ok":true}\n');
      if (process.platform !== 'win32') {
        const mode = fs.statSync(target).mode & 0o777;
        assert.equal(mode, 0o600);
      }
    });
  });

  it('persists patches atomically, emits changed events, and falls back on corrupt JSON', async () => {
    await withTempDir((tmpDir) => {
      const paths = resolvePaths(tmpDir);
      const store = new ConfigStore(paths.configFile);
      assert.deepEqual(store.get(), DEFAULT_CONFIG);

      const changes = [];
      store.on('changed', (cfg) => changes.push(cfg));

      store.patch({ theme: 'warm', privacyMask: true });
      assert.equal(changes.length, 1);
      assert.equal(changes[0].theme, 'warm');

      const reloaded = new ConfigStore(paths.configFile);
      assert.equal(reloaded.get().theme, 'warm');
      assert.equal(reloaded.get().privacyMask, true);

      fs.writeFileSync(paths.configFile, '{corrupt json', 'utf8');
      const recovered = new ConfigStore(paths.configFile);
      assert.deepEqual(recovered.get(), DEFAULT_CONFIG);
    });
  });

  it('applies full-optics, focus, and silent-eco presets', async () => {
    await withTempDir((tmpDir) => {
      const paths = resolvePaths(tmpDir);
      const store = new ConfigStore(paths.configFile);

      const silent = store.applyPreset('silent-eco');
      assert.equal(silent.visualBudget, 'silent-eco');
      assert.equal(silent.hud.style, 'capsules');
      assert.equal(silent.workbench.inkStreamFade, false);
      assert.equal(silent.optics.picker3d, false);

      const focus = store.applyPreset('focus');
      assert.equal(focus.visualBudget, 'focus');
      assert.equal(focus.workbench.inkStreamFade, true);
      assert.equal(focus.optics.picker3d, false);

      const full = store.applyPreset('full-optics');
      assert.equal(full.visualBudget, 'full-optics');
      assert.equal(full.hud.style, 'hybrid');
      assert.equal(full.optics.picker3d, true);
      assert.equal(full.optics.horizonRipple, true);
    });
  });
});

describe('core/ipc: LocalIpcServer', () => {
  it('enforces auth tokens, handles malformed JSON & handler errors, and broadcasts events', async () => {
    await withTempDir(async (tmpDir) => {
      const paths = resolvePaths(tmpDir);
      const store = new ConfigStore(paths.configFile);
      store.patch({ theme: 'crystal' });

      const server = new LocalIpcServer(paths, (method) => {
        if (method === 'config.get') return store.get();
        throw new Error(`boom:${method}`);
      });
      await server.start();

      try {
        // Session file contains endpoint & authToken
        const session = JSON.parse(fs.readFileSync(paths.sessionFile, 'utf8'));
        assert.equal(session.endpoint, server.getEndpoint());
        assert.equal(session.authToken, server.getAuthToken());

        // Malformed JSON -> BAD_JSON
        const badJson = await sendIpcRaw(server.getEndpoint(), '{not-json\n');
        assert.equal(badJson.ok, false);
        assert.equal(badJson.error.code, 'BAD_JSON');

        // Wrong token -> UNAUTHORIZED
        const denied = await sendIpcRaw(
          server.getEndpoint(),
          `${JSON.stringify({ id: '1', authToken: 'wrong', method: 'config.get' })}\n`,
        );
        assert.equal(denied.ok, false);
        assert.equal(denied.error.code, 'UNAUTHORIZED');

        // Valid token -> ok
        const ok = await sendIpcRaw(
          server.getEndpoint(),
          `${JSON.stringify({ id: '2', authToken: server.getAuthToken(), method: 'config.get' })}\n`,
        );
        assert.equal(ok.ok, true);
        assert.equal(ok.result.theme, 'crystal');

        // Handler error -> HANDLER_ERROR
        const errRes = await sendIpcRaw(
          server.getEndpoint(),
          `${JSON.stringify({ id: '3', authToken: server.getAuthToken(), method: 'daemon.status' })}\n`,
        );
        assert.equal(errRes.ok, false);
        assert.equal(errRes.error.code, 'HANDLER_ERROR');
        assert.match(errRes.error.message, /boom:daemon\.status/);

        // Broadcast delivers event frame to connected clients
        const eventPromise = new Promise((resolve, reject) => {
          const sock = net.createConnection(server.getEndpoint());
          let buf = '';
          sock.setEncoding('utf8');
          sock.on('error', reject);
          sock.on('connect', () => {
            setImmediate(() => {
              server.broadcast({
                type: 'event',
                event: 'console.open',
                payload: { page: 'usage' },
              });
            });
          });
          sock.on('data', (chunk) => {
            buf += chunk;
            if (buf.includes('\n')) {
              sock.end();
              resolve(JSON.parse(buf.slice(0, buf.indexOf('\n'))));
            }
          });
        });

        const received = await eventPromise;
        assert.equal(received.type, 'event');
        assert.equal(received.event, 'console.open');
        assert.deepEqual(received.payload, { page: 'usage' });
      } finally {
        await server.stop();
      }
    });
  });
});
