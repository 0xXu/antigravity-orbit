import fs from 'node:fs';
import path from 'node:path';
import {
  resolveActiveChannels,
  type ChannelId,
  type ChannelManifest,
  type ConsolePage,
  type DeepPartial,
  type HudMetricsSnapshot,
  type AntigravityOrbitConfig,
  type TargetSummary,
} from '@antigravity-orbit/shared';
import type { CdpClientLike } from './client.js';

export const ISOLATED_WORLD_NAME = 'ANTIGRAVITY_ORBIT_ISOLATED_V1';

export interface ChannelBundleLoader {
  loadManifest(): ChannelManifest | null;
  readChannelCode(id: ChannelId): { code: string; codeHash: string } | null;
}

export class DiskChannelLoader implements ChannelBundleLoader {
  private readonly channelsDir: string;

  constructor(channelsDir: string) {
    this.channelsDir = channelsDir;
  }

  loadManifest(): ChannelManifest | null {
    const manifestPath = path.join(this.channelsDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) return null;
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as ChannelManifest;
  }

  readChannelCode(id: ChannelId): { code: string; codeHash: string } | null {
    const manifest = this.loadManifest();
    const entry = manifest?.channels[id];
    if (!entry) return null;
    const filePath = path.join(this.channelsDir, entry.file);
    if (!fs.existsSync(filePath)) return null;
    return {
      code: fs.readFileSync(filePath, 'utf8'),
      codeHash: entry.codeHash,
    };
  }
}

export interface AttachedTarget {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly isRemoteSsh: boolean;
  readonly sshHost?: string;
  readonly client: CdpClientLike;
  contextId: number;
  uiState: { settingsOpen: boolean; modelMenuOpen: boolean };
  loadedChannels: Map<ChannelId, string>; // ChannelId -> codeHash
  documentScriptIds: Map<ChannelId, string>; // ChannelId -> Page.addScriptToEvaluateOnNewDocument identifier
}

export interface OrchestratorCallbacks {
  onConfigPatchFromPage: (patch: DeepPartial<AntigravityOrbitConfig>) => void;
  onOpenConsoleFromPage: (page: ConsolePage) => void;
  onRuntimeRpcFromPage?: (
    method: string,
    params: Record<string, unknown>,
    target: AttachedTarget,
  ) => Promise<unknown> | unknown;
}

export class CdpOrchestrator {
  private readonly loader: ChannelBundleLoader;
  private readonly callbacks: OrchestratorCallbacks;
  private readonly targets = new Map<string, AttachedTarget>();
  private latestConfig: AntigravityOrbitConfig | null = null;

  constructor(loader: ChannelBundleLoader, callbacks: OrchestratorCallbacks) {
    this.loader = loader;
    this.callbacks = callbacks;
  }

  async attachTarget(
    meta: { id: string; title: string; url: string; isRemoteSsh?: boolean; sshHost?: string },
    client: CdpClientLike,
    config: AntigravityOrbitConfig,
  ): Promise<AttachedTarget> {
    this.latestConfig = config;
    await client.send('Page.enable');
    await client.send('Runtime.enable');

    const tree = await client.send<{ frameTree: { frame: { id: string } } }>('Page.getFrameTree');
    const mainFrameId = tree.frameTree.frame.id;

    const world = await client.send<{ executionContextId: number }>('Page.createIsolatedWorld', {
      frameId: mainFrameId,
      worldName: ISOLATED_WORLD_NAME,
      grantUniveralAccess: false,
    });

    await client.send('Runtime.addBinding', {
      name: '__antigravityOrbitSetting',
      executionContextName: ISOLATED_WORLD_NAME,
    });
    await client.send('Runtime.addBinding', {
      name: '__antigravityOrbitOpenConsole',
      executionContextName: ISOLATED_WORLD_NAME,
    });
    await client.send('Runtime.addBinding', {
      name: '__antigravityOrbitUiState',
      executionContextName: ISOLATED_WORLD_NAME,
    });
    await client.send('Runtime.addBinding', {
      name: '__antigravityOrbitRpc',
      executionContextName: ISOLATED_WORLD_NAME,
    });

    const target: AttachedTarget = {
      id: meta.id,
      title: meta.title,
      url: meta.url,
      isRemoteSsh: Boolean(meta.isRemoteSsh),
      sshHost: meta.sshHost,
      client,
      contextId: world.executionContextId,
      uiState: { settingsOpen: false, modelMenuOpen: false },
      loadedChannels: new Map(),
      documentScriptIds: new Map(),
    };

    client.on('event', (method, params) => {
      if (method !== 'Runtime.bindingCalled') return;
      // Strict top-level isolated-world context guard (rejects child iframes)
      if (params.executionContextId !== target.contextId) return;
      this.handleBindingCall(target, String(params.name), String(params.payload ?? ''), this.latestConfig ?? config);
    });

    client.on('close', () => {
      this.targets.delete(meta.id);
    });

    this.targets.set(meta.id, target);
    await this.reconcileTarget(target, config);
    return target;
  }

