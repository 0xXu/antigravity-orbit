import type {
  AccountQuotaSummary,
  EnvironmentKind,
  ModelQuotaEntry,
  QuotaWindowSnapshot,
} from '@antigravity-orbit/shared';

export interface RawModelQuotaInput {
  readonly modelId: string;
  readonly family: string;
  readonly ownRemainingFraction: number | null;
  readonly familyWindows: readonly QuotaWindowSnapshot[];
}

export interface RawAccountQuotaInput {
  readonly accountEmail: string;
  readonly active: boolean;
  readonly environment: EnvironmentKind;
  readonly sshHost?: string;
  readonly updatedAt: string;
  readonly models: readonly RawModelQuotaInput[];
}

function clampFraction(v: number | null): number | null {
  if (v === null || !Number.isFinite(v)) return null;
  return Math.min(1, Math.max(0, v));
}

/**
 * Computes effective remaining fraction = min(own, fresh family windows).
 * Strictly preserves `null` when no known fraction exists — never fabricates 100%.
 */
export function fuseModelQuota(input: RawModelQuotaInput, nowMs = Date.now()): ModelQuotaEntry {
  const own = clampFraction(input.ownRemainingFraction);
  const candidates: number[] = [];
  if (own !== null) candidates.push(own);

  const normalizedWindows: QuotaWindowSnapshot[] = input.familyWindows.map((w) => {
    const frac = clampFraction(w.remainingFraction);
    const resetPassed = w.resetAt !== null && Date.parse(w.resetAt) <= nowMs;
    const stale = w.stale || resetPassed;
    if (!stale && frac !== null) {
      candidates.push(frac);
    }
    return {
      ...w,
      remainingFraction: frac,
      stale,
    };
  });

  const effective = candidates.length > 0 ? Math.min(...candidates) : null;
  return {
    modelId: input.modelId,
    family: input.family,
    ownRemainingFraction: own,
    effectiveRemainingFraction: effective,
    windows: normalizedWindows,
  };
}

export function fuseAccountQuota(input: RawAccountQuotaInput, nowMs = Date.now()): AccountQuotaSummary {
  const models = input.models.map((m) => fuseModelQuota(m, nowMs));
  const knownFractions = models
    .map((m) => m.effectiveRemainingFraction)
    .filter((v): v is number => v !== null);

  const avgFraction =
    knownFractions.length > 0
      ? knownFractions.reduce((acc, v) => acc + v, 0) / knownFractions.length
      : 0;

  return {
    accountEmail: input.accountEmail,
    active: input.active,
    environment: input.environment,
    sshHost: input.sshHost,
    updatedAt: input.updatedAt,
    models,
    recommendedScore: Math.round(avgFraction * 100),
  };
}

export function rankStandbyAccounts(
  accounts: readonly AccountQuotaSummary[],
): AccountQuotaSummary[] {
  return accounts
    .filter((a) => !a.active)
    .slice()
    .sort((a, b) => b.recommendedScore - a.recommendedScore);
}
