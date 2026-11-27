import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  resolveActiveChannels,
  type AccountQuotaSummary,
  type ConsolePage,
  type DaemonStatus,
  type DeepPartial,
  type HudMetricsSnapshot,
  type AntigravityOrbitConfig,
  type UsageFilter,
  type UsageRecordInput,
  type VisualBudgetMode,
} from '@antigravity-orbit/shared';
import { ConfigStore } from './config/store.js';
import { LocalIpcServer } from './ipc/server.js';
import { resolvePaths } from './platform/paths.js';
import { getAutoStartStatus, setAutoStartEnabled } from './platform/autostart.js';
import {
  detectAntigravityHostStatus,
  gracefulQuitAntigravity,
  resolveAntigravityStateDbPath,
  spawnAntigravityWithCdp,
} from './platform/host-process.js';
import { discoverCdpEndpoint, listCdpPageTargets } from './cdp/discovery.js';
import { CdpClient } from './cdp/client.js';
import { CdpOrchestrator, DiskChannelLoader } from './cdp/orchestrator.js';
import { UsageLedger } from './ledger/store.js';
import { probeSshRemoteContext } from './ssh/remote-rpc.js';
import { WallpaperGateway } from './services/wallpaper-gateway.js';
import { OmniStreamingGateway } from './services/omni-gateway.js';
import { ThoughtTranslatorService, type TranslateRequest } from './services/thought-translator.js';
import { getSafeInlineDiff } from './services/inline-diff.js';
import { AccountManager } from './accounts/manager.js';
import { diagnoseProxy } from './services/proxy.js';
import { ReversibleMaintenanceService } from './maintenance/cleaner.js';
import { UpdateService } from './services/updater.js';
import { fuseAccountQuota } from './quota/fusion.js';
import {
  buildQuotaAndHudFromProbe,
  probeTargetLiveTelemetry,
} from './telemetry/collector.js';

const APP_VERSION = '0.1.5';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveDefaultChannelsDir(): string {
  if (process.env.ANTIGRAVITY_ORBIT_CHANNELS_DIR) {
    return path.resolve(process.env.ANTIGRAVITY_ORBIT_CHANNELS_DIR);
  }
  const siblingChannels = path.resolve(__dirname, '../channels');
  if (fs.existsSync(path.join(siblingChannels, 'manifest.json'))) {
    return siblingChannels;
  }
  return path.resolve(__dirname, '../../runtime/dist/channels');
}

const DEFAULT_CHANNELS_DIR = resolveDefaultChannelsDir();

export class AntigravityOrbitDaemon {
  private readonly paths = resolvePaths();
  private readonly configStore: ConfigStore;
  private readonly ledger: UsageLedger;
  private readonly accounts: AccountManager;
  private readonly maintenance: ReversibleMaintenanceService;
  private readonly updater: UpdateService;
  private readonly wallpaperGateway = new WallpaperGateway();
  private readonly omniGateway = new OmniStreamingGateway();
  private readonly translator = new ThoughtTranslatorService();
  private readonly ipc: LocalIpcServer;
  private readonly orchestrator: CdpOrchestrator;
  private readonly startedAt = new Date().toISOString();
  private quotaSnapshots: AccountQuotaSummary[] = [];
  private latestHud: HudMetricsSnapshot | null = null;
  private liveUserEmail: string | null = null;
  private liveUserName: string | null = null;
  private bareHostDetected = false;
  private bareHostFirstSeenAt: number | null = null;
  private autoAttachInProgress = false;
  private accountSwitchInProgress = false;
  private lastAutoAttachAt = 0;
  private readonly autoAttachCooldownMs = 30_000;
  private cdpPort: number | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private telemetryTimer: NodeJS.Timeout | null = null;

