import type { ProxyMode } from './config.js';

export interface SavedAccount {
  readonly email: string;
  readonly nickname: string;
  readonly active: boolean;
  readonly savedAt: string;
  readonly lastUsedAt: string;
}

export interface AccountRecordWithSecrets extends SavedAccount {
  readonly oauthToken: string;
  readonly userStatus?: string;
}

export interface AccountSwitchResult {
  readonly switchedTo: string;
  readonly previousEmail: string | null;
  readonly journalId: string;
  readonly rolledBack: boolean;
}

export interface ProxyDiagnostics {
  readonly mode: ProxyMode;
  readonly effectiveUrl: string | null;
  readonly shellConflict: boolean;
  readonly shellEnvUrl: string | null;
  readonly warning: string | null;
}

export interface MaintenanceEntry {
  readonly originalPath: string;
  readonly trashedPath: string;
  readonly sizeBytes: number;
  readonly dev: number;
  readonly ino: number;
}

export interface MaintenanceManifest {
  readonly id: string;
  readonly createdAt: string;
  readonly entries: readonly MaintenanceEntry[];
  readonly restoredAt?: string;
}

export interface MaintenanceCandidate {
  readonly path: string;
  readonly label: string;
  readonly kind: 'cache' | 'subagent-db';
  readonly sizeBytes: number;
  readonly safe: boolean;
}

export interface SubagentArchiveResult {
  readonly archiveId: string;
  readonly archivedFiles: readonly string[];
  readonly totalBytes: number;
}

export interface UpdateAssetInfo {
  readonly name: string;
  readonly downloadUrl: string;
  readonly sizeBytes: number;
}

export interface UpdateCheckResult {
  readonly currentVersion: string;
  readonly latestVersion: string;
  readonly hasUpdate: boolean;
  readonly releaseName: string;
  readonly releaseNotes: string;
  readonly releaseUrl: string;
  readonly publishedAt: string;
  readonly asset: UpdateAssetInfo | null;
}

export interface UpdateInstallResult {
  readonly downloadedPath: string;
  readonly opened: boolean;
  readonly message: string;
}

export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!local || !domain) return '•••';
  return `${local.slice(0, 1)}•••@${domain}`;
}
