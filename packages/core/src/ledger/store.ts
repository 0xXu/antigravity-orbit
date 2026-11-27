import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  HeatmapDay,
  ModelUsageAggregate,
  UsageFilter,
  UsageRecordInput,
  UsageSummary,
} from '@antigravity-orbit/shared';
import { ensurePrivateDir } from '../platform/paths.js';
import { calculateUsageCost, foldModelFamily } from './pricing.js';

interface LedgerRow {
  raw_model: string;
  folded_model: string;
  environment: string;
  input_uncached: number;
  cache_read: number;
  cache_write: number;
  output_thinking: number;
  output_reply: number;
  cost_usd: number;
  cache_saved_usd: number;
  day_key: string;
}

export class UsageLedger {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      ensurePrivateDir(path.dirname(dbPath));
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS usage_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trajectory_id TEXT NOT NULL,
        execution_id TEXT NOT NULL,
        account_email TEXT NOT NULL,
        environment TEXT NOT NULL CHECK(environment IN ('local', 'ssh')),
        ssh_host TEXT NOT NULL DEFAULT '',
        raw_model TEXT NOT NULL,
        folded_model TEXT NOT NULL,
        timestamp_ms INTEGER NOT NULL,
        day_key TEXT NOT NULL,
        context_tokens INTEGER NOT NULL,
        input_uncached INTEGER NOT NULL,
        cache_read INTEGER NOT NULL,
        cache_write INTEGER NOT NULL,
        output_thinking INTEGER NOT NULL,
        output_reply INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        ttft_ms INTEGER,
        cost_usd REAL NOT NULL,
        cache_saved_usd REAL NOT NULL,
        UNIQUE(trajectory_id, execution_id)
      );
      CREATE INDEX IF NOT EXISTS idx_usage_env_acct_ts
        ON usage_events(environment, account_email, timestamp_ms);
      CREATE INDEX IF NOT EXISTS idx_usage_day
        ON usage_events(day_key);
    `);
  }

  /**
   * Inserts a normalized usage record. Fork-clones (e.g. BTW side-question cloned prefixes)
   * sharing the same (trajectory_id, execution_id) are automatically deduplicated via INSERT OR IGNORE.
   */
  record(input: UsageRecordInput): boolean {
    const folded = foldModelFamily(input.rawModel);
    const { costUsd, cacheSavedUsd } = calculateUsageCost(
      input.rawModel,
      input.tokens,
      input.contextTokens,
    );
    const dayKey = new Date(input.timestampMs).toISOString().slice(0, 10);

    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO usage_events (
        trajectory_id, execution_id, account_email, environment, ssh_host,
        raw_model, folded_model, timestamp_ms, day_key, context_tokens,
        input_uncached, cache_read, cache_write, output_thinking, output_reply,
        duration_ms, ttft_ms, cost_usd, cache_saved_usd
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const info = stmt.run(
      input.trajectoryId,
      input.executionId,
      input.accountEmail,
      input.environment,
      input.sshHost ?? '',
      input.rawModel,
      folded,
      input.timestampMs,
      dayKey,
      input.contextTokens,
      input.tokens.inputUncached,
      input.tokens.cacheRead,
      input.tokens.cacheWrite,
      input.tokens.outputThinking,
      input.tokens.outputReply,
      input.durationMs,
      input.ttftMs ?? null,
      costUsd,
      cacheSavedUsd,
    );

    return Number(info.changes) > 0;
  }

  summarize(filter: UsageFilter = {}): UsageSummary {
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (filter.environment && filter.environment !== 'all') {
      clauses.push('environment = ?');
      params.push(filter.environment);
    }
    if (filter.accountEmail && filter.accountEmail !== 'all') {
      clauses.push('account_email = ?');
      params.push(filter.accountEmail);
    }
    if (typeof filter.sinceMs === 'number') {
      clauses.push('timestamp_ms >= ?');
      params.push(filter.sinceMs);
    }

    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db
      .prepare(
        `SELECT raw_model, folded_model, environment,
                input_uncached, cache_read, cache_write, output_thinking, output_reply,
                cost_usd, cache_saved_usd, day_key
         FROM usage_events ${whereSql}`,
      )
      .all(...params) as unknown as LedgerRow[];

    const fold = filter.foldThinkingLevels !== false;
    const modelMap = new Map<
      string,
      {
        requests: number;
        totalTokens: number;
        inputUncached: number;
        cacheRead: number;
        cacheWrite: number;
        outputTokens: number;
        estimatedCostUsd: number;
        cacheSavedUsd: number;
      }
    >();
    const dayMap = new Map<string, { tokens: number; requests: number; costUsd: number }>();

    let totalRequests = 0;
    let totalTokens = 0;
    let totalInputAll = 0;
    let totalCacheRead = 0;
    let estimatedCostUsd = 0;
    let cacheSavedUsd = 0;
    let localTokens = 0;
    let sshTokens = 0;

    for (const row of rows) {
      const outTokens = row.output_thinking + row.output_reply;
      const rowTotal = row.input_uncached + row.cache_read + row.cache_write + outTokens;

      totalRequests += 1;
      totalTokens += rowTotal;
      totalInputAll += row.input_uncached + row.cache_read;
      totalCacheRead += row.cache_read;
      estimatedCostUsd += row.cost_usd;
      cacheSavedUsd += row.cache_saved_usd;

      if (row.environment === 'ssh') sshTokens += rowTotal;
      else localTokens += rowTotal;

      const modelKey = fold ? row.folded_model : row.raw_model;
      const m = modelMap.get(modelKey) ?? {
        requests: 0,
        totalTokens: 0,
        inputUncached: 0,
        cacheRead: 0,
        cacheWrite: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
        cacheSavedUsd: 0,
      };
      m.requests += 1;
      m.totalTokens += rowTotal;
      m.inputUncached += row.input_uncached;
      m.cacheRead += row.cache_read;
      m.cacheWrite += row.cache_write;
      m.outputTokens += outTokens;
      m.estimatedCostUsd += row.cost_usd;
      m.cacheSavedUsd += row.cache_saved_usd;
      modelMap.set(modelKey, m);

      const d = dayMap.get(row.day_key) ?? { tokens: 0, requests: 0, costUsd: 0 };
      d.tokens += rowTotal;
      d.requests += 1;
      d.costUsd += row.cost_usd;
      dayMap.set(row.day_key, d);
    }

    const models: ModelUsageAggregate[] = Array.from(modelMap.entries())
      .map(([model, v]) => ({
        model,
        requests: v.requests,
        totalTokens: v.totalTokens,
        inputUncached: v.inputUncached,
        cacheRead: v.cacheRead,
        cacheWrite: v.cacheWrite,
        outputTokens: v.outputTokens,
        estimatedCostUsd: Number(v.estimatedCostUsd.toFixed(4)),
        cacheSavedUsd: Number(v.cacheSavedUsd.toFixed(4)),
      }))
      .sort((a, b) => b.totalTokens - a.totalTokens);

    const heatmap: HeatmapDay[] = Array.from(dayMap.entries())
      .map(([date, v]) => ({
        date,
        tokens: v.tokens,
        requests: v.requests,
        costUsd: Number(v.costUsd.toFixed(4)),
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    return {
      totalRequests,
      totalTokens,
      cacheHitRate: totalInputAll > 0 ? Number((totalCacheRead / totalInputAll).toFixed(4)) : 0,
      estimatedCostUsd: Number(estimatedCostUsd.toFixed(4)),
      cacheSavedUsd: Number(cacheSavedUsd.toFixed(4)),
      localTokens,
      sshTokens,
      models,
      heatmap,
    };
  }

  close(): void {
    this.db.close();
  }
}
