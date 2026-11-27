import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { DEFAULT_CONFIG, normalizeConfig } from '../packages/shared/dist/index.js';
import {
  CdpOrchestrator,
  DiskChannelLoader,
  ISOLATED_WORLD_NAME,
  assertLoopbackWsUrl,
  discoverCdpEndpoint,
  invokeRemoteWindowRpc,
  probeSshRemoteContext,
} from '../packages/core/dist/main.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHANNELS_DIR = path.resolve(__dirname, '../packages/runtime/dist/channels');

class MockCdpClient extends EventEmitter {
  calls = [];
  closed = false;

  constructor(evalHandler) {
    super();
    this.evalHandler = evalHandler;
  }

  async send(method, params = {}) {
    this.calls.push({ method, params });
    if (method === 'Page.getFrameTree') {
      return { frameTree: { frame: { id: 'main-frame-1' } } };
    }
    if (method === 'Page.createIsolatedWorld') {
      return { executionContextId: 42 };
    }
    if (method === 'Runtime.evaluate' && this.evalHandler) {
      return this.evalHandler(params);
    }
    return {};
  }

  close() {
    this.closed = true;
    this.emit('close');
  }
}

describe('core/cdp: discovery and loopback validation', () => {
  it('accepts loopback ws:// URLs and rejects non-loopback, non-ws, or credentialed URLs', () => {
    assert.doesNotThrow(() => assertLoopbackWsUrl('ws://127.0.0.1:9222/devtools/browser/abc'));
    assert.doesNotThrow(() => assertLoopbackWsUrl('ws://localhost:9222/devtools/browser/abc'));
    assert.doesNotThrow(() => assertLoopbackWsUrl('ws://[::1]:9222/devtools/browser/abc'));

    assert.throws(() => assertLoopbackWsUrl('wss://127.0.0.1:9222/devtools/browser/abc'));
    assert.throws(() => assertLoopbackWsUrl('http://127.0.0.1:9222/json/list'));
    assert.throws(() => assertLoopbackWsUrl('ws://user:pass@127.0.0.1:9222/devtools/browser/abc'));
    assert.throws(() => assertLoopbackWsUrl('ws://192.168.1.50:9222/devtools/browser/abc'));
    assert.throws(() => assertLoopbackWsUrl('ws://evil.example.com:9222/devtools/browser/abc'));
  });

  it('discovers valid DevToolsActivePort files and skips malformed candidates', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-orbit-cdp-'));
    try {
      const badPortFile = path.join(tmpDir, 'bad-port');
      fs.writeFileSync(badPortFile, '80\n/devtools/browser/bad\n');

      const badPathFile = path.join(tmpDir, 'bad-path');
      fs.writeFileSync(badPathFile, '9222\nrelative/path\n');

      const validFile = path.join(tmpDir, 'DevToolsActivePort');
      fs.writeFileSync(validFile, '9333\n/devtools/browser/uuid-123\n');

      const missingFile = path.join(tmpDir, 'does-not-exist');

      const discovered = discoverCdpEndpoint([missingFile, badPortFile, badPathFile, validFile]);
      assert.deepEqual(discovered, {
        port: 9333,
        browserWsUrl: 'ws://127.0.0.1:9333/devtools/browser/uuid-123',
        sourceFile: validFile,
      });

      assert.equal(discoverCdpEndpoint([missingFile, badPortFile]), null);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('core/cdp: CdpOrchestrator lifecycle and security guards', () => {
  it('creates an isolated world, skips unchanged channel hashes, and symmetrically disposes disabled channels', async () => {
    const loader = new DiskChannelLoader(CHANNELS_DIR);
    const orchestrator = new CdpOrchestrator(loader, {
      onConfigPatchFromPage: () => {},
      onOpenConsoleFromPage: () => {},
    });

    const wallpaperConfig = normalizeConfig({
      optics: { wallpaper: true, wallpaperPath: '/tmp/wallpaper.mp4' },
    });
    const mock = new MockCdpClient();
    const target = await orchestrator.attachTarget(
      { id: 'page-1', title: 'Antigravity', url: 'http://localhost/' },
      mock,
      wallpaperConfig,
    );

    const worldCall = mock.calls.find((c) => c.method === 'Page.createIsolatedWorld');
    assert.equal(worldCall?.params.worldName, ISOLATED_WORLD_NAME);
    assert.equal(worldCall?.params.grantUniveralAccess, false);
    assert.ok(target.loadedChannels.has('ch01-core'));
    assert.ok(target.loadedChannels.has('ch02-hud'));
    assert.ok(target.loadedChannels.has('ch11-optics-wallpaper'));

    // Reconciling the same config skips re-evaluating channel bundles
    const evalsBefore = mock.calls.filter((c) => c.method === 'Runtime.evaluate').length;
    await orchestrator.reconcileAll(wallpaperConfig);
    const evalsAfter = mock.calls.filter((c) => c.method === 'Runtime.evaluate').length;
    assert.equal(evalsAfter - evalsBefore, 1, 'Only applyConfig should run when channel hashes match');

    // Switching to silent-eco must dispose ch11-optics-wallpaper
    const silentConfig = normalizeConfig({ visualBudget: 'silent-eco' }, wallpaperConfig);
    await orchestrator.reconcileAll(silentConfig);
    assert.ok(!target.loadedChannels.has('ch11-optics-wallpaper'));
    assert.ok(
      mock.calls.some(
        (c) =>
          c.method === 'Runtime.evaluate' &&
          String(c.params.expression).includes('disposeChannel?.("ch11-optics-wallpaper")'),
      ),
    );

    // Effort slider was loaded in Main World (no contextId); disabling effortSlider destroys it in Main World
    assert.ok(
      mock.calls.some(
        (c) =>
          c.method === 'Runtime.evaluate' &&
          c.params.contextId === undefined &&
          String(c.params.expression).includes('__agOrbitEffortSlider?.sync?.('),
      ),
    );
    const noEffortConfig = normalizeConfig({ workbench: { effortSlider: false } }, silentConfig);
    await orchestrator.reconcileAll(noEffortConfig);
    assert.ok(
      mock.calls.some(
        (c) =>
          c.method === 'Runtime.evaluate' &&
          c.params.contextId === undefined &&
          String(c.params.expression).includes('__agOrbitEffortSlider?.destroy?.()'),
      ),
    );

    await orchestrator.ejectAll();
    assert.equal(mock.closed, true);
    assert.equal(orchestrator.getTargetSummaries().length, 0);
  });

  it('guards Runtime.bindingCalled against child iframes and handles UI-demand channels', async () => {
    const loader = new DiskChannelLoader(CHANNELS_DIR);
    const patches = [];
    const openedPages = [];

    const orchestrator = new CdpOrchestrator(loader, {
      onConfigPatchFromPage: (patch) => patches.push(patch),
      onOpenConsoleFromPage: (page) => openedPages.push(page),
    });

    const mock = new MockCdpClient();
    const target = await orchestrator.attachTarget(
      { id: 'page-2', title: 'Antigravity', url: 'http://localhost/' },
      mock,
      DEFAULT_CONFIG,
    );

    // Child iframe contextId !== 42 must be rejected
    mock.emit('event', 'Runtime.bindingCalled', {
      executionContextId: 999,
      name: '__antigravityOrbitSetting',
      payload: JSON.stringify({ theme: 'alabaster' }),
    });
    assert.equal(patches.length, 0);

    // Malformed payload from valid context is safely ignored
    mock.emit('event', 'Runtime.bindingCalled', {
      executionContextId: 42,
      name: '__antigravityOrbitSetting',
      payload: '{bad-json',
    });
    assert.equal(patches.length, 0);

    // Valid setting & console-open events
    mock.emit('event', 'Runtime.bindingCalled', {
      executionContextId: 42,
      name: '__antigravityOrbitSetting',
      payload: JSON.stringify({ theme: 'alabaster' }),
    });
    mock.emit('event', 'Runtime.bindingCalled', {
      executionContextId: 42,
      name: '__antigravityOrbitOpenConsole',
      payload: JSON.stringify({ page: 'usage' }),
    });
    assert.equal(patches.length, 1);
    assert.equal(patches[0].theme, 'alabaster');
    assert.deepEqual(openedPages, ['usage']);

    // UI state binding loads on-demand ch12-settings & ch09-optics-picker
    mock.emit('event', 'Runtime.bindingCalled', {
      executionContextId: 42,
      name: '__antigravityOrbitUiState',
      payload: JSON.stringify({ settingsOpen: true, modelMenuOpen: true }),
    });
    await new Promise((r) => setImmediate(r));
    assert.ok(target.loadedChannels.has('ch12-settings'));
    assert.ok(target.loadedChannels.has('ch09-optics-picker'));

    // Closing client removes target from registry
    mock.close();
    assert.equal(orchestrator.getTargetSummaries().length, 0);
  });

  it('dispatches __antigravityOrbitRpc roundtrips and rejects child iframe RPC calls', async () => {
    const loader = new DiskChannelLoader(CHANNELS_DIR);
    const rpcCalls = [];
    const orchestrator = new CdpOrchestrator(loader, {
      onConfigPatchFromPage: () => {},
      onOpenConsoleFromPage: () => {},
      onRuntimeRpcFromPage: async (method, params) => {
        rpcCalls.push({ method, params });
        if (method === 'diff.file') return { diff: '+added line' };
        throw new Error('unsupported test method');
      },
    });

    const mock = new MockCdpClient();
    await orchestrator.attachTarget(
      { id: 'page-rpc', title: 'Antigravity', url: 'http://localhost/' },
      mock,
      DEFAULT_CONFIG,
    );

    // Child iframe contextId !== 42 must be ignored
    mock.emit('event', 'Runtime.bindingCalled', {
      executionContextId: 777,
      name: '__antigravityOrbitRpc',
      payload: JSON.stringify({ id: 'rpc-bad', method: 'diff.file', params: { file: 'a.ts' } }),
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(rpcCalls.length, 0);

    // Valid RPC resolves back to window.__antigravityOrbit.resolveRpc
    mock.emit('event', 'Runtime.bindingCalled', {
      executionContextId: 42,
      name: '__antigravityOrbitRpc',
      payload: JSON.stringify({ id: 'rpc-ok', method: 'diff.file', params: { file: 'a.ts' } }),
    });
    mock.emit('event', 'Runtime.bindingCalled', {
      executionContextId: 42,
      name: '__antigravityOrbitRpc',
      payload: JSON.stringify({ id: 'rpc-err', method: 'unknown.op', params: {} }),
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(rpcCalls.length, 2);

    const resolveOkCall = mock.calls.find(
      (c) =>
        c.method === 'Runtime.evaluate' &&
        String(c.params.expression).includes('resolveRpc?.("rpc-ok", true, {"diff":"+added line"}, null)'),
    );
    const resolveErrCall = mock.calls.find(
      (c) =>
        c.method === 'Runtime.evaluate' &&
        String(c.params.expression).includes('resolveRpc?.("rpc-err", false, null, "unsupported test method")'),
    );
    assert.ok(resolveOkCall, 'Expected successful resolveRpc evaluation');
    assert.ok(resolveErrCall, 'Expected failed resolveRpc evaluation');
  });

  it('pushes HUD snapshots only to targets with ch02-hud loaded', async () => {
    const loader = new DiskChannelLoader(CHANNELS_DIR);
    const orchestrator = new CdpOrchestrator(loader, {
      onConfigPatchFromPage: () => {},
      onOpenConsoleFromPage: () => {},
    });

    const hudClient = new MockCdpClient();
    const noHudClient = new MockCdpClient();

    await orchestrator.attachTarget(
      { id: 'with-hud', title: 'HUD', url: 'http://localhost/' },
      hudClient,
      DEFAULT_CONFIG,
    );
    await orchestrator.attachTarget(
      { id: 'no-hud', title: 'NoHUD', url: 'http://localhost/' },
      noHudClient,
      normalizeConfig({ hud: { enabled: false } }),
    );

    await orchestrator.pushHudSnapshot({
      conversationId: 'c1',
      activity: 'thinking',
      turns: 3,
      currentTurnMs: 18_000,
      avgTps: 90,
      ttftMs: 420,
      activeSubagents: 2,
      totalTokens: 580_000,
      cacheHitRate: 0.94,
      estimatedCostUsd: 0.42,
      cacheSavedUsd: 1.15,
      contextUsed: 180_000,
      contextLimit: 512_000,
      contextEstimated: false,
      compactionCount: 1,
      currentModel: 'gemini-2.5-pro',
      currentRole: 'executor',
      pastModels: [],
      isRemoteSsh: true,
      sshHost: 'dev-gpu',
    });

    assert.ok(
      hudClient.calls.some(
        (c) =>
          c.method === 'Runtime.evaluate' &&
          String(c.params.expression).startsWith('window.__antigravityOrbit?.updateHud?.('),
      ),
    );
    assert.ok(
      !noHudClient.calls.some(
        (c) =>
          c.method === 'Runtime.evaluate' &&
          String(c.params.expression).startsWith('window.__antigravityOrbit?.updateHud?.('),
      ),
    );
  });
});

describe('core/ssh: remote context probing and window RPC', () => {
  it('detects remote SSH context and invokes same-origin relative RPC endpoints', async () => {
    const mock = new MockCdpClient((params) => {
      const expr = String(params.expression);
      if (expr.includes('window.sshRemote')) {
        return { result: { value: { isRemoteSsh: true, host: 'dev-gpu', origin: 'http://localhost:9999' } } };
      }
      if (expr.includes('fetch("/rpc/quota"')) {
        return { result: { value: { ok: true, status: 200, data: { remaining: 0.7 } } } };
      }
      if (expr.includes('fetch("/rpc/fail"')) {
        return { result: { value: { ok: false, status: 500, error: 'internal error' } } };
      }
      return {};
    });

    const ssh = await probeSshRemoteContext(mock);
    assert.deepEqual(ssh, { isRemoteSsh: true, host: 'dev-gpu', origin: 'http://localhost:9999' });

    const rpcData = await invokeRemoteWindowRpc(mock, 42, '/rpc/quota');
    assert.deepEqual(rpcData, { remaining: 0.7 });

    await assert.rejects(() => invokeRemoteWindowRpc(mock, 42, 'https://evil.example/rpc'), /non-relative/);
    await assert.rejects(() => invokeRemoteWindowRpc(mock, 42, '/rpc/fail'), /HTTP 500/);
  });
});
