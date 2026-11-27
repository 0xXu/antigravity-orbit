import type {
  AccountQuotaSummary,
  HudMetricsSnapshot,
  HudProviderQuota,
  QuotaWindowSnapshot,
  UsageRecordInput,
} from '@antigravity-orbit/shared';
import type { CdpClientLike } from '../cdp/client.js';
import { fuseAccountQuota } from '../quota/fusion.js';
import type { UsageLedger } from '../ledger/store.js';

interface ProtoTimestamp {
  readonly seconds?: number | string;
  readonly nanos?: number;
}

interface RawRendererQuotaBucket {
  readonly displayName?: string;
  readonly window?: string;
  readonly remainingFraction?: number | null;
  readonly resetIso?: string | null;
}

interface RawRendererQuotaGroup {
  readonly displayName?: string;
  readonly buckets?: readonly RawRendererQuotaBucket[];
}

interface RawRendererModelConfig {
  readonly label?: string;
  readonly modelId?: string;
  readonly remainingFraction?: number | null;
  readonly resetIso?: string | null;
}

interface RawGeneratorUsage {
  readonly index: number;
  readonly model: string;
  readonly inputUncached: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly outputThinking: number;
  readonly outputReply: number;
  readonly ttftMs: number | null;
  readonly durationMs: number;
  readonly timestampMs: number;
  readonly contextTokens: number;
}

export interface LiveTelemetryProbeResult {
  readonly email: string | null;
  readonly name: string | null;
  readonly activeCid: string | null;
  readonly activity: 'idle' | 'thinking' | 'tool';
  readonly activeSubagents: number;
  readonly activeSubagentNames: readonly string[];
  readonly contextUsed: number;
  readonly contextLimit: number;
  readonly contextEstimated: boolean;
  readonly compactionCount: number;
  readonly modelConfigs: readonly RawRendererModelConfig[];
  readonly quotaGroups: readonly RawRendererQuotaGroup[];
  readonly generatorUsages: readonly RawGeneratorUsage[];
}

