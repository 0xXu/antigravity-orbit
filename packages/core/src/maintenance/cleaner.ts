import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  MaintenanceCandidate,
  MaintenanceEntry,
  MaintenanceManifest,
  SubagentArchiveResult,
} from '@antigravity-orbit/shared';
import { atomicWritePrivateFile, ensurePrivateDir } from '../platform/paths.js';

const FORBIDDEN_SEGMENTS = [
  'user',
  'cookies',
  'local storage',
  'session storage',
  'state.vscdb',
  'conversation_summaries.db',
];

export function isMaintenanceTargetSafe(targetPath: string): boolean {
  const normalized = targetPath.replaceAll('\\', '/').toLowerCase();
  const segments = normalized.split('/').filter(Boolean);
  return !segments.some((seg) => FORBIDDEN_SEGMENTS.includes(seg));
}

/**
 * Reversible cache maintenance & lossless subagent SQLite archiver.
 * Records (dev, ino) in a write-ahead manifest before moving files so restore
 * never clobbers regenerated files.
 */
export class ReversibleMaintenanceService {
  private readonly trashRoot: string;
  private readonly archiveRoot: string;

  constructor(stateDir: string) {
    this.trashRoot = path.join(stateDir, 'maintenance-trash');
    this.archiveRoot = path.join(stateDir, 'subagent-archives');
    ensurePrivateDir(this.trashRoot);
    ensurePrivateDir(this.archiveRoot);
  }

