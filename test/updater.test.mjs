import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  UpdateService,
  compareSemver,
  selectPlatformAsset,
  validateReleaseDownloadUrl,
} from '../packages/core/dist/main.js';

describe('core/services/updater: semver, asset selection, and URL allowlist', () => {
  it('compares semver strings including v-prefix and prerelease tags', () => {
    assert.equal(compareSemver('0.1.0', 'v0.1.0'), 0);
    assert.equal(compareSemver('0.1.1', '0.1.0'), 1);
    assert.equal(compareSemver('0.2.0', '0.1.9'), 1);
    assert.equal(compareSemver('1.0.0', '0.9.9'), 1);
    assert.equal(compareSemver('0.1.0', '0.2.0'), -1);
    assert.equal(compareSemver('0.2.0', '0.2.0-beta.1'), 1);
    assert.equal(compareSemver('0.2.0-beta.1', '0.2.0'), -1);
  });

  it('selects matching installer assets for macOS arm64, macOS x64, and Windows x64', () => {
    const assets = [
      { name: 'antigravity-orbit-core-v0.2.0.tar.gz', downloadUrl: 'https://github.com/a', sizeBytes: 100 },
      { name: 'Antigravity.Orbit_0.2.0_aarch64.dmg', downloadUrl: 'https://github.com/b', sizeBytes: 200 },
      { name: 'Antigravity.Orbit_0.2.0_x64.dmg', downloadUrl: 'https://github.com/c', sizeBytes: 200 },
      { name: 'Antigravity.Orbit_0.2.0_x64-setup.exe', downloadUrl: 'https://github.com/d', sizeBytes: 300 },
      { name: 'Antigravity.Orbit_0.2.0_x64_en-US.msi', downloadUrl: 'https://github.com/e', sizeBytes: 300 },
    ];

    assert.equal(selectPlatformAsset(assets, 'darwin', 'arm64')?.name, 'Antigravity.Orbit_0.2.0_aarch64.dmg');
    assert.equal(selectPlatformAsset(assets, 'darwin', 'x64')?.name, 'Antigravity.Orbit_0.2.0_x64.dmg');
    assert.equal(selectPlatformAsset(assets, 'win32', 'x64')?.name, 'Antigravity.Orbit_0.2.0_x64-setup.exe');
    assert.equal(selectPlatformAsset(assets, 'linux', 'x64')?.name, 'antigravity-orbit-core-v0.2.0.tar.gz');
  });

  it('enforces HTTPS and GitHub release host allowlist', () => {
    assert.doesNotThrow(() =>
      validateReleaseDownloadUrl(
        'https://github.com/0xXu/antigravity-orbit/releases/download/v0.2.0/Antigravity.Orbit_0.2.0_aarch64.dmg',
      ),
    );
    assert.doesNotThrow(() =>
      validateReleaseDownloadUrl('https://release-assets.githubusercontent.com/github-production-release-asset/123'),
    );

    assert.throws(() =>
      validateReleaseDownloadUrl('http://github.com/0xXu/antigravity-orbit/releases/download/v0.2.0/a.dmg'),
    );
    assert.throws(() =>
      validateReleaseDownloadUrl('https://github.com/evil/other-repo/releases/download/v1.0.0/a.dmg'),
    );
    assert.throws(() => validateReleaseDownloadUrl('https://evil.example.com/a.dmg'));
  });
});

describe('core/services/updater: UpdateService check and download flow', () => {
  it('checks latest release, detects available update, and downloads installer atomically', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-orbit-upd-'));
    const server = http.createServer((req, res) => {
      if (req.url === '/repos/0xXu/antigravity-orbit/releases/latest') {
        const { port } = server.address();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            tag_name: 'v0.2.0',
            name: 'Antigravity Orbit v0.2.0',
            body: 'Auto-update support',
            html_url: 'https://github.com/0xXu/antigravity-orbit/releases/tag/v0.2.0',
            published_at: '2026-11-26T15:00:00Z',
            assets: [
              {
                name: 'Antigravity.Orbit_0.2.0_aarch64.dmg',
                browser_download_url: `http://127.0.0.1:${port}/downloads/Antigravity.Orbit_0.2.0_aarch64.dmg`,
                size: 16,
              },
            ],
          }),
        );
        return;
      }
      if (req.url === '/downloads/Antigravity.Orbit_0.2.0_aarch64.dmg') {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end('MOCK_DMG_PAYLOAD');
        return;
      }
      res.writeHead(404).end();
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
      const svc = new UpdateService({
        cacheDir: tmpDir,
        apiBaseUrl: `http://127.0.0.1:${port}`,
        allowInsecureTestOrigin: true,
      });

      const check = await svc.checkForUpdates('0.1.0', 'darwin', 'arm64');
      assert.equal(check.hasUpdate, true);
      assert.equal(check.latestVersion, '0.2.0');
      assert.equal(check.asset?.name, 'Antigravity.Orbit_0.2.0_aarch64.dmg');

      const upToDate = await svc.checkForUpdates('0.2.0', 'darwin', 'arm64');
      assert.equal(upToDate.hasUpdate, false);

      // Rejects traversal filenames
      await assert.rejects(
        () => svc.downloadAndOpenInstaller(check.asset.downloadUrl, '../evil.dmg', { openInstaller: false }),
        /Invalid update filename/,
      );

      // Downloads atomically to cacheDir/updates
      const installed = await svc.downloadAndOpenInstaller(
        check.asset.downloadUrl,
        check.asset.name,
        { openInstaller: false },
      );
      assert.equal(installed.opened, false);
      assert.equal(fs.readFileSync(installed.downloadedPath, 'utf8'), 'MOCK_DMG_PAYLOAD');
    } finally {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
