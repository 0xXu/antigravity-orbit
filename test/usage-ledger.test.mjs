import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  UsageLedger,
  calculateUsageCost,
  decodeWireFields,
  foldModelFamily,
  projectBytesField,
  projectStringField,
  projectUintField,
} from '../packages/core/dist/main.js';

describe('core/ledger/protobuf: wire decoder and field projectors', () => {
  it('decodes varint (0), fixed64 (1), length-delimited (2), and fixed32 (5) fields', () => {
    const textBytes = new TextEncoder().encode('gemini');
    const fixed64 = new Uint8Array(8);
    new DataView(fixed64.buffer).setBigUint64(0, 123_456_789n, true);
    const fixed32 = new Uint8Array(4);
    new DataView(fixed32.buffer).setUint32(0, 42_000, true);

    // field 1 (wire 0 -> 0x08): 150 (0x96 0x01)
    // field 2 (wire 2 -> 0x12): "gemini"
    // field 3 (wire 1 -> 0x19): fixed64 = 123_456_789
    // field 4 (wire 5 -> 0x25): fixed32 = 42_000
    const buf = new Uint8Array([
      0x08, 0x96, 0x01,
      0x12, textBytes.length, ...textBytes,
      0x19, ...fixed64,
      0x25, ...fixed32,
    ]);

    const fields = decodeWireFields(buf);
    assert.equal(fields.length, 4);
    assert.equal(projectUintField(fields, 1), 150);
    assert.equal(projectStringField(fields, 2), 'gemini');
    assert.deepEqual(projectBytesField(fields, 2), textBytes);
    assert.equal(projectUintField(fields, 3), 123_456_789);
    assert.equal(projectUintField(fields, 4), 42_000);

    // Missing field projections return safe defaults
    assert.equal(projectUintField(fields, 99), 0);
    assert.equal(projectStringField(fields, 99), '');
    assert.equal(projectBytesField(fields, 99), null);
  });

  it('fails closed without throwing on truncated, malformed, or unsupported wire data', () => {
    // Truncated length-delimited field
    assert.deepEqual(decodeWireFields(new Uint8Array([0x12, 0x20, 0x41, 0x42])), []);
    // Truncated varint
    assert.deepEqual(decodeWireFields(new Uint8Array([0x08, 0x80])), []);
    // Truncated fixed64 / fixed32
    assert.deepEqual(decodeWireFields(new Uint8Array([0x19, 0x01, 0x02])), []);
    assert.deepEqual(decodeWireFields(new Uint8Array([0x25, 0x01, 0x02])), []);
    // Unsupported wire type 3 (start group)
    assert.deepEqual(decodeWireFields(new Uint8Array([0x0b, 0x00])), []);
    // Field number 0
    assert.deepEqual(decodeWireFields(new Uint8Array([0x00, 0x01])), []);
  });
});

describe('core/ledger/pricing: model folding and tiered cost calculation', () => {
  it('folds chained thinking suffixes case-insensitively and handles blank input', () => {
    assert.equal(foldModelFamily('gemini-2.5-pro-high-tiered'), 'gemini-2.5-pro');
    assert.equal(foldModelFamily('Claude-Sonnet-4-Max-Thinking'), 'claude-sonnet-4');
    assert.equal(foldModelFamily('   '), 'unknown');
  });

  it('applies >200K tiered rates and computes positive cache savings', () => {
    const tokens = {
      inputUncached: 100_000,
      cacheRead: 900_000,
      cacheWrite: 0,
      outputThinking: 5_000,
      outputReply: 5_000,
    };
    const lowTier = calculateUsageCost('gemini-2.5-pro-medium', tokens, 150_000);
    const highTier = calculateUsageCost('gemini-2.5-pro-high', tokens, 250_000);

    assert.equal(lowTier.matchedModel, 'gemini-2.5-pro');
    assert.equal(highTier.matchedModel, 'gemini-2.5-pro');
    assert.ok(highTier.costUsd > lowTier.costUsd, 'Context >200K must use higher tier pricing');
    assert.ok(lowTier.cacheSavedUsd > 0, 'Cache reads must compute positive savings');
  });

  it('returns zeroed breakdown for unknown models', () => {
    const result = calculateUsageCost(
      'custom-unlisted-model',
      { inputUncached: 1000, cacheRead: 0, cacheWrite: 0, outputThinking: 0, outputReply: 500 },
      1500,
    );
    assert.deepEqual(result, { costUsd: 0, cacheSavedUsd: 0, matchedModel: null });
  });
});

describe('core/ledger/store: UsageLedger', () => {
  it('deduplicates BTW fork-clones and supports orthogonal environment, account, time, and folding filters', () => {
    const ledger = new UsageLedger(':memory:');
    try {
      const t1 = Date.parse('2026-11-25T10:00:00Z');
      const t2 = Date.parse('2026-11-26T10:00:00Z');
      const baseTokens = {
        inputUncached: 10_000,
        cacheRead: 90_000,
        cacheWrite: 5_000,
        outputThinking: 2_000,
        outputReply: 3_000,
      };

      const rec1 = {
        trajectoryId: 'traj-1',
        executionId: 'exec-1',
        accountEmail: 'alice@example.com',
        environment: 'local',
        rawModel: 'gemini-2.5-pro-high',
        timestampMs: t1,
        contextTokens: 120_000,
        tokens: baseTokens,
        durationMs: 4200,
      };

      assert.equal(ledger.record(rec1), true);
      assert.equal(ledger.record(rec1), false, 'Duplicate (trajectoryId, executionId) must be ignored');

      assert.equal(
        ledger.record({
          ...rec1,
          trajectoryId: 'traj-ssh-1',
          executionId: 'exec-2',
          accountEmail: 'bob@example.com',
          environment: 'ssh',
          sshHost: 'gpu-box-1',
          rawModel: 'gemini-2.5-pro-low',
          timestampMs: t2,
        }),
        true,
      );

      // Folded summary across all records
      const all = ledger.summarize({ foldThinkingLevels: true });
      assert.equal(all.totalRequests, 2);
      assert.equal(all.models.length, 1);
      assert.equal(all.models[0].model, 'gemini-2.5-pro');
      assert.equal(all.localTokens, 110_000);
      assert.equal(all.sshTokens, 110_000);
      assert.equal(all.cacheHitRate, 0.9);
      assert.deepEqual(
        all.heatmap.map((d) => d.date),
        ['2026-11-25', '2026-11-26'],
      );

      // Unfolded summary separates raw thinking levels
      const unfolded = ledger.summarize({ foldThinkingLevels: false });
      assert.equal(unfolded.models.length, 2);

      // Orthogonal filters: environment, accountEmail, sinceMs
      const sshOnly = ledger.summarize({ environment: 'ssh' });
      assert.equal(sshOnly.totalRequests, 1);
      assert.equal(sshOnly.localTokens, 0);
      assert.equal(sshOnly.sshTokens, 110_000);

      const aliceOnly = ledger.summarize({ accountEmail: 'alice@example.com' });
      assert.equal(aliceOnly.totalRequests, 1);
      assert.equal(aliceOnly.localTokens, 110_000);

      const recentOnly = ledger.summarize({ sinceMs: t2 });
      assert.equal(recentOnly.totalRequests, 1);
      assert.equal(recentOnly.heatmap[0].date, '2026-11-26');
    } finally {
      ledger.close();
    }
  });
});