  constructor(channelsDir = DEFAULT_CHANNELS_DIR) {
    this.configStore = new ConfigStore(this.paths.configFile);
    this.ledger = new UsageLedger(path.join(this.paths.stateDir, 'usage-ledger.sqlite'));
    this.accounts = new AccountManager(this.paths.stateDir);
    this.maintenance = new ReversibleMaintenanceService(this.paths.stateDir);
    this.updater = new UpdateService({ cacheDir: this.paths.cacheDir });
    this.orchestrator = new CdpOrchestrator(new DiskChannelLoader(channelsDir), {
      onConfigPatchFromPage: (patch) => {
        this.configStore.patch(patch);
      },
      onOpenConsoleFromPage: (page: ConsolePage) => {
        this.ipc.broadcast({ type: 'event', event: 'console.open', payload: { page } });
        this.focusOrLaunchDesktopConsole();
      },
      onRuntimeRpcFromPage: async (method, params) => {
        if (method === 'translator.translate') {
          const cfg = this.configStore.get().translator;
          const mode = (params.mode === 'llm' || params.mode === 'machine'
            ? params.mode
            : cfg.mode === 'llm'
              ? 'llm'
              : 'machine') as 'machine' | 'llm';
          return this.translator.translate({
            text: String(params.text ?? ''),
            targetLang: typeof params.targetLang === 'string' ? params.targetLang : 'zh-CN',
            mode,
            endpoint: typeof params.endpoint === 'string' && params.endpoint ? params.endpoint : cfg.endpoint,
            model: typeof params.model === 'string' && params.model ? params.model : cfg.model,
          });
        }
        if (method === 'diff.file') {
          return {
            diff: await getSafeInlineDiff(String(params.repoRoot ?? ''), String(params.file ?? '')),
          };
        }
        if (method === 'omni.sign') {
          return this.omniGateway.signFileUrl(String(params.path ?? ''));
        }
        throw new Error(`Unsupported runtime RPC method: ${method}`);
      },
    });

    this.ipc = new LocalIpcServer(this.paths, (method, params) =>
      this.handleIpcRequest(method, params),
    );

    this.configStore.on('changed', (nextConfig) => {
      this.ipc.broadcast({ type: 'event', event: 'config.changed', payload: nextConfig });
      void this.reconcileWithSideEffects(nextConfig);
    });
  }

