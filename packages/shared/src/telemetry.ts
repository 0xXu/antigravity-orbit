export type EnvironmentKind = 'local' | 'ssh';
export type AgentActivityState = 'idle' | 'thinking' | 'tool';

export interface TokenUsageTuple {
  readonly inputUncached: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly outputThinking: number;
  readonly outputReply: number;
}

export interface PricingTier {
  readonly upToTokens: number | null; // null = infinity
  readonly inputPerMillion: number;
  readonly cacheReadPerMillion: number;
  readonly cacheWritePerMillion: number;
  readonly outputPerMillion: number;
}

export interface ModelPricingEntry {
  readonly baseModel: string;
  readonly effectiveFrom: string; // ISO date
  readonly tiers: readonly PricingTier[];
}

export interface UsageRecordInput {
  readonly trajectoryId: string;
  readonly executionId: string;
  readonly accountEmail: string;
  readonly environment: EnvironmentKind;
  readonly sshHost?: string;
  readonly rawModel: string;
  readonly timestampMs: number;
  readonly contextTokens: number;
  readonly tokens: TokenUsageTuple;
  readonly durationMs: number;
  readonly ttftMs?: number;
}

export interface UsageFilter {
  readonly environment?: EnvironmentKind | 'all';
  readonly accountEmail?: string | 'all';
  readonly sinceMs?: number;
  readonly foldThinkingLevels?: boolean;
}

export interface ModelUsageAggregate {
  readonly model: string;
  readonly requests: number;
  readonly totalTokens: number;
  readonly inputUncached: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly outputTokens: number;
  readonly estimatedCostUsd: number;
  readonly cacheSavedUsd: number;
}

export interface HeatmapDay {
  readonly date: string; // YYYY-MM-DD
  readonly tokens: number;
  readonly requests: number;
  readonly costUsd: number;
}

export interface UsageSummary {
  readonly totalRequests: number;
  readonly totalTokens: number;
  readonly cacheHitRate: number; // 0..1
  readonly estimatedCostUsd: number;
  readonly cacheSavedUsd: number;
  readonly localTokens: number;
  readonly sshTokens: number;
  readonly models: readonly ModelUsageAggregate[];
  readonly heatmap: readonly HeatmapDay[];
}

export type QuotaWindowKind = '5h' | 'daily' | 'weekly' | 'pool';

export interface QuotaWindowSnapshot {
  readonly kind: QuotaWindowKind;
  readonly remainingFraction: number | null; // null = unknown (never fabricate 100%)
  readonly resetAt: string | null;
  readonly observedAt: string;
  readonly stale: boolean;
}

export interface ModelQuotaEntry {
  readonly modelId: string;
  readonly family: string;
  readonly ownRemainingFraction: number | null;
  readonly effectiveRemainingFraction: number | null;
  readonly windows: readonly QuotaWindowSnapshot[];
}

export interface AccountQuotaSummary {
  readonly accountEmail: string;
  readonly active: boolean;
  readonly environment: EnvironmentKind;
  readonly sshHost?: string;
  readonly updatedAt: string;
  readonly models: readonly ModelQuotaEntry[];
  readonly recommendedScore: number; // 0..100 for standby switching
}

export interface HudModelContextEntry {
  readonly model: string;
  readonly role: 'planner' | 'executor' | 'chat';
  readonly peakRatio: number;
  readonly compactions: number;
}

export interface HudProviderQuota {
  readonly provider: string;
  readonly label: string;
  readonly status: 'abundant' | 'moderate' | 'low' | 'unknown';
  readonly window5hFraction: number | null;
  readonly window5hResetText: string | null;
  readonly weeklyFraction: number | null;
  readonly weeklyResetText: string | null;
}

export interface HudMetricsSnapshot {
  readonly conversationId: string;
  readonly activity: AgentActivityState;
  readonly turns: number;
  readonly currentTurnMs: number;
  readonly avgTps: number;
  readonly ttftMs: number | null;
  readonly activeSubagents: number;
  readonly activeSubagentNames?: readonly string[];
  readonly totalTokens: number;
  readonly cacheHitRate: number;
  readonly estimatedCostUsd: number;
  readonly cacheSavedUsd: number;
  readonly contextUsed: number;
  readonly contextLimit: number;
  readonly contextEstimated: boolean;
  readonly compactionCount: number;
  readonly currentModel: string;
  readonly currentRole: 'planner' | 'executor' | 'chat';
  readonly pastModels: readonly HudModelContextEntry[];
  readonly isRemoteSsh: boolean;
  readonly sshHost?: string;
  readonly quotas?: readonly HudProviderQuota[];
}