  scanAntigravityStorage(customRoots?: { appDataDir?: string; conversationsDir?: string }): MaintenanceCandidate[] {
    const home = os.homedir();
    const appDataDir =
      customRoots?.appDataDir ??
      (process.platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support', 'Antigravity')
        : process.platform === 'win32'
          ? path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Antigravity')
          : path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Antigravity'));

    const cacheDirs = [
      { rel: 'GPUCache', label: 'GPU 着色器缓存 (GPUCache)' },
      { rel: 'Cache', label: 'Chromium 网络缓存 (Cache)' },
      { rel: 'Code Cache', label: 'V8 字节码缓存 (Code Cache)' },
      { rel: 'CachedData', label: 'Electron 编译缓存 (CachedData)' },
      { rel: 'DawnGraphiteCache', label: 'Dawn Graphite 缓存' },
      { rel: 'DawnWebGPUCache', label: 'Dawn WebGPU 缓存' },
    ];

    const candidates: MaintenanceCandidate[] = [];
    const computeDirSize = (dir: string, depth = 0): number => {
      if (depth > 4 || !fs.existsSync(dir)) return 0;
      let total = 0;
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isSymbolicLink()) continue;
          if (entry.isFile()) {
            total += fs.lstatSync(full).size;
          } else if (entry.isDirectory()) {
            total += computeDirSize(full, depth + 1);
          }
        }
      } catch {
        // Ignore unreadable entries
      }
      return total;
    };

    for (const item of cacheDirs) {
      const full = path.join(appDataDir, item.rel);
      if (!fs.existsSync(full)) continue;
      const sizeBytes = computeDirSize(full);
      if (sizeBytes > 0) {
        candidates.push({
          path: full,
          label: item.label,
          kind: 'cache',
          sizeBytes,
          safe: isMaintenanceTargetSafe(full),
        });
      }
    }

    const convDir = customRoots?.conversationsDir ?? path.join(home, '.gemini', 'antigravity', 'conversations');
    if (fs.existsSync(convDir)) {
      try {
        for (const entry of fs.readdirSync(convDir, { withFileTypes: true })) {
          if (!entry.isFile() || !entry.name.endsWith('.db')) continue;
          const full = path.join(convDir, entry.name);
          const stat = fs.lstatSync(full);
          if (stat.size >= 5 * 1024 * 1024) {
            candidates.push({
              path: full,
              label: `大型会话库 (${entry.name})`,
              kind: 'subagent-db',
              sizeBytes: stat.size,
              safe: isMaintenanceTargetSafe(full),
            });
          }
        }
      } catch {
        // Ignore unreadable conversation dir
      }
    }

    return candidates.sort((a, b) => b.sizeBytes - a.sizeBytes);
  }

  listTrashManifests(): MaintenanceManifest[] {
    if (!fs.existsSync(this.trashRoot)) return [];
    const out: MaintenanceManifest[] = [];
    for (const entry of fs.readdirSync(this.trashRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const mf = path.join(this.trashRoot, entry.name, 'manifest.json');
      if (!fs.existsSync(mf)) continue;
      try {
        out.push(JSON.parse(fs.readFileSync(mf, 'utf8')) as MaintenanceManifest);
      } catch {
        // Ignore corrupt manifest
      }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  moveToReversibleTrash(targetPaths: readonly string[], isHostRunning: boolean): MaintenanceManifest {
    if (isHostRunning) {
      throw new Error('Cannot clean caches while Antigravity is running');
    }

    const id = `clean-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const batchDir = path.join(this.trashRoot, id);
    ensurePrivateDir(batchDir);

    const entries: MaintenanceEntry[] = [];
    for (const rawTarget of targetPaths) {
      if (!isMaintenanceTargetSafe(rawTarget)) {
        throw new Error(`Refusing protected path: ${rawTarget}`);
      }
      if (!fs.existsSync(rawTarget)) continue;
      const stat = fs.lstatSync(rawTarget);
      if (stat.isSymbolicLink()) {
        throw new Error(`Refusing symlink target: ${rawTarget}`);
      }

      const trashedPath = path.join(batchDir, `${entries.length}-${path.basename(rawTarget)}`);
      fs.renameSync(rawTarget, trashedPath);
      entries.push({
        originalPath: rawTarget,
        trashedPath,
        sizeBytes: stat.size,
        dev: Number(stat.dev),
        ino: Number(stat.ino),
      });
    }

    const manifest: MaintenanceManifest = {
      id,
      createdAt: new Date().toISOString(),
      entries,
    };
    atomicWritePrivateFile(path.join(batchDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  }

  restoreFromTrash(manifestId: string): { restored: number; skipped: number } {
    const manifestPath = path.join(this.trashRoot, manifestId, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`Maintenance manifest not found: ${manifestId}`);
    }
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as MaintenanceManifest;
    let restored = 0;
    let skipped = 0;

    for (const entry of manifest.entries) {
      if (!fs.existsSync(entry.trashedPath) || fs.existsSync(entry.originalPath)) {
        skipped += 1;
        continue;
      }
      const stat = fs.lstatSync(entry.trashedPath);
      if (Number(stat.dev) !== entry.dev || Number(stat.ino) !== entry.ino) {
        skipped += 1;
        continue;
      }
      fs.mkdirSync(path.dirname(entry.originalPath), { recursive: true });
      fs.renameSync(entry.trashedPath, entry.originalPath);
      restored += 1;
    }

    atomicWritePrivateFile(
      manifestPath,
      `${JSON.stringify({ ...manifest, restoredAt: new Date().toISOString() }, null, 2)}\n`,
    );
    return { restored, skipped };
  }

  /**
   * Archives cold subagent SQLite triplets (.db, .db-wal, .db-shm) with a lossless manifest
   * to keep Antigravity's language_server memory footprint bounded.
   */
  archiveSubagentDbs(dbFiles: readonly string[]): SubagentArchiveResult {
    const archiveId = `arc-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const destDir = path.join(this.archiveRoot, archiveId);
    ensurePrivateDir(destDir);

    const archivedFiles: string[] = [];
    let totalBytes = 0;

    for (const dbFile of dbFiles) {
      for (const suffix of ['', '-wal', '-shm']) {
        const candidate = `${dbFile}${suffix}`;
        if (!fs.existsSync(candidate)) continue;
        const stat = fs.lstatSync(candidate);
        if (stat.isSymbolicLink() || !stat.isFile()) continue;
        const dest = path.join(destDir, path.basename(candidate));
        fs.renameSync(candidate, dest);
        archivedFiles.push(candidate);
        totalBytes += stat.size;
      }
    }

    atomicWritePrivateFile(
      path.join(destDir, 'archive-manifest.json'),
      `${JSON.stringify({ archiveId, createdAt: new Date().toISOString(), archivedFiles, totalBytes }, null, 2)}\n`,
    );
    return { archiveId, archivedFiles, totalBytes };
  }
}
