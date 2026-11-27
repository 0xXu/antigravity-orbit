import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { fuseAccountQuota, fuseModelQuota, rankStandbyAccounts } from '../packages/core/dist/main.js';

describe('core/quota: fuseModelQuota, fuseAccountQuota, and rankStandbyAccounts', () => {
  const now = Date.parse('2026-11-26T12:00:00Z');

  it('computes effective = min(own, fresh family windows), flags expired windows stale, and clamps bounds', () => {
    const fused = fuseModelQuota(
      {
        modelId: 'gemini-2.5-pro',
        family: 'gemini',
        ownRemainingFraction: 1.4, // clamped to 1.0
        familyWindows: [
          {
            kind: '5h',
            remainingFraction: 0.35,
            resetAt: '2026-11-26T15:00:00Z',
            observedAt: '2026-11-26T12:00:00Z',
            stale: false,
          },
          {
            kind: 'weekly',
            remainingFraction: 0.1,
            resetAt: '2026-11-26T11:00:00Z', // already reset -> stale
            observedAt: '2026-11-25T12:00:00Z',
            stale: false,
          },
        ],
      },
      now,
    );

    assert.equal(fused.ownRemainingFraction, 1);
    assert.equal(fused.effectiveRemainingFraction, 0.35);
    assert.equal(fused.windows[0].stale, false);
    assert.equal(fused.windows[1].stale, true);
  });

  it('preserves null when all quota sources are unknown instead of fabricating 100%', () => {
    const unknown = fuseModelQuota(
      {
        modelId: 'unknown-pool',
        family: 'argon',
        ownRemainingFraction: null,
        familyWindows: [
          {
            kind: '5h',
            remainingFraction: null,
            resetAt: null,
            observedAt: '2026-11-26T12:00:00Z',
            stale: false,
          },
        ],
      },
      now,
    );

    assert.equal(unknown.ownRemainingFraction, null);
    assert.equal(unknown.effectiveRemainingFraction, null);
  });

  it('scores accounts by average known effective fraction and ranks inactive standby accounts descending', () => {
    const activeAcct = fuseAccountQuota(
      {
        accountEmail: 'active@example.com',
        active: true,
        environment: 'local',
        updatedAt: '2026-11-26T12:00:00Z',
        models: [
          { modelId: 'gemini-2.5-pro', family: 'gemini', ownRemainingFraction: 0.99, familyWindows: [] },
        ],
      },
      now,
    );

    const standbyHigh = fuseAccountQuota(
      {
        accountEmail: 'backup-high@example.com',
        active: false,
        environment: 'local',
        updatedAt: '2026-11-26T12:00:00Z',
        models: [
          { modelId: 'gemini-2.5-pro', family: 'gemini', ownRemainingFraction: 0.92, familyWindows: [] },
          { modelId: 'unknown-pool', family: 'argon', ownRemainingFraction: null, familyWindows: [] },
        ],
      },
      now,
    );

    const standbyLow = fuseAccountQuota(
      {
        accountEmail: 'backup-low@example.com',
        active: false,
        environment: 'local',
        updatedAt: '2026-11-26T12:00:00Z',
        models: [
          { modelId: 'gemini-2.5-pro', family: 'gemini', ownRemainingFraction: 0.25, familyWindows: [] },
        ],
      },
      now,
    );

    const standbyUnknown = fuseAccountQuota(
      {
        accountEmail: 'backup-unknown@example.com',
        active: false,
        environment: 'local',
        updatedAt: '2026-11-26T12:00:00Z',
        models: [
          { modelId: 'unknown-pool', family: 'argon', ownRemainingFraction: null, familyWindows: [] },
        ],
      },
      now,
    );

    assert.equal(standbyHigh.recommendedScore, 92);
    assert.equal(standbyLow.recommendedScore, 25);
    assert.equal(standbyUnknown.recommendedScore, 0);

    const ranked = rankStandbyAccounts([activeAcct, standbyUnknown, standbyLow, standbyHigh]);
    assert.deepEqual(
      ranked.map((r) => r.accountEmail),
      ['backup-high@example.com', 'backup-low@example.com', 'backup-unknown@example.com'],
    );
  });
});