  private focusOrLaunchDesktopConsole(): void {
    if (process.env.NODE_TEST_CONTEXT || process.env.ANTIGRAVITY_ORBIT_NO_LAUNCH === '1') return;
    try {
      if (process.platform === 'darwin') {
        const candidates = [
          '/Applications/Antigravity Orbit.app',
          path.join(process.env.HOME ?? '', 'Applications', 'Antigravity Orbit.app'),
        ];
        const appTarget = candidates.find((p) => p && fs.existsSync(p)) ?? 'Antigravity Orbit';
        const child = spawn('open', ['-a', appTarget], { detached: true, stdio: 'ignore' });
        child.unref();
        return;
      }
      if (process.platform === 'win32') {
        const localAppData = process.env.LOCALAPPDATA ?? '';
        const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
        const candidates = [
          path.join(localAppData, 'Antigravity Orbit', 'Antigravity Orbit.exe'),
          path.join(programFiles, 'Antigravity Orbit', 'Antigravity Orbit.exe'),
        ];
        const exe = candidates.find((p) => p && fs.existsSync(p));
        if (exe) {
          const child = spawn('cmd', ['/c', 'start', '', exe], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
          });
          child.unref();
        }
      }
    } catch {
      // Best-effort desktop focus/launch
    }
  }

  private async reconcileWithSideEffects(nextConfig: AntigravityOrbitConfig): Promise<void> {
    await this.orchestrator.reconcileAll(nextConfig);
    if (nextConfig.optics.wallpaper && nextConfig.optics.wallpaperPath) {
      try {
        const active = this.wallpaperGateway.setActivePath(nextConfig.optics.wallpaperPath);
        if (active) {
          await this.orchestrator.pushWallpaperSource(active.url, active.mime);
        }
      } catch {
        // Ignore invalid wallpaper path
      }
    }
    if (this.latestHud) {
      await this.orchestrator.pushHudSnapshot(this.latestHud);
    }
  }

  private async pollLiveTelemetry(): Promise<void> {
    const targets = this.orchestrator.getAttachedTargets();
    if (targets.length === 0) return;

    const freshQuotas: AccountQuotaSummary[] = [];
    for (const target of targets) {
      const probe = await probeTargetLiveTelemetry(target.client);
      if (!probe) continue;
      if (probe.email) this.liveUserEmail = probe.email;
      if (probe.name) this.liveUserName = probe.name;

      const { accountQuota, hud } = buildQuotaAndHudFromProbe(probe, {
        environment: target.isRemoteSsh ? 'ssh' : 'local',
        sshHost: target.sshHost,
        ledger: this.ledger,
      });

      if (accountQuota) {
        freshQuotas.push(accountQuota);
      }
      this.latestHud = hud;
      await this.orchestrator.pushHudSnapshot(hud);
    }

    if (freshQuotas.length > 0) {
      this.quotaSnapshots = freshQuotas;
    }
  }

  private getEffectiveQuotaSnapshots(): AccountQuotaSummary[] {
    if (this.quotaSnapshots.length > 0) return this.quotaSnapshots;
    const nowIso = new Date().toISOString();
    return this.accounts.list().map((acct) =>
      fuseAccountQuota({
        accountEmail: acct.email,
        active: acct.active,
        environment: 'local',
        updatedAt: nowIso,
        models: [
          { modelId: 'gemini-4-neon', family: 'gemini', ownRemainingFraction: null, familyWindows: [] },
          { modelId: 'claude-sonnet-4', family: 'claude', ownRemainingFraction: null, familyWindows: [] },
        ],
      }),
    );
  }

  async start(): Promise<void> {
    await this.ipc.start();
    await this.wallpaperGateway.start();
    await this.omniGateway.start();
    const wpPath = this.configStore.get().optics.wallpaperPath;
    if (wpPath) {
      try {
        this.wallpaperGateway.setActivePath(wpPath);
      } catch {
        // Ignore stale path at boot
      }
    }
    await this.scanAndAttach();
    if (
      this.configStore.get().autoLaunchAntigravity &&
      this.cdpPort === null &&
      !this.bareHostDetected &&
      !process.env.NODE_TEST_CONTEXT &&
      process.env.ANTIGRAVITY_ORBIT_NO_LAUNCH !== '1'
    ) {
      spawnAntigravityWithCdp(this.configStore.get().proxy);
    }
    this.pollTimer = setInterval(() => {
      void this.scanAndAttach();
    }, 2000);
    this.pollTimer.unref();

    this.telemetryTimer = setInterval(() => {
      void this.pollLiveTelemetry();
    }, 5000);
    this.telemetryTimer.unref();
  }

  async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.telemetryTimer) {
      clearInterval(this.telemetryTimer);
      this.telemetryTimer = null;
    }
    await this.orchestrator.ejectAll();
    await this.omniGateway.stop();
    await this.wallpaperGateway.stop();
    await this.ipc.stop();
    this.ledger.close();
  }

  getStatus(): DaemonStatus {
    const targets = this.orchestrator.getTargetSummaries();
    return {
      version: APP_VERSION,
      nodeVersion: process.version,
      pid: process.pid,
      platform: process.platform,
      arch: process.arch,
      cdpConnected: targets.length > 0,
      cdpPort: this.cdpPort,
      bareHostDetected: this.bareHostDetected,
      targets,
      activeChannels: resolveActiveChannels(this.configStore.get()),
      startedAt: this.startedAt,
    };
  }

  private async maybeAutoAttachBareHost(): Promise<void> {
    if (process.env.NODE_TEST_CONTEXT || process.env.ANTIGRAVITY_ORBIT_NO_LAUNCH === '1') return;
    if (this.accountSwitchInProgress) return;
    if (!this.bareHostDetected || !this.configStore.get().autoAttachBareHost) {
      this.bareHostFirstSeenAt = null;
      return;
    }
    const now = Date.now();
    if (this.bareHostFirstSeenAt === null) {
      this.bareHostFirstSeenAt = now;
      return;
    }
    // Require bare host to persist >= 1.8s across polls and enforce 30s anti-loop cooldown
    if (now - this.bareHostFirstSeenAt < 1800) return;
    if (this.autoAttachInProgress || now - this.lastAutoAttachAt < this.autoAttachCooldownMs) return;

    this.autoAttachInProgress = true;
    this.lastAutoAttachAt = now;
    this.bareHostFirstSeenAt = null;
    try {
      await this.safeRestartAntigravity();
    } catch {
      // Best-effort auto-attach; user can always retry manually
    } finally {
      this.autoAttachInProgress = false;
    }
  }

  private async scanAndAttach(): Promise<void> {
    const endpoint = discoverCdpEndpoint();
    if (!endpoint) {
      this.cdpPort = null;
      const hostStatus = await detectAntigravityHostStatus(null);
      this.bareHostDetected = hostStatus.bareHostDetected;
      await this.maybeAutoAttachBareHost();
      return;
    }
    this.cdpPort = endpoint.port;
    this.bareHostDetected = false;
    this.bareHostFirstSeenAt = null;

    try {
      const pages = await listCdpPageTargets(endpoint.port);
      const existingIds = new Set(this.orchestrator.getTargetSummaries().map((t) => t.id));
      let attachedNew = false;
      for (const page of pages) {
        if (existingIds.has(page.id) || !page.webSocketDebuggerUrl) continue;
        const client = new CdpClient(page.webSocketDebuggerUrl);
        await client.connect();
        const sshCtx = await probeSshRemoteContext(client).catch(() => ({
          isRemoteSsh: false,
          host: null,
          origin: null,
        }));
        await this.orchestrator.attachTarget(
          {
            id: page.id,
            title: page.title,
            url: page.url,
            isRemoteSsh: sshCtx.isRemoteSsh,
            sshHost: sshCtx.host ?? undefined,
          },
          client,
          this.configStore.get(),
        );
        attachedNew = true;
      }
      const activeWp = this.wallpaperGateway.getActiveUrl();
      if (activeWp) {
        await this.orchestrator.pushWallpaperSource(activeWp.url, activeWp.mime);
      }
      if (attachedNew || this.quotaSnapshots.length === 0) {
        await this.pollLiveTelemetry();
      }
      this.ipc.broadcast({ type: 'event', event: 'status.changed', payload: this.getStatus() });
    } catch {
      const hostStatus = await detectAntigravityHostStatus(null);
      this.bareHostDetected = hostStatus.bareHostDetected;
    }
  }

  private async launchAntigravity(): Promise<{
    launched: boolean;
    alreadyConnected: boolean;
    command: string;
    message: string;
  }> {
    const existingTargets = this.orchestrator.getTargetSummaries();
    if (existingTargets.length > 0 && this.cdpPort !== null) {
      await this.reconcileWithSideEffects(this.configStore.get());
      await this.pollLiveTelemetry();
      if (process.platform === 'darwin') {
        const child = spawn('open', ['-a', '/Applications/Antigravity.app'], {
          detached: true,
          stdio: 'ignore',
        });
        child.unref();
      }
      return {
        launched: true,
        alreadyConnected: true,
        command: 'reconcile',
        message: `Antigravity 已通过 CDP :${this.cdpPort} 连接（${existingTargets.length} 窗口），已同步通道与实时遥测`,
      };
    }

    const command = spawnAntigravityWithCdp(this.configStore.get().proxy);
    return {
      launched: true,
      alreadyConnected: false,
      command,
      message: this.bareHostDetected
        ? '检测到 Antigravity 已在无调试端口状态下运行，请点击「安全重启以连接」'
        : '已带参启动 Antigravity',
    };
  }

  private async orchestrateAccountSwitch(
    targetEmail: string,
    stateDbPath: string,
    autoRestart = true,
  ) {
    if (this.accountSwitchInProgress) {
      throw new Error('正在执行账号切换，请稍候...');
    }
    this.accountSwitchInProgress = true;
    try {
      // Safe harvest of outgoing account's freshest Keychain/state.vscdb before switching
      if (!process.env.NODE_TEST_CONTEXT) {
        try {
          await this.accounts.harvestOutgoingAccountAsync({
            stateDbPath,
            targetEmail,
            liveEmail: this.liveUserEmail,
            liveNickname: this.liveUserName,
          });
        } catch {
          // Outgoing account may not be logged in; proceed cleanly
        }
      }

      const hostStatus = await detectAntigravityHostStatus(this.cdpPort);
      const wasRunning =
        this.orchestrator.getTargetSummaries().length > 0 ||
        this.bareHostDetected ||
        hostStatus.hostRunning;

      if (wasRunning && autoRestart && !process.env.NODE_TEST_CONTEXT) {
        await this.orchestrator.ejectAll();
        const exited = await gracefulQuitAntigravity(8000);
        if (!exited) {
          throw new Error('Antigravity 未在 8 秒内退出，请手动 Cmd+Q 后重试切换');
        }
        // Let SQLite WAL flush completely before mutating state.vscdb
        await new Promise((r) => setTimeout(r, 350));
      } else if (wasRunning && !autoRestart) {
        throw new Error('Antigravity is still running; stop it gracefully before switching accounts');
      }

      const result = await this.accounts.switchAccountAsync(targetEmail, {
        stateDbPath,
        isHostRunning: false,
      });

      this.quotaSnapshots = [];
      this.liveUserEmail = null;
      this.liveUserName = null;
      this.cdpPort = null;
      this.bareHostDetected = false;

      if (wasRunning && autoRestart && !process.env.NODE_TEST_CONTEXT) {
        spawnAntigravityWithCdp(this.configStore.get().proxy);
        return { ...result, restarted: true };
      }
      return { ...result, restarted: false };
    } finally {
      this.accountSwitchInProgress = false;
    }
  }

  private async safeRestartAntigravity(): Promise<{ restarted: boolean; message: string }> {
    await this.orchestrator.ejectAll();
    const exited = await gracefulQuitAntigravity(5000);
    if (!exited) {
      return {
        restarted: false,
        message: 'Antigravity 未在 5 秒内退出，请手动 Cmd+Q 后再点击「带参启动 Antigravity」',
      };
    }
    spawnAntigravityWithCdp(this.configStore.get().proxy);
    return {
      restarted: true,
      message: '已安全重启 Antigravity 并开启本地调试端口，正在自动连接...',
    };
  }

  private async handleIpcRequest(
    method: string,
    params: Record<string, unknown> | undefined,
  ): Promise<unknown> {
    switch (method) {
      case 'daemon.status':
        return this.getStatus();
      case 'config.get':
        return this.configStore.get();
      case 'config.patch': {
        const patch = (params?.patch ?? params) as DeepPartial<AntigravityOrbitConfig>;
        if (typeof patch?.autoStartOnLogin === 'boolean' && !process.env.NODE_TEST_CONTEXT) {
          setAutoStartEnabled(patch.autoStartOnLogin);
        }
        return this.configStore.patch(patch);
      }
      case 'config.applyPreset':
        return this.configStore.applyPreset(params?.preset as VisualBudgetMode);
      case 'cdp.reconnect':
        await this.scanAndAttach();
        await this.pollLiveTelemetry();
        return this.getStatus();
      case 'cdp.ejectAll':
        await this.orchestrator.ejectAll();
        return this.getStatus();
      case 'antigravity.launch':
        return this.launchAntigravity();
      case 'antigravity.safeRestart':
        return this.safeRestartAntigravity();
      case 'autostart.status':
        return getAutoStartStatus();
      case 'autostart.set': {
        const enabled = Boolean(params?.enabled);
        const status = setAutoStartEnabled(enabled);
        this.configStore.patch({ autoStartOnLogin: status.enabled });
        // Hand off cleanly to the launchd-managed daemon when switching on from a GUI-spawned daemon
        if (
          process.platform === 'darwin' &&
          status.enabled &&
          process.env.ANTIGRAVITY_ORBIT_MANAGED_BY_LAUNCHD !== '1' &&
          !process.env.NODE_TEST_CONTEXT
        ) {
          setTimeout(() => process.exit(0), 250).unref();
        }
        return status;
      }
      case 'console.open': {
        const page = (params?.page as ConsolePage) || 'overview';
        this.ipc.broadcast({ type: 'event', event: 'console.open', payload: { page } });
        return { ok: true, page };
      }
      case 'usage.summary':
        return this.ledger.summarize((params as UsageFilter | undefined) ?? {});
      case 'usage.record': {
        const inserted = this.ledger.record(params as unknown as UsageRecordInput);
        if (inserted) void this.pollLiveTelemetry();
        return { inserted };
      }
      case 'quota.summary':
        return this.getEffectiveQuotaSnapshots();
      case 'hud.snapshot':
        return this.latestHud;
      case 'wallpaper.url':
        if (typeof params?.path === 'string') {
          return this.wallpaperGateway.setActivePath(params.path);
        }
        return this.wallpaperGateway.getActiveUrl();
      case 'translator.translate':
        return this.translator.translate(params as unknown as TranslateRequest);
      case 'omni.sign':
        return this.omniGateway.signFileUrl(String(params?.path ?? ''));
      case 'diff.file':
        return {
          diff: await getSafeInlineDiff(String(params?.repoRoot ?? ''), String(params?.file ?? '')),
        };
      case 'accounts.list':
        return this.accounts.listAsync(this.liveUserEmail);
      case 'accounts.save':
        return this.accounts.save(
          params as unknown as { email: string; nickname?: string; oauthToken: string; active?: boolean },
        );
      case 'accounts.captureCurrent':
        return this.accounts.captureCurrentAccountAsync({
          stateDbPath:
            typeof params?.stateDbPath === 'string' && params.stateDbPath
              ? params.stateDbPath
              : resolveAntigravityStateDbPath(),
          liveEmail: this.liveUserEmail,
          liveNickname: this.liveUserName,
        });
      case 'accounts.switch':
        return this.orchestrateAccountSwitch(
          String(params?.email ?? ''),
          typeof params?.stateDbPath === 'string' && params.stateDbPath
            ? params.stateDbPath
            : resolveAntigravityStateDbPath(),
          params?.autoRestart !== false,
        );
      case 'accounts.delete':
        return { deleted: this.accounts.deleteAccount(String(params?.email ?? '')) };
      case 'proxy.diagnose':
        return diagnoseProxy(this.configStore.get().proxy);
      case 'maintenance.scan':
        return {
          candidates: this.maintenance.scanAntigravityStorage(),
          manifests: this.maintenance.listTrashManifests(),
        };
      case 'maintenance.clean':
        return this.maintenance.moveToReversibleTrash(
          (params?.targets as string[] | undefined) ?? [],
          this.orchestrator.getTargetSummaries().length > 0 || this.bareHostDetected,
        );
      case 'maintenance.restore':
        return this.maintenance.restoreFromTrash(String(params?.manifestId ?? ''));
      case 'update.check':
        return this.updater.checkForUpdates(APP_VERSION);
      case 'update.install':
        return this.updater.downloadAndOpenInstaller(
          String(params?.downloadUrl ?? ''),
          String(params?.fileName ?? ''),
        );
      default:
        throw new Error(`Unknown IPC method: ${method}`);
    }
  }
}

export * from './config/store.js';
export * from './ipc/server.js';
export * from './platform/paths.js';
export * from './platform/autostart.js';
export * from './platform/host-process.js';
export * from './cdp/discovery.js';
export * from './cdp/client.js';
export * from './cdp/orchestrator.js';
export * from './ledger/protobuf.js';
export * from './ledger/pricing.js';
export * from './ledger/store.js';
export * from './quota/fusion.js';
export * from './telemetry/collector.js';
export * from './ssh/remote-rpc.js';
export * from './services/wallpaper-gateway.js';
export * from './services/omni-gateway.js';
export * from './services/thought-translator.js';
export * from './services/inline-diff.js';
export * from './accounts/codec.js';
export * from './accounts/manager.js';
export * from './accounts/keychain.js';
export * from './services/proxy.js';
export * from './maintenance/cleaner.js';
export * from './services/updater.js';

const isMainEntry =
  typeof process.argv[1] === 'string' &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isMainEntry) {
  const daemon = new AntigravityOrbitDaemon();
  const shutdown = () => {
    void daemon.stop().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  await daemon.start();
}
