import type { ModelPricingEntry, PricingTier, TokenUsageTuple } from '@antigravity-orbit/shared';

const THINKING_SUFFIX_RE = /-(?:low|medium|med|high|xhigh|max|minimal|tiered|thinking)$/i;

export function foldModelFamily(rawModel: string): string {
  const trimmed = rawModel.trim().toLowerCase();
  if (!trimmed) return 'unknown';
  let current = trimmed;
  while (THINKING_SUFFIX_RE.test(current)) {
    current = current.replace(THINKING_SUFFIX_RE, '');
  }
  return current;
}

export const DEFAULT_PRICING_CATALOG: readonly ModelPricingEntry[] = [
  {
    baseModel: 'gemini-4-neon',
    effectiveFrom: '2026-06-01',
    tiers: [
      {
        upToTokens: 200_000,
        inputPerMillion: 1.5,
        cacheReadPerMillion: 0.375,
        cacheWritePerMillion: 1.5,
        outputPerMillion: 12.0,
      },
      {
        upToTokens: null,
        inputPerMillion: 3.0,
        cacheReadPerMillion: 0.75,
        cacheWritePerMillion: 3.0,
        outputPerMillion: 18.0,
      },
    ],
  },
  {
    baseModel: 'gemini-4-carbon',
    effectiveFrom: '2026-06-01',
    tiers: [
      {
        upToTokens: null,
        inputPerMillion: 0.3,
        cacheReadPerMillion: 0.075,
        cacheWritePerMillion: 0.3,
        outputPerMillion: 1.2,
      },
    ],
  },
  {
    baseModel: 'gemini-4-argon',
    effectiveFrom: '2026-06-01',
    tiers: [
      {
        upToTokens: null,
        inputPerMillion: 5.0,
        cacheReadPerMillion: 1.25,
        cacheWritePerMillion: 5.0,
        outputPerMillion: 25.0,
      },
    ],
  },
  {
    baseModel: 'gemini-2.5-pro',
    effectiveFrom: '2025-04-01',
    tiers: [
      {
        upToTokens: 200_000,
        inputPerMillion: 1.25,
        cacheReadPerMillion: 0.3125,
        cacheWritePerMillion: 1.25,
        outputPerMillion: 10.0,
      },
      {
        upToTokens: null,
        inputPerMillion: 2.5,
        cacheReadPerMillion: 0.625,
        cacheWritePerMillion: 2.5,
        outputPerMillion: 15.0,
      },
    ],
  },
  {
    baseModel: 'gemini-2.5-flash',
    effectiveFrom: '2025-04-01',
    tiers: [
      {
        upToTokens: null,
        inputPerMillion: 0.15,
        cacheReadPerMillion: 0.0375,
        cacheWritePerMillion: 0.15,
        outputPerMillion: 0.6,
      },
    ],
  },
  {
    baseModel: 'claude-sonnet-4',
    effectiveFrom: '2025-05-01',
    tiers: [
      {
        upToTokens: 200_000,
        inputPerMillion: 3.0,
        cacheReadPerMillion: 0.3,
        cacheWritePerMillion: 3.75,
        outputPerMillion: 15.0,
      },
      {
        upToTokens: null,
        inputPerMillion: 6.0,
        cacheReadPerMillion: 0.6,
        cacheWritePerMillion: 7.5,
        outputPerMillion: 22.5,
      },
    ],
  },
  {
    baseModel: 'claude-opus-4',
    effectiveFrom: '2025-05-01',
    tiers: [
      {
        upToTokens: null,
        inputPerMillion: 15.0,
        cacheReadPerMillion: 1.5,
        cacheWritePerMillion: 18.75,
        outputPerMillion: 75.0,
      },
    ],
  },
];

export interface CostBreakdown {
  readonly costUsd: number;
  readonly cacheSavedUsd: number;
  readonly matchedModel: string | null;
}

function selectTier(tiers: readonly PricingTier[], contextTokens: number): PricingTier | null {
  for (const tier of tiers) {
    if (tier.upToTokens === null || contextTokens <= tier.upToTokens) {
      return tier;
    }
  }
  return tiers.at(-1) ?? null;
}

export function calculateUsageCost(
  rawModel: string,
  tokens: TokenUsageTuple,
  contextTokens: number,
  catalog: readonly ModelPricingEntry[] = DEFAULT_PRICING_CATALOG,
): CostBreakdown {
  const folded = foldModelFamily(rawModel);
  const entry = catalog.find((item) => folded === item.baseModel || folded.startsWith(`${item.baseModel}-`));
  if (!entry) {
    return { costUsd: 0, cacheSavedUsd: 0, matchedModel: null };
  }

  const tier = selectTier(entry.tiers, contextTokens);
  if (!tier) {
    return { costUsd: 0, cacheSavedUsd: 0, matchedModel: null };
  }

  const perM = 1_000_000;
  const outputTotal = tokens.outputThinking + tokens.outputReply;
  const costUsd =
    (tokens.inputUncached / perM) * tier.inputPerMillion +
    (tokens.cacheRead / perM) * tier.cacheReadPerMillion +
    (tokens.cacheWrite / perM) * tier.cacheWritePerMillion +
    (outputTotal / perM) * tier.outputPerMillion;

  const uncachedEquivalentForReads = (tokens.cacheRead / perM) * tier.inputPerMillion;
  const actualReadCost = (tokens.cacheRead / perM) * tier.cacheReadPerMillion;
  const cacheSavedUsd = Math.max(0, uncachedEquivalentForReads - actualReadCost);

  return {
    costUsd: Number(costUsd.toFixed(6)),
    cacheSavedUsd: Number(cacheSavedUsd.toFixed(6)),
    matchedModel: entry.baseModel,
  };
}
