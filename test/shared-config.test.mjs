import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CHANNEL_IDS,
  DEFAULT_CONFIG,
  maskEmail,
  normalizeConfig,
  redactSecrets,
  resolveActiveChannels,
} from '../packages/shared/dist/index.js';

describe('shared/config: normalizeConfig', () => {
  it('returns base config when raw input is undefined or non-object', () => {
    assert.deepEqual(normalizeConfig(undefined), DEFAULT_CONFIG);
    assert.deepEqual(normalizeConfig(null), DEFAULT_CONFIG);
    assert.deepEqual(normalizeConfig('invalid'), DEFAULT_CONFIG);
  });

  it('validates enums and falls back to base on invalid values', () => {
    const cfg = normalizeConfig({
      theme: 'crystal',
      accent: 'iris',
      visualBudget: 'focus',
      language: 'zh-CN',
      hud: { style: 'vial' },
      translator: { mode: 'llm' },
      proxy: { mode: 'manual' },
      omni: { linkTarget: 'external' },
    });
    assert.equal(cfg.theme, 'crystal');
    assert.equal(cfg.accent, 'iris');
    assert.equal(cfg.visualBudget, 'focus');
    assert.equal(cfg.language, 'zh-CN');
    assert.equal(cfg.hud.style, 'vial');
    assert.equal(cfg.translator.mode, 'llm');
    assert.equal(cfg.proxy.mode, 'manual');
    assert.equal(cfg.omni.linkTarget, 'external');

    const fallback = normalizeConfig(
      {
        theme: 'neon-pink',
        accent: 'rainbow',
        visualBudget: 'ultra',
        language: 'fr',
        hud: { style: 'unknown' },
        translator: { mode: 'magic' },
        proxy: { mode: 'socks5' },
        omni: { linkTarget: 'popup' },
      },
      cfg,
    );
    assert.equal(fallback.theme, 'crystal');
    assert.equal(fallback.accent, 'iris');
    assert.equal(fallback.visualBudget, 'focus');
    assert.equal(fallback.language, 'zh-CN');
    assert.equal(fallback.hud.style, 'vial');
    assert.equal(fallback.translator.mode, 'llm');
    assert.equal(fallback.proxy.mode, 'manual');
    assert.equal(fallback.omni.linkTarget, 'external');
  });

  it('clamps numeric bounds and ignores non-finite values', () => {
    const high = normalizeConfig({
      workbench: { codeFoldMinLines: 9999 },
      optics: { wallpaperOpacity: 2.5 },
    });
    assert.equal(high.workbench.codeFoldMinLines, 400);
    assert.equal(high.optics.wallpaperOpacity, 0.85);

    const low = normalizeConfig({
      workbench: { codeFoldMinLines: 2.4 },
      optics: { wallpaperOpacity: -1 },
    });
    assert.equal(low.workbench.codeFoldMinLines, 16);
    assert.equal(low.optics.wallpaperOpacity, 0.05);

    const nonFinite = normalizeConfig({
      workbench: { codeFoldMinLines: Number.NaN },
      optics: { wallpaperOpacity: Number.POSITIVE_INFINITY },
    });
    assert.equal(nonFinite.workbench.codeFoldMinLines, DEFAULT_CONFIG.workbench.codeFoldMinLines);
    assert.equal(nonFinite.optics.wallpaperOpacity, DEFAULT_CONFIG.optics.wallpaperOpacity);
  });

  it('trims and truncates string fields to safe lengths', () => {
    const cfg = normalizeConfig({
      translator: {
        endpoint: `  https://example.com/${'a'.repeat(600)}  `,
        model: `  ${'m'.repeat(200)}  `,
      },
      proxy: {
        manualUrl: `  http://127.0.0.1:7890/${'p'.repeat(600)}  `,
      },
      optics: {
        wallpaperPath: 'x'.repeat(1500),
      },
    });
    assert.equal(cfg.translator.endpoint.length, 512);
    assert.ok(!cfg.translator.endpoint.startsWith(' '));
    assert.equal(cfg.translator.model.length, 128);
    assert.equal(cfg.proxy.manualUrl.length, 512);
    assert.equal(cfg.optics.wallpaperPath.length, 1024);
  });
});