  async reconcileAll(config: AntigravityOrbitConfig): Promise<void> {
    this.latestConfig = config;
    await Promise.all(
      Array.from(this.targets.values()).map((target) => this.reconcileTarget(target, config)),
    );
  }

  async reconcileTarget(target: AttachedTarget, config: AntigravityOrbitConfig): Promise<void> {
    this.latestConfig = config;
    const desired = new Set(resolveActiveChannels(config, target.uiState));

    // 1. Symmetric teardown for channels that are no longer desired
    for (const loadedId of Array.from(target.loadedChannels.keys())) {
      if (!desired.has(loadedId)) {
        const scriptId = target.documentScriptIds.get(loadedId);
        if (scriptId) {
          await target.client
            .send('Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptId })
            .catch(() => {});
          target.documentScriptIds.delete(loadedId);
        }
        await target.client.send('Runtime.evaluate', {
          contextId: target.contextId,
          expression: `window.__antigravityOrbit?.disposeChannel?.(${JSON.stringify(loadedId)});`,
          awaitPromise: false,
        });
        target.loadedChannels.delete(loadedId);
      }
    }

    // 2. Idempotent inject for missing or updated channels (skip if codeHash matches)
    for (const channelId of desired) {
      const bundle = this.loader.readChannelCode(channelId);
      if (!bundle) continue;
      if (target.loadedChannels.get(channelId) === bundle.codeHash) continue;

      const oldScriptId = target.documentScriptIds.get(channelId);
      if (oldScriptId) {
        await target.client
          .send('Page.removeScriptToEvaluateOnNewDocument', { identifier: oldScriptId })
          .catch(() => {});
        target.documentScriptIds.delete(channelId);
      }

      const added = await target.client
        .send<{ identifier?: string }>('Page.addScriptToEvaluateOnNewDocument', {
          source: bundle.code,
          worldName: ISOLATED_WORLD_NAME,
        })
        .catch(() => ({ identifier: undefined }));
      if (added?.identifier) {
        target.documentScriptIds.set(channelId, added.identifier);
      }

      await target.client.send('Runtime.evaluate', {
        contextId: target.contextId,
        expression: bundle.code,
        awaitPromise: false,
      });
      target.loadedChannels.set(channelId, bundle.codeHash);
    }

    // 3. Hot-sync latest configuration (<10ms)
    await target.client.send('Runtime.evaluate', {
      contextId: target.contextId,
      expression: `window.__antigravityOrbit?.applyConfig?.(${JSON.stringify(config)});`,
      awaitPromise: false,
    });
  }

  async pushHudSnapshot(snapshot: HudMetricsSnapshot): Promise<void> {
    await Promise.all(
      Array.from(this.targets.values())
        .filter((t) => t.loadedChannels.has('ch02-hud'))
        .map((t) =>
          t.client.send('Runtime.evaluate', {
            contextId: t.contextId,
            expression: `window.__antigravityOrbit?.updateHud?.(${JSON.stringify(snapshot)});`,
            awaitPromise: false,
          }),
        ),
    );
  }

  async pushWallpaperSource(url: string, mime: string): Promise<void> {
    await Promise.all(
      Array.from(this.targets.values())
        .filter((t) => t.loadedChannels.has('ch11-optics-wallpaper'))
        .map((t) =>
          t.client.send('Runtime.evaluate', {
            contextId: t.contextId,
            expression: `window.__antigravityOrbit?.setWallpaperSource?.(${JSON.stringify(url)}, ${JSON.stringify(mime)});`,
            awaitPromise: false,
          }),
        ),
    );
  }

  async ejectAll(): Promise<void> {
    await Promise.all(
      Array.from(this.targets.values()).map(async (target) => {
        for (const scriptId of target.documentScriptIds.values()) {
          await target.client
            .send('Page.removeScriptToEvaluateOnNewDocument', { identifier: scriptId })
            .catch(() => {});
        }
        target.documentScriptIds.clear();
        try {
          await target.client.send('Runtime.evaluate', {
            contextId: target.contextId,
            expression: 'window.__antigravityOrbit?.disposeAll?.();',
            awaitPromise: false,
          });
        } catch {
          // Ignore already-closed targets
        }
        target.loadedChannels.clear();
        target.client.close();
      }),
    );
    this.targets.clear();
  }

  getAttachedTargets(): AttachedTarget[] {
    return Array.from(this.targets.values());
  }

  getTargetSummaries(): TargetSummary[] {
    return Array.from(this.targets.values()).map((t) => ({
      id: t.id,
      title: t.title,
      url: t.url,
      isRemoteSsh: t.isRemoteSsh,
      activeChannels: Array.from(t.loadedChannels.keys()),
    }));
  }

  private handleBindingCall(
    target: AttachedTarget,
    name: string,
    payload: string,
    latestConfig: AntigravityOrbitConfig,
  ): void {
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      if (name === '__antigravityOrbitSetting') {
        this.callbacks.onConfigPatchFromPage(parsed as DeepPartial<AntigravityOrbitConfig>);
      } else if (name === '__antigravityOrbitOpenConsole') {
        const page = (parsed.page as ConsolePage) || 'overview';
        this.callbacks.onOpenConsoleFromPage(page);
      } else if (name === '__antigravityOrbitUiState') {
        if (typeof parsed.settingsOpen === 'boolean') {
          target.uiState.settingsOpen = parsed.settingsOpen;
        }
        if (typeof parsed.modelMenuOpen === 'boolean') {
          target.uiState.modelMenuOpen = parsed.modelMenuOpen;
        }
        void this.reconcileTarget(target, latestConfig);
      } else if (name === '__antigravityOrbitRpc') {
        const rpcId = typeof parsed.id === 'string' ? parsed.id : '';
        const method = typeof parsed.method === 'string' ? parsed.method : '';
        const params =
          parsed.params && typeof parsed.params === 'object'
            ? (parsed.params as Record<string, unknown>)
            : {};
        if (!rpcId || !method) return;
        void this.dispatchRuntimeRpc(target, rpcId, method, params);
      }
    } catch {
      // Ignore malformed payloads from page
    }
  }

  private async dispatchRuntimeRpc(
    target: AttachedTarget,
    rpcId: string,
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    if (!this.callbacks.onRuntimeRpcFromPage) {
      await target.client
        .send('Runtime.evaluate', {
          contextId: target.contextId,
          expression: `window.__antigravityOrbit?.resolveRpc?.(${JSON.stringify(rpcId)}, false, null, "RPC handler not configured");`,
          awaitPromise: false,
        })
        .catch(() => {});
      return;
    }
    try {
      const data = await this.callbacks.onRuntimeRpcFromPage(method, params, target);
      await target.client
        .send('Runtime.evaluate', {
          contextId: target.contextId,
          expression: `window.__antigravityOrbit?.resolveRpc?.(${JSON.stringify(rpcId)}, true, ${JSON.stringify(data ?? null)}, null);`,
          awaitPromise: false,
        })
        .catch(() => {});
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await target.client
        .send('Runtime.evaluate', {
          contextId: target.contextId,
          expression: `window.__antigravityOrbit?.resolveRpc?.(${JSON.stringify(rpcId)}, false, null, ${JSON.stringify(msg)});`,
          awaitPromise: false,
        })
        .catch(() => {});
    }
  }
}
