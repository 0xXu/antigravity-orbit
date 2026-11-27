import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  UpdateAssetInfo,
  UpdateCheckResult,
  UpdateInstallResult,
} from '@antigravity-orbit/shared';
import { ensurePrivateDir } from '../platform/paths.js';

const DEFAULT_REPO = '0xXu/antigravity-orbit';
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);
const SAFE_FILENAME_RE = /^[A-Za-z0-9._-]+$/;

interface GitHubAsset {
  readonly name: string;
  readonly browser_download_url: string;
  readonly size: number;
}

interface GitHubReleaseResponse {
  readonly tag_name: string;
  readonly name?: string;
  readonly body?: string;
  readonly html_url: string;
  readonly published_at?: string;
  readonly assets?: readonly GitHubAsset[];
}

export function compareSemver(a: string, b: string): number {
  const parse = (raw: string) => {
    const cleaned = raw.trim().replace(/^v/i, '');
    const [corePart = '0.0.0', prePart] = cleaned.split('-', 2);
    const nums = corePart.split('.').map((n) => Number.parseInt(n, 10) || 0);
    return {
      major: nums[0] ?? 0,
      minor: nums[1] ?? 0,
      patch: nums[2] ?? 0,
      pre: prePart ?? null,
    };
  };

  const va = parse(a);
  const vb = parse(b);
  if (va.major !== vb.major) return va.major > vb.major ? 1 : -1;
  if (va.minor !== vb.minor) return va.minor > vb.minor ? 1 : -1;
  if (va.patch !== vb.patch) return va.patch > vb.patch ? 1 : -1;

  // Stable release > prerelease of same version
  if (va.pre === null && vb.pre !== null) return 1;
  if (va.pre !== null && vb.pre === null) return -1;
  if (va.pre !== null && vb.pre !== null) {
    return va.pre.localeCompare(vb.pre);
  }
  return 0;
}

export function selectPlatformAsset(
  assets: readonly UpdateAssetInfo[],
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): UpdateAssetInfo | null {
  const byName = (pred: (lower: string) => boolean) =>
    assets.find((a) => pred(a.name.toLowerCase())) ?? null;

  if (platform === 'darwin') {
    if (arch === 'arm64') {
      return (
        byName((n) => n.endsWith('_aarch64.dmg')) ??
        byName((n) => n.endsWith('.dmg') && n.includes('arm64')) ??
        byName((n) => n.endsWith('.dmg'))
      );
    }
    return (
      byName((n) => n.endsWith('_x64.dmg')) ??
      byName((n) => n.endsWith('.dmg') && !n.includes('aarch64')) ??
      byName((n) => n.endsWith('.dmg'))
    );
  }

  if (platform === 'win32') {
    return (
      byName((n) => n.endsWith('-setup.exe')) ??
      byName((n) => n.endsWith('.exe')) ??
      byName((n) => n.endsWith('.msi'))
    );
  }

  return byName((n) => n.startsWith('antigravity-orbit-core-') && n.endsWith('.tar.gz'));
}

export function validateReleaseDownloadUrl(rawUrl: string, repo = DEFAULT_REPO): URL {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'https:') {
    throw new Error(`Refusing non-HTTPS update URL: ${parsed.protocol}`);
  }
  const host = parsed.hostname.toLowerCase();
  if (!ALLOWED_DOWNLOAD_HOSTS.has(host)) {
    throw new Error(`Refusing untrusted update host: ${host}`);
  }
  if (host === 'github.com' && !parsed.pathname.toLowerCase().startsWith(`/${repo.toLowerCase()}/releases/`)) {
    throw new Error(`Refusing GitHub URL outside ${repo} releases`);
  }
  return parsed;
}

export interface UpdateServiceOptions {
  readonly cacheDir: string;
  readonly repo?: string;
  readonly apiBaseUrl?: string;
  readonly allowInsecureTestOrigin?: boolean;
}

export class UpdateService {
  private readonly updatesDir: string;
  private readonly repo: string;
  private readonly apiBaseUrl: string;
  private readonly allowInsecureTestOrigin: boolean;

  constructor(opts: UpdateServiceOptions) {
    this.updatesDir = path.join(opts.cacheDir, 'updates');
    this.repo = opts.repo ?? DEFAULT_REPO;
    this.apiBaseUrl = (opts.apiBaseUrl ?? 'https://api.github.com').replace(/\/$/, '');
    this.allowInsecureTestOrigin = Boolean(opts.allowInsecureTestOrigin);
  }

  async checkForUpdates(
    currentVersion: string,
    platform: NodeJS.Platform = process.platform,
    arch: string = process.arch,
  ): Promise<UpdateCheckResult> {
    const endpoint = `${this.apiBaseUrl}/repos/${this.repo}/releases/latest`;
    const res = await fetch(endpoint, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': `Antigravity-Orbit/${currentVersion}`,
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      throw new Error(`检查更新失败 (GitHub API HTTP ${res.status})`);
    }

    const release = (await res.json()) as GitHubReleaseResponse;
    const latestVersion = release.tag_name.replace(/^v/i, '');
    const normalizedCurrent = currentVersion.replace(/^v/i, '');
    const assets: UpdateAssetInfo[] = (release.assets ?? []).map((a) => ({
      name: a.name,
      downloadUrl: a.browser_download_url,
      sizeBytes: a.size,
    }));

    return {
      currentVersion: normalizedCurrent,
      latestVersion,
      hasUpdate: compareSemver(latestVersion, normalizedCurrent) > 0,
      releaseName: release.name || release.tag_name,
      releaseNotes: (release.body ?? '').trim(),
      releaseUrl: release.html_url,
      publishedAt: release.published_at ?? '',
      asset: selectPlatformAsset(assets, platform, arch),
    };
  }

  async downloadAndOpenInstaller(
    downloadUrl: string,
    fileName: string,
    opts: { openInstaller?: boolean } = {},
  ): Promise<UpdateInstallResult> {
    if (!fileName || !SAFE_FILENAME_RE.test(fileName) || fileName.includes('..')) {
      throw new Error(`Invalid update filename: ${fileName}`);
    }

    const url = this.allowInsecureTestOrigin
      ? new URL(downloadUrl)
      : validateReleaseDownloadUrl(downloadUrl, this.repo);

    const res = await fetch(url, {
      headers: { 'user-agent': 'Antigravity-Orbit-Updater' },
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      throw new Error(`下载更新失败 (HTTP ${res.status})`);
    }

    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) {
      throw new Error('下载的更新包为空文件');
    }

    ensurePrivateDir(this.updatesDir);
    const destPath = path.join(this.updatesDir, fileName);
    const tmpPath = `${destPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmpPath, buf, { mode: 0o600 });
    fs.renameSync(tmpPath, destPath);

    let opened = false;
    if (opts.openInstaller !== false) {
      opened = this.launchInstaller(destPath);
    }

    return {
      downloadedPath: destPath,
      opened,
      message: opened
        ? process.platform === 'darwin'
          ? `已下载并打开安装包：${fileName}（请在弹出的镜像中拖入 Applications 完成替换）`
          : `已下载并启动安装程序：${fileName}`
        : `更新包已下载至：${destPath}`,
    };
  }

  private launchInstaller(installerPath: string): boolean {
    if (process.platform === 'darwin') {
      const child = spawn('open', [installerPath], { detached: true, stdio: 'ignore' });
      child.unref();
      return true;
    }
    if (process.platform === 'win32') {
      const child = spawn('cmd', ['/c', 'start', '', installerPath], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      return true;
    }
    return false;
  }
}