describe('shared/config: resolveActiveChannels', () => {
  it('enables core and default feature channels while keeping on-demand channels unloaded', () => {
    const channels = resolveActiveChannels(DEFAULT_CONFIG);
    assert.ok(channels.includes('ch01-core'));
    assert.ok(channels.includes('ch02-hud'));
    assert.ok(channels.includes('ch03-i18n'));
    assert.ok(channels.includes('ch04-workbench'));
    assert.ok(channels.includes('ch06-omni'));
    assert.ok(channels.includes('ch07-inline-diff'));
    assert.ok(channels.includes('ch09-optics-picker'));

    assert.ok(!channels.includes('ch05-translator'));
    assert.ok(!channels.includes('ch08-chat-mode'));
    assert.ok(!channels.includes('ch11-optics-wallpaper'));
    assert.ok(!channels.includes('ch12-settings'));
  });

  it('gates optional feature channels by config flags', () => {
    const cfg = normalizeConfig({
      language: 'en',
      hud: { enabled: false },
      workbench: { enabled: false },
      translator: { mode: 'machine' },
      omni: { enabled: false, inlineDiff: true },
      chatMode: { enabled: true },
    });
    const channels = resolveActiveChannels(cfg);
    assert.ok(channels.includes('ch01-core'));
    assert.ok(channels.includes('ch05-translator'));
    assert.ok(channels.includes('ch08-chat-mode'));
    assert.ok(!channels.includes('ch02-hud'));
    assert.ok(!channels.includes('ch03-i18n'), 'i18n channel should be unloaded when language is en');
    assert.ok(!channels.includes('ch04-workbench'));
    assert.ok(!channels.includes('ch06-omni'));
    assert.ok(!channels.includes('ch07-inline-diff'), 'inline-diff requires omni.enabled');
  });

  it('gates optical channels by visualBudget, config, and UI demand', () => {
    const withWallpaper = normalizeConfig({
      optics: { picker3d: true, wallpaper: true, wallpaperPath: '/tmp/bg.mp4' },
    });
    const active = resolveActiveChannels(withWallpaper, {
      modelMenuOpen: true,
      settingsOpen: true,
    });
    assert.ok(active.includes('ch09-optics-picker'));
    assert.ok(active.includes('ch11-optics-wallpaper'));
    assert.ok(active.includes('ch12-settings'));

    const silent = normalizeConfig({ visualBudget: 'silent-eco' }, withWallpaper);
    const silentActive = resolveActiveChannels(silent, {
      modelMenuOpen: true,
      settingsOpen: true,
    });
    assert.ok(!silentActive.includes('ch09-optics-picker'));
    assert.ok(!silentActive.includes('ch11-optics-wallpaper'));
    assert.ok(silentActive.includes('ch12-settings'));

    assert.equal(CHANNEL_IDS.length, 11);
  });
});

describe('shared/security: redactSecrets & maskEmail', () => {
  it('redacts API keys, OAuth tokens, Bearer headers, and JSON authToken fields', () => {
    const raw = [
      'Authorization: Bearer secret_token_1234567890',
      'key=sk-abcdefghijklmno',
      'oauth=ya29.a0AfH6SMBx1234567890abcdef',
      '{"authToken": "deadbeefcafebabe"}',
    ].join(' ');

    const scrubbed = redactSecrets(raw);
    assert.ok(!scrubbed.includes('secret_token_1234567890'));
    assert.ok(!scrubbed.includes('sk-abcdefghijklmno'));
    assert.ok(!scrubbed.includes('ya29.a0AfH6SMBx1234567890abcdef'));
    assert.ok(!scrubbed.includes('deadbeefcafebabe'));
    assert.ok(scrubbed.includes('***REDACTED***'));
  });

  it('masks email local parts while preserving domain and handles malformed values', () => {
    assert.equal(maskEmail('alice@example.com'), 'a•••@example.com');
    assert.equal(maskEmail('not-an-email'), '•••');
    assert.equal(maskEmail('@missing-local.com'), '•••');
  });
});
