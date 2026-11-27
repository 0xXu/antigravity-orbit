import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  UsageLedger,
  buildQuotaAndHudFromProbe,
  formatResetCountdown,
  inferModelFamily,
  inferQuotaStatus,
  isAntigravityMainProcess,
} from '../packages/core/dist/main.js';

describe('core/telemetry: collector normalization and UsageLedger ingestion', () => {
  it('formats reset countdowns and infers quota status & model families accurately', () => {
    const now = Date.parse('2026-11-26T12:00:00Z');
    assert.equal(formatResetCountdown('2026-11-26T12:00:30Z', now), '<1m');
    assert.equal(formatResetCountdown('2026-11-26T12:45:00Z', now), '45m');
    assert.equal(formatResetCountdown('2026-11-26T15:30:00Z', now), '3h 30m');
    assert.equal(formatResetCountdown('2026-11-28T16:00:00Z', now), '2d 4h');
    assert.equal(formatResetCountdown(null, now), null);

    assert.equal(inferQuotaStatus(0.8), 'abundant');
    assert.equal(inferQuotaStatus(0.35), 'moderate');
    assert.equal(inferQuotaStatus(0.1), 'low');
    assert.equal(inferQuotaStatus(null), 'unknown');

    assert.equal(inferModelFamily('Gemini 4 Neon (High)'), 'gemini');
    assert.equal(inferModelFamily('Claude and GPT models'), 'claude');
    assert.equal(inferModelFamily('Gemini 4 Argon'), 'argon');
  });

  it('transforms a live Antigravity probe into fused quotas, HUD metrics, and deduplicated SQLite ledger rows', () => {
    const now = Date.parse('2026-11-26T12:00:00Z');
    const ledger = new UsageLedger(':memory:');
    try {
      const probe = {
        email: 'dev@example.com',
        name: 'Dev User',
        activeCid: '74b3ede6-5cbb-4d23-a687-aa5ee776bb1c',
        activity: 'thinking',
        activeSubagents: 2,
        activeSubagentNames: ['Researcher', 'Reviewer'],
        contextUsed: 420_000,
        contextLimit: 512_000,
        contextEstimated: false,
        compactionCount: 1,
        modelConfigs: [
          {
            label: 'Gemini 4 Neon (High)',
            modelId: 'gemini-4-neon-high',
            remainingFraction: 0.93,
            resetIso: '2026-11-26T17:00:00Z',
          },
        ],
        quotaGroups: [
          {
            displayName: 'Gemini Models',
            buckets: [
              { displayName: 'Five Hour Limit', window: '5h', remainingFraction: 0.97, resetIso: '2026-11-26T17:00:00Z' },
              { displayName: 'Weekly Limit', window: 'weekly', remainingFraction: 0.78, resetIso: '2026-12-03T12:00:00Z' },
            ],
          },
          {
            displayName: 'Claude and GPT models',
            buckets: [
              { displayName: 'Five Hour Limit', window: '5h', remainingFraction: 1, resetIso: null },
              { displayName: 'Weekly Limit', window: 'weekly', remainingFraction: 1, resetIso: null },
            ],
          },
        ],
        generatorUsages: [
          {
            index: 0,
            model: 'gemini-4-neon-high',
            inputUncached: 10_000,
            cacheRead: 90_000,
            cacheWrite: 0,
            outputThinking: 500,
            outputReply: 500,
            ttftMs: 420,
            durationMs: 10_000,
            timestampMs: now - 5_000,
            contextTokens: 100_000,
          },
        ],
      };

      const { accountQuota, hud } = buildQuotaAndHudFromProbe(probe, {
        environment: 'local',
        ledger,
        nowMs: now,
      });

      assert.ok(accountQuota);
      assert.equal(accountQuota.accountEmail, 'dev@example.com');
      // Effective fraction is min(own=0.93, 5h=0.97, weekly=0.78) = 0.78
      assert.equal(accountQuota.models[0].effectiveRemainingFraction, 0.78);
      assert.equal(accountQuota.recommendedScore, 78);

      assert.equal(hud.turns, 1);
      assert.equal(hud.avgTps, 100);
      assert.equal(hud.ttftMs, 420);
      assert.equal(hud.cacheHitRate, 0.9);
      assert.equal(hud.contextUsed, 420_000);
      assert.equal(hud.compactionCount, 1);
      assert.equal(hud.activeSubagents, 2);
      assert.equal(hud.quotas?.length, 2);
      assert.equal(hud.quotas?.[0].window5hResetText, '5h 0m');
      assert.equal(hud.quotas?.[0].weeklyResetText, '7d 0h');

      // Re-processing the same probe deduplicates SQLite ledger rows
      buildQuotaAndHudFromProbe(probe, { environment: 'local', ledger, nowMs: now });
      const summary = ledger.summarize({ foldThinkingLevels: true });
      assert.equal(summary.totalRequests, 1);
      assert.equal(summary.models[0].model, 'gemini-4-neon');
      assert.ok(summary.estimatedCostUsd > 0);
    } finally {
      ledger.close();
    }
  });
});

describe('core/platform: Antigravity main process classification', () => {
  it('excludes renderer/gpu/language_server helpers and identifies main process args', () => {
    assert.equal(isAntigravityMainProcess('/Applications/Antigravity.app/Contents/Frameworks/Helper --type=renderer'), false);
    assert.equal(isAntigravityMainProcess('/Applications/Antigravity.app/Contents/Resources/bin/language_server --standalone'), false);
    if (process.platform === 'darwin') {
      assert.equal(isAntigravityMainProcess('/Applications/Antigravity.app/Contents/MacOS/Antigravity'), true);
    }
  });
});
