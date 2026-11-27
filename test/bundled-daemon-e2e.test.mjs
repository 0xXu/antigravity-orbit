import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');
const DAEMON_BUNDLE = path.join(ROOT_DIR, 'packages/desktop/src-tauri/resources/core/daemon.mjs');
const CHANNELS_DIR = path.join(ROOT_DIR, 'packages/desktop/src-tauri/resources/channels');

function sendIpc(endpoint, authToken, method, params = {}) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(endpoint);
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('error', reject);
    sock.on('data', (chunk) => {
      buf += chunk;
      const idx = buf.indexOf('\n');
      if (idx !== -1) {
        sock.end();
        resolve(JSON.parse(buf.slice(0, idx)));
      }
    });
    sock.write(`${JSON.stringify({ id: `e2e-${Date.now()}`, authToken, method, params })}\n`);
  });
}

async function waitForFile(filePath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(filePath)) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

describe('e2e: bundled desktop Core daemon lifecycle and IPC roundtrip', () => {
  it('boots daemon.mjs from Tauri resources, serves IPC methods, persists config/usage, and exits cleanly', async () => {
    assert.ok(fs.existsSync(DAEMON_BUNDLE), `Expected bundled daemon at ${DAEMON_BUNDLE}`);
    assert.ok(fs.existsSync(path.join(CHANNELS_DIR, 'manifest.json')), 'Expected bundled channels manifest');

    const tmpStateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-orbit-e2e-'));
    const child = spawn(process.execPath, [DAEMON_BUNDLE], {
      env: {
        ...process.env,
        ANTIGRAVITY_ORBIT_STATE_DIR: tmpStateDir,
        ANTIGRAVITY_ORBIT_CHANNELS_DIR: CHANNELS_DIR,
        ANTIGRAVITY_ORBIT_DISABLE_CDP: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    try {
      const sessionPath = path.join(tmpStateDir, 'ipc-session.json');
      await waitForFile(sessionPath, 5000);
      const session = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
      assert.ok(session.endpoint, 'ipc-session.json must expose endpoint');
      assert.ok(session.authToken, 'ipc-session.json must expose authToken');

      // 1. daemon.status
      const statusRes = await sendIpc(session.endpoint, session.authToken, 'daemon.status');
      assert.equal(statusRes.ok, true, `daemon.status failed: ${JSON.stringify(statusRes)}`);
      assert.equal(statusRes.result.pid, child.pid);
      assert.ok(statusRes.result.activeChannels.includes('ch01-core'));

      // 2. config.patch + config.get
      const patchRes = await sendIpc(session.endpoint, session.authToken, 'config.patch', {
        patch: { theme: 'crystal', privacyMask: true },
      });
      assert.equal(patchRes.ok, true);
      assert.equal(patchRes.result.theme, 'crystal');

      const getRes = await sendIpc(session.endpoint, session.authToken, 'config.get');
      assert.equal(getRes.ok, true);
      assert.equal(getRes.result.theme, 'crystal');
      assert.equal(getRes.result.privacyMask, true);

      // 3. usage.record + usage.summary
      const recRes = await sendIpc(session.endpoint, session.authToken, 'usage.record', {
        trajectoryId: 'e2e-traj-1',
        executionId: 'e2e-exec-1',
        accountEmail: 'e2e@example.com',
        environment: 'local',
        rawModel: 'gemini-2.5-pro-high',
        timestampMs: Date.now(),
        contextTokens: 50_000,
        tokens: {
          inputUncached: 1_000,
          cacheRead: 9_000,
          cacheWrite: 0,
          outputThinking: 500,
          outputReply: 500,
        },
        durationMs: 1200,
      });
      assert.equal(recRes.ok, true);
      assert.equal(recRes.result.inserted, true);

      const summaryRes = await sendIpc(session.endpoint, session.authToken, 'usage.summary', {});
      assert.equal(summaryRes.ok, true);
      assert.equal(summaryRes.result.totalRequests, 1);
      assert.equal(summaryRes.result.totalTokens, 11_000);

      // 4. proxy.diagnose
      const proxyRes = await sendIpc(session.endpoint, session.authToken, 'proxy.diagnose');
      assert.equal(proxyRes.ok, true);
      assert.equal(proxyRes.result.mode, 'off');

      // 5. Graceful shutdown on SIGTERM (Windows TerminateProcess reports code=null, signal='SIGTERM')
      const exitPromise = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
      child.kill('SIGTERM');
      const exit = await exitPromise;
      if (process.platform === 'win32') {
        assert.ok(
          exit.code === 0 || exit.signal === 'SIGTERM',
          `Unexpected Windows exit: ${JSON.stringify(exit)} (stderr: ${stderr})`,
        );
      } else {
        assert.equal(exit.code, 0, `Expected clean exit code 0, got ${JSON.stringify(exit)} (stderr: ${stderr})`);
      }
    } finally {
      if (child.exitCode === null) {
        child.kill('SIGKILL');
      }
      fs.rmSync(tmpStateDir, { recursive: true, force: true });
    }
  });
});