export function formatResetCountdown(resetIso: string | null, nowMs = Date.now()): string | null {
  if (!resetIso) return null;
  const targetMs = Date.parse(resetIso);
  if (!Number.isFinite(targetMs)) return null;
  const diffSec = Math.max(0, Math.floor((targetMs - nowMs) / 1000));
  if (diffSec < 60) return '<1m';
  const days = Math.floor(diffSec / 86400);
  const hours = Math.floor((diffSec % 86400) / 3600);
  const mins = Math.floor((diffSec % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

export function inferQuotaStatus(frac: number | null): HudProviderQuota['status'] {
  if (frac === null || !Number.isFinite(frac)) return 'unknown';
  if (frac >= 0.5) return 'abundant';
  if (frac >= 0.2) return 'moderate';
  return 'low';
}

export function inferModelFamily(text: string): string {
  const lower = text.toLowerCase();
  if (lower.includes('argon')) return 'argon';
  if (lower.includes('claude') || lower.includes('sonnet') || lower.includes('opus') || lower.includes('gpt')) {
    return 'claude';
  }
  return 'gemini';
}

/**
 * Builds a strictly read-only main-world expression that inspects Antigravity's
 * React Fiber LS client & AgentManager to extract numeric telemetry and quotas.
 * Strips all message text, prompts, and tool payloads inside the renderer.
 */
export function buildLiveTelemetryProbeExpression(): string {
  return `(async () => {
    const tsIso = (v) => {
      if (!v) return null;
      if (typeof v === 'string') { const ms = Date.parse(v); return Number.isFinite(ms) ? new Date(ms).toISOString() : null; }
      if (typeof v === 'number' || typeof v === 'bigint') {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) return null;
        return new Date(n > 1e11 ? n : n * 1000).toISOString();
      }
      if (typeof v === 'object' && v.seconds !== undefined) {
        const sec = Number(v.seconds);
        const nanos = Number(v.nanos || 0);
        if (!Number.isFinite(sec) || sec <= 0) return null;
        return new Date(sec * 1000 + Math.floor(nanos / 1e6)).toISOString();
      }
      return null;
    };
    const durMs = (v) => {
      if (v === null || v === undefined) return null;
      if (typeof v === 'number' || typeof v === 'bigint') {
        const n = Number(v);
        return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
      }
      if (typeof v === 'string') {
        const m = v.match(/^(\\d+(?:\\.\\d+)?)s$/);
        return m ? Math.round(Number(m[1]) * 1000) : null;
      }
      if (typeof v === 'object' && (v.seconds !== undefined || v.nanos !== undefined)) {
        const ms = Number(v.seconds || 0) * 1000 + Math.floor(Number(v.nanos || 0) / 1e6);
        return Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : null;
      }
      return null;
    };

    const root = document.getElementById('root') || document.body;
    if (!root) return null;
    const fk = Object.keys(root).find((k) => k.startsWith('__reactContainer$') || k.startsWith('__reactFiber$'));
    if (!fk || !root[fk]) return null;

    const q = [root[fk]];
    const seen = new Set();
    let ls = null;
    let agentMgr = null;
    let visited = 0;
    while (q.length && visited < 4000) {
      const f = q.shift();
      if (!f || seen.has(f)) continue;
      seen.add(f);
      visited += 1;
      const v = f.memoizedProps && f.memoizedProps.value;
      if (v && typeof v === 'object') {
        if (!ls && typeof v.getUserStatus === 'function' && typeof v.getCascadeTrajectory === 'function') ls = v;
        if (!agentMgr && typeof v.peek === 'function' && typeof v.getAgentStates === 'function') agentMgr = v;
        if (ls && agentMgr) break;
      }
      if (f.child) q.push(f.child);
      if (f.sibling) q.push(f.sibling);
    }

    const out = {
      email: null,
      name: null,
      activeCid: null,
      activity: 'idle',
      activeSubagents: 0,
      activeSubagentNames: [],
      contextUsed: 0,
      contextLimit: 512000,
      contextEstimated: true,
      compactionCount: 0,
      modelConfigs: [],
      quotaGroups: [],
      generatorUsages: [],
    };

    const mCid = location.pathname.match(new RegExp('/c/([0-9a-f-]{36})', 'i'));
    if (mCid) out.activeCid = mCid[1].toLowerCase();

    if (document.querySelector('[data-testid="input-cancel-button"], [data-testid="stop-button"]')) {
      out.activity = 'thinking';
    }

    if (agentMgr) {
      try {
        const states = agentMgr.getAgentStates && agentMgr.getAgentStates();
        if (states && typeof states.forEach === 'function') {
          states.forEach((st, key) => {
            if (key !== out.activeCid && st && (st.isRunning || st.status === 'running')) {
              out.activeSubagents += 1;
              if (typeof st.role === 'string' && st.role) out.activeSubagentNames.push(st.role);
            }
          });
        }
        if (out.activeCid) {
          const entry = agentMgr.peek && agentMgr.peek(out.activeCid);
          const st = entry && entry.getState && entry.getState();
          const cw = st && st.contextWindowUsage;
          if (cw && typeof cw === 'object') {
            const used = Number(cw.estimatedTokensUsed);
            const max = Number(cw.maxContextTokens);
            if (Number.isFinite(used) && used >= 0) {
              out.contextUsed = Math.round(used);
              out.contextEstimated = Boolean(cw.estimatedAfterCompaction);
            }
            if (Number.isFinite(max) && max > 0) out.contextLimit = Math.round(max);
          }
          const comp = st && st.compactedAtStepIndices;
          if (Array.isArray(comp)) out.compactionCount = comp.length;
        }
      } catch {}
    }

    const modelLabelById = new Map();
    if (ls) {
      try {
        const us = await ls.getUserStatus({});
        const u = us && us.userStatus;
        if (u && typeof u === 'object') {
          if (typeof u.email === 'string') out.email = u.email;
          if (typeof u.name === 'string') out.name = u.name;
          const cfgs = (u.cascadeModelConfigData && u.cascadeModelConfigData.clientModelConfigs) || [];
          for (const c of cfgs) {
            const label = typeof c.label === 'string' ? c.label.trim() : '';
            const modelId = typeof c.modelId === 'string' ? c.modelId.trim() : '';
            const aliasVal = c.modelOrAlias && (c.modelOrAlias.choice ? c.modelOrAlias.choice.value : c.modelOrAlias.model);
            if (modelId && label) modelLabelById.set(modelId, label);
            if (aliasVal !== undefined && aliasVal !== null && label) modelLabelById.set(String(aliasVal), label);
            const rem = c.quotaInfo && typeof c.quotaInfo.remainingFraction === 'number' ? c.quotaInfo.remainingFraction : null;
            out.modelConfigs.push({
              label: label || modelId,
              modelId: modelId || label,
              remainingFraction: rem,
              resetIso: tsIso(c.quotaInfo && c.quotaInfo.resetTime),
            });
          }
        }
      } catch {}

      try {
        const qs = await ls.retrieveUserQuotaSummary({});
        const rootQ = (qs && qs.response) || qs || {};
        const groups = Array.isArray(rootQ.groups) ? rootQ.groups : [];
        for (const g of groups) {
          const buckets = [];
          for (const b of (Array.isArray(g.buckets) ? g.buckets : [])) {
            let rem = null;
            if (typeof b.remainingFraction === 'number') rem = b.remainingFraction;
            else if (b.remaining && b.remaining.case === 'remainingFraction' && typeof b.remaining.value === 'number') {
              rem = b.remaining.value;
            } else if (b.remaining && typeof b.remaining.remainingFraction === 'number') {
              rem = b.remaining.remainingFraction;
            }
            buckets.push({
              displayName: String(b.displayName || ''),
              window: String(b.window || ''),
              remainingFraction: rem,
              resetIso: tsIso(b.resetTime),
            });
          }
          out.quotaGroups.push({
            displayName: String(g.displayName || ''),
            buckets,
          });
        }
      } catch {}

      if (out.activeCid) {
        try {
          const trajRes = await ls.getCascadeTrajectory({ cascadeId: out.activeCid });
          const traj = trajRes && trajRes.trajectory;
          const gms = (traj && Array.isArray(traj.generatorMetadata)) ? traj.generatorMetadata : [];
          for (let i = 0; i < gms.length; i += 1) {
            const g = gms[i];
            const cm = g && (g.chatModel || (g.metadata && g.metadata.case === 'chatModel' ? g.metadata.value : null));
            const u = cm && cm.usage;
            if (!u) continue;
            const rawModel = String(cm.responseModel || cm.modelDisplayName || modelLabelById.get(String(cm.model || u.model || '')) || u.model || cm.model || 'unknown');
            const inputUncached = Math.max(0, Number(u.inputTokens || 0));
            const cacheRead = Math.max(0, Number(u.cacheReadTokens || 0));
            const cacheWrite = Math.max(0, Number(u.cacheWriteTokens || 0));
            const outTotal = Math.max(0, Number(u.outputTokens || 0));
            const outThink = Math.max(0, Number(u.thinkingOutputTokens || 0));
            const outReply = u.responseOutputTokens !== undefined
              ? Math.max(0, Number(u.responseOutputTokens || 0))
              : Math.max(0, outTotal - outThink);
            const csm = cm.chatStartMetadata;
            const createdIso = tsIso(csm && csm.createdAt);
            const tsMs = createdIso ? Date.parse(createdIso) : Date.now();
            const cwEst = Number(csm && csm.contextWindowMetadata && csm.contextWindowMetadata.estimatedTokensUsed);
            out.generatorUsages.push({
              index: i,
              model: rawModel,
              inputUncached,
              cacheRead,
              cacheWrite,
              outputThinking: outThink,
              outputReply: outReply,
              ttftMs: durMs(cm.timeToFirstToken),
              durationMs: durMs(cm.streamingDuration) ?? 0,
              timestampMs: Number.isFinite(tsMs) ? tsMs : Date.now(),
              contextTokens: Number.isFinite(cwEst) && cwEst > 0 ? Math.round(cwEst) : inputUncached + cacheRead,
            });
          }
        } catch {}
      }
    }

    return JSON.stringify(out, (_k, v) => (typeof v === 'bigint' ? Number(v) : v));
  })()`;
}

export function buildQuotaAndHudFromProbe(
  probe: LiveTelemetryProbeResult,
  opts: {
    environment: 'local' | 'ssh';
    sshHost?: string;
    ledger?: UsageLedger;
    nowMs?: number;
  },
): { accountQuota: AccountQuotaSummary | null; hud: HudMetricsSnapshot } {
  const nowMs = opts.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const email = probe.email || 'local@antigravity';

  // 1. Record generator turns into SQLite UsageLedger (automatically deduplicated)
  let totalInputAll = 0;
  let totalCacheRead = 0;
  let totalTokens = 0;
  let totalOutputTokens = 0;
  let totalStreamMs = 0;
  let lastTtftMs: number | null = null;
  let currentModel = 'Antigravity';

  for (const g of probe.generatorUsages) {
    const outTok = g.outputThinking + g.outputReply;
    const turnTok = g.inputUncached + g.cacheRead + g.cacheWrite + outTok;
    totalInputAll += g.inputUncached + g.cacheRead;
    totalCacheRead += g.cacheRead;
    totalTokens += turnTok;
    totalOutputTokens += outTok;
    totalStreamMs += g.durationMs;
    if (g.ttftMs !== null) lastTtftMs = g.ttftMs;
    if (g.model && g.model !== 'unknown') currentModel = g.model;

    if (opts.ledger && probe.activeCid) {
      const rec: UsageRecordInput = {
        trajectoryId: probe.activeCid,
        executionId: `gm-${g.index}`,
        accountEmail: email,
        environment: opts.environment,
        sshHost: opts.sshHost,
        rawModel: g.model,
        timestampMs: g.timestampMs,
        contextTokens: g.contextTokens,
        tokens: {
          inputUncached: g.inputUncached,
          cacheRead: g.cacheRead,
          cacheWrite: g.cacheWrite,
          outputThinking: g.outputThinking,
          outputReply: g.outputReply,
        },
        durationMs: g.durationMs,
        ttftMs: g.ttftMs ?? undefined,
      };
      opts.ledger.record(rec);
    }
  }

  // 2. Build family windows from retrieveUserQuotaSummary groups
  const familyWindowsMap = new Map<string, QuotaWindowSnapshot[]>();
  const hudQuotas: HudProviderQuota[] = [];

  for (const g of probe.quotaGroups) {
    const fam = inferModelFamily(g.displayName || '');
    const windows: QuotaWindowSnapshot[] = [];
    let w5hFrac: number | null = null;
    let w5hReset: string | null = null;
    let wkFrac: number | null = null;
    let wkReset: string | null = null;

    for (const b of g.buckets ?? []) {
      const winLower = `${b.window || ''} ${b.displayName || ''}`.toLowerCase();
      const kind = winLower.includes('week') ? 'weekly' : winLower.includes('5h') || winLower.includes('five hour') ? '5h' : 'pool';
      const frac = typeof b.remainingFraction === 'number' && Number.isFinite(b.remainingFraction)
        ? Math.min(1, Math.max(0, b.remainingFraction))
        : null;
      windows.push({
        kind,
        remainingFraction: frac,
        resetAt: b.resetIso ?? null,
        observedAt: nowIso,
        stale: false,
      });
      if (kind === '5h') {
        w5hFrac = frac;
        w5hReset = formatResetCountdown(b.resetIso ?? null, nowMs);
      } else if (kind === 'weekly') {
        wkFrac = frac;
        wkReset = formatResetCountdown(b.resetIso ?? null, nowMs);
      }
    }

    familyWindowsMap.set(fam, windows);
    const worst = [w5hFrac, wkFrac].filter((v): v is number => v !== null);
    const minFrac = worst.length > 0 ? Math.min(...worst) : null;
    hudQuotas.push({
      provider: fam,
      label: fam === 'claude' ? 'Claude / GPT' : fam === 'argon' ? 'Argon' : 'Gemini',
      status: inferQuotaStatus(minFrac),
      window5hFraction: w5hFrac,
      window5hResetText: w5hReset,
      weeklyFraction: wkFrac,
      weeklyResetText: wkReset,
    });
  }

  // 3. Fuse per-model quotas into AccountQuotaSummary
  const seenModels = new Set<string>();
  const rawModels = [];
  for (const cfg of probe.modelConfigs) {
    const id = cfg.modelId || cfg.label || '';
    if (!id || seenModels.has(id)) continue;
    seenModels.add(id);
    const fam = inferModelFamily(`${cfg.label || ''} ${id}`);
    rawModels.push({
      modelId: cfg.label || id,
      family: fam,
      ownRemainingFraction: cfg.remainingFraction ?? null,
      familyWindows: familyWindowsMap.get(fam) ?? [],
    });
  }

  const accountQuota =
    probe.email || rawModels.length > 0 || probe.quotaGroups.length > 0
      ? fuseAccountQuota(
          {
            accountEmail: email,
            active: true,
            environment: opts.environment,
            sshHost: opts.sshHost,
            updatedAt: nowIso,
            models: rawModels,
          },
          nowMs,
        )
      : null;

  const ledgerSummary = opts.ledger?.summarize({ accountEmail: email, foldThinkingLevels: true });
  const avgTps = totalStreamMs > 0 ? Number(((totalOutputTokens / totalStreamMs) * 1000).toFixed(1)) : 0;
  const cacheHitRate = totalInputAll > 0 ? Number((totalCacheRead / totalInputAll).toFixed(4)) : ledgerSummary?.cacheHitRate ?? 0;

  const hud: HudMetricsSnapshot = {
    conversationId: probe.activeCid ?? 'active',
    activity: probe.activity,
    turns: probe.generatorUsages.length || ledgerSummary?.totalRequests || 0,
    currentTurnMs: probe.generatorUsages.at(-1)?.durationMs ?? 0,
    avgTps,
    ttftMs: lastTtftMs,
    activeSubagents: probe.activeSubagents,
    activeSubagentNames: probe.activeSubagentNames,
    totalTokens: totalTokens || ledgerSummary?.totalTokens || 0,
    cacheHitRate,
    estimatedCostUsd: ledgerSummary?.estimatedCostUsd ?? 0,
    cacheSavedUsd: ledgerSummary?.cacheSavedUsd ?? 0,
    contextUsed: probe.contextUsed,
    contextLimit: probe.contextLimit || 512_000,
    contextEstimated: probe.contextEstimated,
    compactionCount: probe.compactionCount,
    currentModel,
    currentRole: 'executor',
    pastModels: [],
    isRemoteSsh: opts.environment === 'ssh',
    sshHost: opts.sshHost,
    quotas: hudQuotas.length > 0 ? hudQuotas : undefined,
  };

  return { accountQuota, hud };
}

export async function probeTargetLiveTelemetry(
  client: CdpClientLike,
): Promise<LiveTelemetryProbeResult | null> {
  try {
    const res = await client.send<{ result?: { value?: string }; exceptionDetails?: unknown }>(
      'Runtime.evaluate',
      {
        awaitPromise: true,
        returnByValue: true,
        expression: buildLiveTelemetryProbeExpression(),
      },
    );
    if (res.exceptionDetails || typeof res.result?.value !== 'string') return null;
    return JSON.parse(res.result.value) as LiveTelemetryProbeResult;
  } catch {
    return null;
  }
}
