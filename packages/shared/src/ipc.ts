import type { ChannelId, DeepPartial, AntigravityOrbitConfig } from './config.js';

export type ConsolePage = 'overview' | 'accounts' | 'usage' | 'maintenance' | 'appearance';

export interface TargetSummary {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly isRemoteSsh: boolean;
  readonly activeChannels: readonly ChannelId[];
}

export interface DaemonStatus {
  readonly version: string;
  readonly nodeVersion: string;
  readonly pid: number;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly cdpConnected: boolean;
  readonly cdpPort: number | null;
  readonly bareHostDetected: boolean;
  readonly targets: readonly TargetSummary[];
  readonly activeChannels: readonly ChannelId[];
  readonly startedAt: string;
}

export type IpcMethod =
  | 'daemon.status'
  | 'config.get'
  | 'config.patch'
  | 'config.applyPreset'
  | 'cdp.reconnect'
  | 'cdp.ejectAll'
  | 'antigravity.launch'
  | 'antigravity.safeRestart'
  | 'console.open'
  | 'usage.summary'
  | 'usage.record'
  | 'quota.summary'
  | 'hud.snapshot'
  | 'wallpaper.url'
  | 'translator.translate'
  | 'omni.sign'
  | 'diff.file'
  | 'accounts.list'
  | 'accounts.save'
  | 'accounts.captureCurrent'
  | 'accounts.switch'
  | 'accounts.delete'
  | 'proxy.diagnose'
  | 'maintenance.scan'
  | 'maintenance.clean'
  | 'maintenance.restore'
  | 'update.check'
  | 'update.install';

export interface IpcRequest {
  readonly id: string;
  readonly authToken?: string;
  readonly method: IpcMethod;
  readonly params?: Record<string, unknown>;
}

export interface IpcResponse {
  readonly id: string;
  readonly ok: boolean;
  readonly result?: unknown;
  readonly error?: {
    readonly code: string;
    readonly message: string;
  };
}

export type IpcEvent =
  | { readonly type: 'event'; readonly event: 'config.changed'; readonly payload: AntigravityOrbitConfig }
  | { readonly type: 'event'; readonly event: 'status.changed'; readonly payload: DaemonStatus }
  | { readonly type: 'event'; readonly event: 'console.open'; readonly payload: { readonly page: ConsolePage } };

export interface ConfigPatchParams {
  readonly patch: DeepPartial<AntigravityOrbitConfig>;
}

export function redactSecrets(input: string): string {
  return input
    .replace(/(sk-[a-zA-Z0-9_-]{12,})/g, 'sk-***REDACTED***')
    .replace(/(ya29\.[a-zA-Z0-9._-]{16,})/g, 'ya29.***REDACTED***')
    .replace(/(Bearer\s+)[a-zA-Z0-9._-]{12,}/gi, '$1***REDACTED***')
    .replace(/("authToken"\s*:\s*")[^"]+(")/g, '$1***REDACTED***$2');
}
