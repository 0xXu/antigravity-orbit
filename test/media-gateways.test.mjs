import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  OmniStreamingGateway,
  WallpaperGateway,
  isWallpaperPathAllowed,
} from '../packages/core/dist/main.js';

describe('core/services: WallpaperGateway', () => {
  it('enforces media allowlist, blocks sensitive/UNC paths, and serves HTTP 200/206/416/401/404', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-orbit-wp-'));
    const gateway = new WallpaperGateway();
    try {
      const sampleMp4 = path.join(tmpDir, 'loop.mp4');
      const payload = Buffer.from('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ');
      fs.writeFileSync(sampleMp4, payload);

      const badExt = path.join(tmpDir, 'notes.txt');
      fs.writeFileSync(badExt, 'secret');
      const envMedia = path.join(tmpDir, '.env.mp4');
      fs.writeFileSync(envMedia, 'secret');

      assert.equal(isWallpaperPathAllowed(badExt).ok, false);
      assert.equal(isWallpaperPathAllowed(envMedia).ok, false);
      assert.equal(isWallpaperPathAllowed('\\\\evil-host\\share\\a.mp4').ok, false);
      assert.equal(isWallpaperPathAllowed(path.join(tmpDir, 'missing.mp4')).ok, false);

      const port = await gateway.start();
      assert.ok(port > 0);
      assert.equal(gateway.getActiveUrl(), null);

      const active = gateway.setActivePath(sampleMp4);
      assert.ok(active?.url.startsWith(`http://127.0.0.1:${port}/wallpaper?token=`));
      assert.equal(active?.mime, 'video/mp4');

      // Wrong token -> 401
      const unauth = await fetch(`http://127.0.0.1:${port}/wallpaper?token=invalid`);
      assert.equal(unauth.status, 401);

      // Full 200 fetch
      const full = await fetch(active.url);
      assert.equal(full.status, 200);
      assert.equal(full.headers.get('accept-ranges'), 'bytes');
      assert.equal(full.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(await full.text(), payload.toString('utf8'));

      // HTTP 206 Partial Content Range fetch
      const partial = await fetch(active.url, { headers: { Range: 'bytes=10-19' } });
      assert.equal(partial.status, 206);
      assert.equal(partial.headers.get('content-range'), `bytes 10-19/${payload.length}`);
      assert.equal(await partial.text(), 'ABCDEFGHIJ');

      // Out-of-bounds range -> 416
      const oob = await fetch(active.url, { headers: { Range: 'bytes=999-1000' } });
      assert.equal(oob.status, 416);

      // Clearing active path returns 404 on valid token
      assert.equal(gateway.setActivePath(''), null);
      const cleared = await fetch(active.url);
      assert.equal(cleared.status, 404);
    } finally {
      await gateway.stop();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('core/services: OmniStreamingGateway', () => {
  it('enforces per-directory HMAC scope, TTL expiry, sandbox CSP, and HTTP 206 Range', async () => {
    const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-orbit-omni-a-'));
    const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-orbit-omni-b-'));
    const gw = new OmniStreamingGateway();
    try {
      const fileA = path.join(tmpA, 'report.csv');
      const fileB = path.join(tmpB, 'other.csv');
      const badExt = path.join(tmpA, 'script.sh');
      const envCsv = path.join(tmpA, '.env.csv');
      fs.writeFileSync(fileA, 'col1,col2\n1,hello\n2,world\n');
      fs.writeFileSync(fileB, 'secret,data\n');
      fs.writeFileSync(badExt, '#!/bin/sh\n');
      fs.writeFileSync(envCsv, 'k,v\n');

      // Signing before start throws
      assert.throws(() => gw.signFileUrl(fileA), /not started/);

      await gw.start();
      assert.throws(() => gw.signFileUrl(badExt), /Unsupported Omni media type/);
      assert.throws(() => gw.signFileUrl(envCsv), /Blocked sensitive path/);

      const signed = gw.signFileUrl(fileA);
      const res206 = await fetch(signed.url, { headers: { Range: 'bytes=0-8' } });
      assert.equal(res206.status, 206);
      assert.ok(res206.headers.get('content-security-policy')?.includes("connect-src 'none'"));
      assert.equal(res206.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(await res206.text(), 'col1,col2');

      // Reusing tmpA's HMAC signature to read fileB in another directory -> 403
      const escapedUrl = new URL(signed.url);
      escapedUrl.searchParams.set('file', fileB);
      const escaped = await fetch(escapedUrl);
      assert.equal(escaped.status, 403);

      // Tampering signature -> 401
      const badSigUrl = new URL(signed.url);
      badSigUrl.searchParams.set('sig', '0'.repeat(64));
      const badSig = await fetch(badSigUrl);
      assert.equal(badSig.status, 401);

      // Expired TTL -> 401
      const expired = gw.signFileUrl(fileA, -1000);
      const expiredRes = await fetch(expired.url);
      assert.equal(expiredRes.status, 401);
    } finally {
      await gw.stop();
      fs.rmSync(tmpA, { recursive: true, force: true });
      fs.rmSync(tmpB, { recursive: true, force: true });
    }
  });
});
