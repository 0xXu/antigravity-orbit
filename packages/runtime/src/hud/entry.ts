import type {
  HudMetricsSnapshot,
  HudProviderQuota,
  VisualBudgetMode,
  VisualChannelContract,
} from '@antigravity-orbit/shared';

const HUD_HOST_ID = 'antigravity-orbit-hybrid-hud-host';
const LARGE_CIRCUMFERENCE = 2 * Math.PI * 18.5; // ~116.24
const MINI_CIRCUMFERENCE = 2 * Math.PI * 7.5; // ~47.12

const DEFAULT_QUOTAS: readonly HudProviderQuota[] = [
  {
    provider: 'gemini',
    label: 'Gemini',
    status: 'unknown',
    window5hFraction: null,
    window5hResetText: null,
    weeklyFraction: null,
    weeklyResetText: null,
  },
  {
    provider: 'claude',
    label: 'Claude',
    status: 'unknown',
    window5hFraction: null,
    window5hResetText: null,
    weeklyFraction: null,
    weeklyResetText: null,
  },
];

function formatCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
  return String(Math.round(n));
}

function formatTtft(ttftMs: number | null): string {
  if (ttftMs === null || !Number.isFinite(ttftMs)) return '--';
  if (ttftMs >= 1000) return `${(ttftMs / 1000).toFixed(2)}s`;
  return `${Math.round(ttftMs)}ms`;
}

function ringPalette(ratio: number): { c1: string; c2: string; glow: string } {
  if (ratio >= 0.85) {
    return { c1: '#fb7185', c2: '#e11d48', glow: 'rgba(251, 113, 133, 0.7)' };
  }
  if (ratio >= 0.65) {
    return { c1: '#fbbf24', c2: '#f97316', glow: 'rgba(251, 191, 36, 0.65)' };
  }
  return { c1: '#38bdf8', c2: '#2563eb', glow: 'rgba(56, 189, 248, 0.65)' };
}

function quotaStatusMeta(status: HudProviderQuota['status']): { text: string; color: string; grad: string } {
  switch (status) {
    case 'abundant':
      return { text: '充裕', color: '#22c55e', grad: 'linear-gradient(90deg, #2563eb, #38bdf8)' };
    case 'moderate':
      return { text: '适中', color: '#f59e0b', grad: 'linear-gradient(90deg, #d97706, #fbbf24)' };
    case 'low':
      return { text: '偏紧', color: '#ef4444', grad: 'linear-gradient(90deg, #e11d48, #fb7185)' };
    default:
      return { text: '待同步', color: '#94a3b8', grad: 'linear-gradient(90deg, #2563eb, #38bdf8)' };
  }
}

interface HudMountTarget {
  readonly parent: Element;
  readonly before: Element | null;
  readonly mode: 'toolbar' | 'inline' | 'floating';
}

function isElementVisible(el: Element): boolean {
  const rect = el.getBoundingClientRect?.();
  if (!rect) return true;
  return rect.width > 0 && rect.height > 0;
}

class HybridTelemetryHudChannel implements VisualChannelContract {
  readonly id = 'ch02-hud' as const;
  private host: HTMLElement | null = null;
  private shadow: ShadowRoot | null = null;
  private unsubHud: (() => void) | null = null;
  private docClickHandler: ((ev: MouseEvent) => void) | null = null;
  private anchorObserver: MutationObserver | null = null;
  private mountMode: 'toolbar' | 'inline' | 'floating' = 'floating';
  private popoverOpen = false;
  private swarmOpen = false;
  private selectedProvider = 'gemini';
  private paused = false;

  private snapshot: HudMetricsSnapshot = {
    conversationId: 'pending',
    activity: 'idle',
    turns: 0,
    currentTurnMs: 0,
    avgTps: 0,
    ttftMs: null,
    activeSubagents: 0,
    totalTokens: 0,
    cacheHitRate: 0,
    estimatedCostUsd: 0,
    cacheSavedUsd: 0,
    contextUsed: 0,
    contextLimit: 512_000,
    contextEstimated: true,
    compactionCount: 0,
    currentModel: 'ready',
    currentRole: 'executor',
    pastModels: [],
    isRemoteSsh: false,
  };

  private resolveMountTarget(root: Document): HudMountTarget | null {
    const customAnchor = root.querySelector('[data-antigravity-orbit-hud-anchor]');
    if (customAnchor) return { parent: customAnchor, before: null, mode: 'inline' };

    const permTriggers = Array.from(root.querySelectorAll('[data-testid="permissions-selector-trigger"]'));
    if (permTriggers.length > 0) {
      const preferred =
        permTriggers.find((el) => isElementVisible(el) && el.closest('[data-testid="conversation-view"]')) ??
        permTriggers.find((el) => isElementVisible(el)) ??
        permTriggers[0]!;
      if (preferred.parentElement) {
        return { parent: preferred.parentElement, before: preferred, mode: 'toolbar' };
      }
    }

    const footers = Array.from(root.querySelectorAll('.agy-composer-footer, [data-testid="input-box-bottom-toolbar"]'));
    if (footers.length > 0) {
      const footer = footers.find((el) => isElementVisible(el)) ?? footers[0]!;
      const rightGroup = footer.children.length >= 2 ? footer.children[footer.children.length - 1] : footer;
      if (rightGroup) {
        return {
          parent: rightGroup,
          before: rightGroup.firstElementChild,
          mode: 'toolbar',
        };
      }
    }

    const composerCard = root.querySelector('.surface-composer-card, [data-testid="agent-input-box"]');
    if (composerCard?.parentElement) {
      return { parent: composerCard.parentElement, before: null, mode: 'inline' };
    }

    const fallback = root.body || root.documentElement;
    return fallback ? { parent: fallback, before: null, mode: 'floating' } : null;
  }

  private attachHost(target: HudMountTarget): void {
    if (!this.host) return;
    if (this.mountMode !== target.mode || this.host.getAttribute('data-hud-mode') !== target.mode) {
      this.mountMode = target.mode;
      this.host.setAttribute('data-hud-mode', target.mode);
    }

    const beforeValid = target.before && target.before.parentElement === target.parent ? target.before : null;
    const alreadyPositioned =
      this.host.isConnected &&
      this.host.parentElement === target.parent &&
      (beforeValid ? this.host.nextElementSibling === beforeValid : true);

    if (!alreadyPositioned) {
      if (beforeValid) {
        target.parent.insertBefore(this.host, beforeValid);
      } else {
        target.parent.appendChild(this.host);
      }
    }
  }

  mount(root: Document): void {
    const target = this.resolveMountTarget(root);
    if (!target) return;
    this.mountMode = target.mode;

    const host = root.createElement('div');
    host.id = HUD_HOST_ID;
    host.setAttribute('data-antigravity-orbit-owned', 'true');
    host.setAttribute('data-no-translate', 'true');
    host.setAttribute('translate', 'no');
    const shadow = host.attachShadow({ mode: 'open' });

    shadow.innerHTML = `
      <style>
        :host {
          display: flex;
          justify-content: flex-end;
          position: relative;
          width: 100%;
          margin-top: 6px;
          font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Inter', sans-serif;
          color: var(--pb-text-primary, #f4f4f5);
          user-select: none;
          pointer-events: auto;
          z-index: 60;
        }
        :host([data-hud-mode="toolbar"]) {
          display: inline-flex;
          align-items: center;
          justify-content: flex-end;
          position: relative;
          width: auto;
          height: 28px;
          margin-top: 0;
          flex-shrink: 0;
          pointer-events: auto;
          z-index: 60;
        }
        :host([data-hud-mode="toolbar"]) #hud-root {
          display: inline-flex;
          align-items: center;
          position: relative;
        }
        :host([data-hud-mode="floating"]) {
          display: inline-block;
          width: auto;
          margin-top: 0;
          position: fixed;
          right: 18px;
          bottom: 14px;
          z-index: 2147483000;
        }
        * { box-sizing: border-box; }
        .tab-nums { font-variant-numeric: tabular-nums; }

        @keyframes orbit-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
        @keyframes arc-breathe {
          0%, 100% { filter: drop-shadow(0 0 2px var(--arc-glow, rgba(56, 189, 248, 0.45))); }
          50% { filter: drop-shadow(0 0 6px var(--arc-glow, rgba(56, 189, 248, 0.85))); }
        }
        @keyframes bar-shimmer {
          0% { transform: translateX(-140%) skewX(-24deg); }
          100% { transform: translateX(360%) skewX(-24deg); }
        }
        @keyframes edge-pulse {
          0%, 100% { opacity: 0.45; }
          50% { opacity: 0.95; }
        }
        @keyframes eq-bounce {
          0%, 100% { transform: scaleY(0.35); }
          50% { transform: scaleY(1); }
        }
        @keyframes pop-in {
          from { opacity: 0; transform: translateY(6px) scale(0.985); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }

        .eco-paused .orbit-track-spin,
        .eco-paused .arc-glow-live,
        .eco-paused .energy-shimmer,
        .eco-paused .frontier-beam,
        .eco-paused .eq-bar {
          animation-play-state: paused !important;
        }

        /* Unified 3-in-1 Compact Trigger Pill */
        .trigger-pill {
          display: inline-flex;
          align-items: center;
          gap: 10px;
          padding: 5px 13px;
          border-radius: 999px;
          cursor: pointer;
          font-size: 12px;
          line-height: 1.2;
          background: var(--pb-surface-bg, rgba(22, 22, 27, 0.88));
          color: var(--pb-text-primary, #f4f4f5);
          border: 1px solid var(--pb-border-subtle, rgba(255, 255, 255, 0.1));
          box-shadow: 0 2px 10px rgba(0, 0, 0, 0.18);
          transition: border-color 160ms ease, background 160ms ease;
        }
        .trigger-pill:hover {
          border-color: var(--pb-accent, #3b82f6);
        }
        :host([data-hud-mode="toolbar"]) .trigger-pill {
          height: 28px;
          padding: 0 9px;
          gap: 6px;
          border-radius: 8px;
          font-size: 12px;
          white-space: nowrap;
          background: transparent;
          border: 1px solid transparent;
          box-shadow: none;
        }
        :host([data-hud-mode="toolbar"]) .trigger-pill:hover,
        :host([data-hud-mode="toolbar"]) .trigger-pill[aria-expanded="true"] {
          background: color-mix(in srgb, var(--pb-text-primary, #94a3b8) 6%, transparent);
          border-color: var(--pb-border-subtle, rgba(148, 163, 184, 0.22));
        }
        .muted { color: var(--pb-text-muted, #94a3b8); }
        .sep { opacity: 0.4; }
        .pill-ctx {
          display: inline-flex;
          align-items: center;
          gap: 6px;
        }
        .mini-ring { width: 17px; height: 17px; display: block; }

        /* Redesigned Scheme B Popover */
        .popover {
          position: absolute;
          bottom: calc(100% + 10px);
          right: 0;
          z-index: 2147483001;
          width: 408px;
          max-width: calc(100vw - 24px);
          border-radius: 16px;
          background: var(--pb-surface-bg, #16161b);
          color: var(--pb-text-primary, #f4f4f5);
          border: 1px solid var(--pb-border-subtle, rgba(255, 255, 255, 0.12));
          box-shadow: 0 18px 42px rgba(0, 0, 0, 0.28);
          overflow: hidden;
          display: none;
          font-size: 12px;
        }
        .popover.open {
          display: block;
          animation: pop-in 200ms cubic-bezier(0.22, 1, 0.36, 1);
        }

        /* Section 1: Orbital Ring + Model + Swarm */
        .sec-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 12px 16px;
          border-bottom: 1px solid var(--pb-border-subtle, rgba(255, 255, 255, 0.08));
        }
        .head-left {
          display: flex;
          align-items: center;
          gap: 12px;
          min-width: 0;
        }
        .ring-wrap {
          position: relative;
          width: 52px;
          height: 52px;
          flex-shrink: 0;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .ring-wrap svg { width: 52px; height: 52px; display: block; }
        .ring-pct {
          position: absolute;
          font-size: 12px;
          font-weight: 700;
        }
        .orbit-track-spin {
          transform-origin: 26px 26px;
          animation: orbit-spin 22s linear infinite;
        }
        .smooth-arc {
          transition: stroke-dashoffset 560ms cubic-bezier(0.22, 1, 0.36, 1);
        }
        .arc-glow-live {
          animation: arc-breathe 2.6s ease-in-out infinite;
        }
        .model-info { min-width: 0; }
        .model-name {
          font-weight: 600;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .ctx-sub {
          margin-top: 3px;
          font-size: 11.5px;
          white-space: nowrap;
          color: var(--pb-text-muted, #94a3b8);
        }
        .swarm-btn {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 4px 10px;
          border-radius: 999px;
          border: 1px solid var(--pb-border-subtle, rgba(255, 255, 255, 0.12));
          background: rgba(255, 255, 255, 0.05);
          color: inherit;
          font-size: 12px;
          cursor: pointer;
          flex-shrink: 0;
          transition: border-color 150ms ease;
        }
        .swarm-btn:hover { border-color: var(--pb-accent, #3b82f6); }
        .swarm-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: #22c55e;
        }
        .swarm-dot.idle { background: #64748b; }

        .swarm-drawer {
          display: none;
          padding: 8px 16px;
          background: rgba(0, 0, 0, 0.18);
          border-bottom: 1px solid var(--pb-border-subtle, rgba(255, 255, 255, 0.08));
          justify-content: space-between;
          align-items: center;
          gap: 8px;
          color: var(--pb-text-muted, #94a3b8);
        }
        .swarm-drawer.open { display: flex; }
        .saved-tag { color: #22c55e; }

        /* Section 2: 3-Column KPI */
        .kpi-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          border-bottom: 1px solid var(--pb-border-subtle, rgba(255, 255, 255, 0.08));
        }
        .kpi-cell {
          padding: 10px 12px;
        }
        .kpi-cell + .kpi-cell {
          border-left: 1px solid var(--pb-border-subtle, rgba(255, 255, 255, 0.08));
        }
        .kpi-label {
          display: flex;
          align-items: center;
          justify-content: space-between;
          color: var(--pb-text-muted, #94a3b8);
        }
        .kpi-val {
          margin-top: 4px;
          font-weight: 700;
        }
        .kpi-val.cache-ok { color: #22c55e; }
        .eq-wrap {
          display: inline-flex;
          align-items: flex-end;
          gap: 2px;
          height: 10px;
          opacity: 0.25;
        }
        .eq-wrap.active { opacity: 1; }
        .eq-bar {
          width: 2px;
          height: 10px;
          border-radius: 99px;
          background: var(--pb-accent, #3b82f6);
          transform-origin: bottom;
          animation: eq-bounce 0.9s ease-in-out infinite;
        }
        .eq-bar:nth-child(2) { animation-delay: 0.18s; }
        .eq-bar:nth-child(3) { animation-delay: 0.36s; }

        /* Section 3: Fluid Shimmer Quota Bars */
        .sec-quota {
          padding: 12px 16px;
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .quota-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
        }
        .quota-title-wrap {
          display: flex;
          align-items: center;
          gap: 8px;
        }
        .quota-title { font-weight: 600; }
        .quota-badge {
          padding: 2px 8px;
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.06);
          font-weight: 500;
        }
        .prov-switch {
          display: inline-flex;
          padding: 2px;
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.06);
          border: 1px solid var(--pb-border-subtle, rgba(255, 255, 255, 0.1));
        }
        .prov-btn {
          border: 0;
          background: transparent;
          color: var(--pb-text-muted, #94a3b8);
          padding: 2px 10px;
          border-radius: 999px;
          font-size: 12px;
          cursor: pointer;
          transition: background 150ms ease, color 150ms ease;
        }
        .prov-btn.active {
          background: var(--pb-surface-bg, #27272f);
          color: var(--pb-text-primary, #f4f4f5);
        }

        .q-row {
          display: flex;
          flex-direction: column;
          gap: 5px;
        }
        .q-row-top {
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        .bar-track {
          position: relative;
          height: 8px;
          width: 100%;
          border-radius: 999px;
          background: rgba(255, 255, 255, 0.08);
          overflow: hidden;
        }
        .bar-ticks {
          position: absolute;
          inset: 0;
          z-index: 2;
          pointer-events: none;
          opacity: 0.45;
          background-image: repeating-linear-gradient(
            90deg,
            transparent 0,
            transparent calc(25% - 1px),
            var(--pb-surface-bg, #16161b) calc(25% - 1px),
            var(--pb-surface-bg, #16161b) 25%
          );
        }
        .bar-fill {
          position: relative;
          height: 100%;
          border-radius: 999px;
          overflow: hidden;
          transition: width 520ms cubic-bezier(0.22, 1, 0.36, 1), background 320ms ease;
        }
        .energy-shimmer {
          position: absolute;
          inset: 0;
          width: 36%;
          background: linear-gradient(90deg, transparent 0%, rgba(255, 255, 255, 0.34) 50%, transparent 100%);
          animation: bar-shimmer 2.8s cubic-bezier(0.4, 0, 0.2, 1) infinite;
          pointer-events: none;
        }
        .frontier-beam {
          position: absolute;
          right: 0;
          top: 0;
          bottom: 0;
          width: 4px;
          background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.78));
          animation: edge-pulse 2.1s ease-in-out infinite;
          pointer-events: none;
        }
      </style>

      <div id="hud-root">
        <div class="popover" id="pb-popover">
          <!-- Section 1 -->
          <div class="sec-head">
            <div class="head-left">
              <div class="ring-wrap">
                <svg viewBox="0 0 52 52">
                  <defs>
                    <linearGradient id="ao-ring-grad" x1="0%" y1="0%" x2="100%" y2="100%">
                      <stop id="ao-stop-1" offset="0%" stop-color="#38bdf8" />
                      <stop id="ao-stop-2" offset="100%" stop-color="#2563eb" />
                    </linearGradient>
                  </defs>
                  <circle class="orbit-track-spin" cx="26" cy="26" r="23.5" fill="none" stroke="rgba(148,163,184,0.35)" stroke-width="1" stroke-dasharray="2.5 4.5" />
                  <circle cx="26" cy="26" r="18.5" fill="none" stroke="rgba(255,255,255,0.09)" stroke-width="4.2" />
                  <g transform="rotate(-90 26 26)">
                    <circle
                      id="ao-ring-arc"
                      class="smooth-arc arc-glow-live"
                      cx="26" cy="26" r="18.5"
                      fill="none"
                      stroke="url(#ao-ring-grad)"
                      stroke-width="4.2"
                      stroke-linecap="round"
                      stroke-dasharray="${LARGE_CIRCUMFERENCE.toFixed(2)}"
                      stroke-dashoffset="${LARGE_CIRCUMFERENCE.toFixed(2)}"
                    />
                  </g>
                </svg>
                <span class="ring-pct tab-nums" id="ao-ring-pct">0%</span>
              </div>
              <div class="model-info">
                <div class="model-name" id="ao-model-name">ready</div>
                <div class="ctx-sub tab-nums" id="ao-ctx-sub">0 / 512K tok · 剩余 100%</div>
              </div>
            </div>
            <button type="button" class="swarm-btn" id="ao-swarm-btn">
              <span class="swarm-dot idle" id="ao-swarm-dot"></span>
              <span id="ao-swarm-label">Swarm · 0</span>
            </button>
          </div>

          <div class="swarm-drawer" id="ao-swarm-drawer">
            <span id="ao-swarm-names">当前无活跃子代理</span>
            <span class="saved-tag tab-nums" id="ao-saved-usd">缓存省 $0.00</span>
          </div>

          <!-- Section 2 -->
          <div class="kpi-grid">
            <div class="kpi-cell">
              <div class="kpi-label">
                <span>生成速率</span>
                <span class="eq-wrap" id="ao-eq-wrap">
                  <span class="eq-bar"></span>
                  <span class="eq-bar"></span>
                  <span class="eq-bar"></span>
                </span>
              </div>
              <div class="kpi-val tab-nums" id="ao-tps">0.0 <span class="muted">tok/s</span></div>
            </div>
            <div class="kpi-cell">
              <div class="kpi-label"><span>缓存命中</span></div>
              <div class="kpi-val cache-ok tab-nums" id="ao-cache">0.0%</div>
            </div>
            <div class="kpi-cell">
              <div class="kpi-label"><span>首字延迟</span></div>
              <div class="kpi-val tab-nums" id="ao-ttft">--</div>
            </div>
          </div>

          <!-- Section 3 -->
          <div class="sec-quota">
            <div class="quota-head">
              <div class="quota-title-wrap">
                <span class="quota-title" id="ao-q-title">Gemini</span>
                <span class="quota-badge" id="ao-q-badge">待同步</span>
              </div>
              <div class="prov-switch" id="ao-prov-switch"></div>
            </div>

            <div class="q-row">
              <div class="q-row-top">
                <span class="muted">5h 窗口</span>
                <span class="tab-nums" id="ao-q5h-val">--</span>
              </div>
              <div class="bar-track">
                <div class="bar-ticks"></div>
                <div class="bar-fill" id="ao-q5h-bar" style="width: 0%;">
                  <div class="energy-shimmer"></div>
                  <div class="frontier-beam"></div>
                </div>
              </div>
            </div>

            <div class="q-row">
              <div class="q-row-top">
                <span class="muted">周额度</span>
                <span class="tab-nums" id="ao-qwk-val">--</span>
              </div>
              <div class="bar-track">
                <div class="bar-ticks"></div>
                <div class="bar-fill" id="ao-qwk-bar" style="width: 0%;">
                  <div class="energy-shimmer" style="animation-delay: 0.8s;"></div>
                  <div class="frontier-beam"></div>
                </div>
              </div>
            </div>

            <div class="quota-head" style="padding-top: 4px; border-top: 1px solid var(--pb-border-subtle, rgba(255,255,255,0.08));">
              <button type="button" class="swarm-btn" id="ao-compact-btn" style="display:none;">⚡ 插入 /compact</button>
              <button type="button" class="swarm-btn" id="ao-console-btn" style="margin-left:auto;">打开控制台 ↗</button>
            </div>
          </div>
        </div>

        <!-- Unified 3-in-1 Inline Pill -->
        <button type="button" class="trigger-pill" id="ao-trigger">
          <span class="tab-nums"><strong id="ao-pill-tps">0.0</strong> <span class="muted">tok/s</span></span>
          <span class="muted sep">·</span>
          <span class="tab-nums"><span class="muted">缓存</span> <strong id="ao-pill-cache">0.0%</strong></span>
          <span class="muted sep">·</span>
          <span class="pill-ctx tab-nums">
            <svg class="mini-ring" viewBox="0 0 22 22">
              <defs>
                <linearGradient id="ao-mini-grad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop id="ao-mini-1" offset="0%" stop-color="#38bdf8" />
                  <stop id="ao-mini-2" offset="100%" stop-color="#2563eb" />
                </linearGradient>
              </defs>
              <circle cx="11" cy="11" r="7.5" fill="none" stroke="color-mix(in srgb, currentColor 15%, transparent)" stroke-width="2.6" />
              <g transform="rotate(-90 11 11)">
                <circle
                  id="ao-pill-ring"
                  class="smooth-arc arc-glow-live"
                  cx="11" cy="11" r="7.5"
                  fill="none"
                  stroke="url(#ao-mini-grad)"
                  stroke-width="2.6"
                  stroke-linecap="round"
                  stroke-dasharray="${MINI_CIRCUMFERENCE.toFixed(2)}"
                  stroke-dashoffset="${MINI_CIRCUMFERENCE.toFixed(2)}"
                />
              </g>
            </svg>
            <strong id="ao-pill-ctx">0%</strong>
          </span>
        </button>
      </div>
    `;

    shadow.getElementById('ao-trigger')?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.popoverOpen = !this.popoverOpen;
      this.render();
    });

    shadow.getElementById('ao-swarm-btn')?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.swarmOpen = !this.swarmOpen;
      this.render();
    });

    shadow.getElementById('ao-prov-switch')?.addEventListener('click', (ev) => {
      const btn = (ev.target as HTMLElement | null)?.closest<HTMLElement>('[data-provider]');
      if (!btn) return;
      this.selectedProvider = btn.getAttribute('data-provider') || 'gemini';
      this.render();
    });

    shadow.getElementById('ao-compact-btn')?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const input = root.querySelector<HTMLElement>(
        '[role="combobox"][contenteditable="true"], [contenteditable="true"], textarea',
      );
      if (input) {
        input.focus();
        if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
          input.value = '/compact';
          input.dispatchEvent(new Event('input', { bubbles: true }));
        } else if (input.isContentEditable) {
          document.execCommand?.('insertText', false, '/compact');
        }
      }
      this.popoverOpen = false;
      this.render();
    });

    shadow.getElementById('ao-console-btn')?.addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.popoverOpen = false;
      this.render();
      window.__antigravityOrbit?.openDesktopConsole('overview');
    });

    this.docClickHandler = (ev: MouseEvent) => {
      if (!this.popoverOpen || !this.host) return;
      const path = ev.composedPath();
      if (!path.includes(this.host)) {
        this.popoverOpen = false;
        this.render();
      }
    };
    root.addEventListener('click', this.docClickHandler);

    this.host = host;
    this.shadow = shadow;
    this.attachHost(target);
    this.unsubHud =
      window.__antigravityOrbit?.onHudUpdate((snap) => {
        this.snapshot = snap;
        this.render();
      }) ?? null;

    if (typeof MutationObserver !== 'undefined') {
      let reanchorTimer: number | null = null;
      this.anchorObserver = new MutationObserver(() => {
        if (reanchorTimer !== null) return;
        reanchorTimer = window.setTimeout(() => {
          reanchorTimer = null;
          if (!this.host) return;
          const next = this.resolveMountTarget(root);
          if (!next) return;
          this.attachHost(next);
        }, 250);
      });
      this.anchorObserver.observe(root.body ?? root.documentElement, { childList: true, subtree: true });
    }
    this.render();
  }

  onVisibilityChange(hidden: boolean): void {
    this.paused = hidden;
    this.syncAnimationState();
  }

  onWindowBlur(blurred: boolean): void {
    this.paused = blurred;
    this.syncAnimationState();
  }

  setBudgetMode(mode: VisualBudgetMode): void {
    this.paused = mode === 'silent-eco';
    this.syncAnimationState();
  }

  reclaimVram(): void {
    this.paused = true;
    this.syncAnimationState();
  }

  dispose(): void {
    this.unsubHud?.();
    this.unsubHud = null;
    this.anchorObserver?.disconnect();
    this.anchorObserver = null;
    if (this.docClickHandler) {
      document.removeEventListener('click', this.docClickHandler);
      this.docClickHandler = null;
    }
    this.host?.remove();
    this.host = null;
    this.shadow = null;
  }

  private syncAnimationState(): void {
    this.shadow?.getElementById('hud-root')?.classList.toggle('eco-paused', this.paused);
  }

  private render(): void {
    if (!this.shadow) return;
    const s = this.snapshot;
    const ratio = s.contextLimit > 0 ? Math.max(0, Math.min(1, s.contextUsed / s.contextLimit)) : 0;
    const ctxPct = Math.round(ratio * 100);
    const remPct = Math.max(0, 100 - ctxPct);
    const cachePct = (Math.max(0, Math.min(1, s.cacheHitRate)) * 100).toFixed(1);
    const tpsText = s.avgTps.toFixed(1);
    const pal = ringPalette(ratio);

    // Trigger pill
    const pillTps = this.shadow.getElementById('ao-pill-tps');
    if (pillTps) pillTps.textContent = tpsText;
    const pillCache = this.shadow.getElementById('ao-pill-cache');
    if (pillCache) pillCache.textContent = `${cachePct}%`;
    const pillCtx = this.shadow.getElementById('ao-pill-ctx');
    if (pillCtx) pillCtx.textContent = `${s.contextEstimated ? '~' : ''}${ctxPct}%`;

    // Rings
    this.shadow.getElementById('ao-stop-1')?.setAttribute('stop-color', pal.c1);
    this.shadow.getElementById('ao-stop-2')?.setAttribute('stop-color', pal.c2);
    this.shadow.getElementById('ao-mini-1')?.setAttribute('stop-color', pal.c1);
    this.shadow.getElementById('ao-mini-2')?.setAttribute('stop-color', pal.c2);

    const largeArc = this.shadow.getElementById('ao-ring-arc');
    if (largeArc) {
      largeArc.style.strokeDashoffset = (LARGE_CIRCUMFERENCE * (1 - ratio)).toFixed(2);
      largeArc.style.setProperty('--arc-glow', pal.glow);
    }
    const miniArc = this.shadow.getElementById('ao-pill-ring');
    if (miniArc) {
      miniArc.style.strokeDashoffset = (MINI_CIRCUMFERENCE * (1 - ratio)).toFixed(2);
      miniArc.style.setProperty('--arc-glow', pal.glow);
    }

    // Popover visibility
    this.shadow.getElementById('pb-popover')?.classList.toggle('open', this.popoverOpen);
    this.shadow.getElementById('ao-trigger')?.setAttribute('aria-expanded', String(this.popoverOpen));
    this.shadow.getElementById('ao-swarm-drawer')?.classList.toggle('open', this.swarmOpen);

    // Header
    const ringPct = this.shadow.getElementById('ao-ring-pct');
    if (ringPct) ringPct.textContent = `${ctxPct}%`;
    const modelEl = this.shadow.getElementById('ao-model-name');
    if (modelEl) {
      const sshSuffix = s.isRemoteSsh ? ` · SSH${s.sshHost ? ` (${s.sshHost})` : ''}` : '';
      modelEl.textContent = `${s.currentModel}${sshSuffix}`;
    }
    const ctxSub = this.shadow.getElementById('ao-ctx-sub');
    if (ctxSub) {
      const comp = s.compactionCount > 0 ? ` · 压缩×${s.compactionCount}` : '';
      ctxSub.textContent = `${formatCompact(s.contextUsed)} / ${formatCompact(s.contextLimit)} tok · 剩余 ${remPct}%${comp}`;
    }

    const swarmDot = this.shadow.getElementById('ao-swarm-dot');
    if (swarmDot) swarmDot.classList.toggle('idle', s.activeSubagents === 0);
    const swarmLabel = this.shadow.getElementById('ao-swarm-label');
    if (swarmLabel) swarmLabel.textContent = `Swarm · ${s.activeSubagents}`;
    const swarmNames = this.shadow.getElementById('ao-swarm-names');
    if (swarmNames) {
      swarmNames.textContent =
        s.activeSubagentNames && s.activeSubagentNames.length > 0
          ? `运行中：${s.activeSubagentNames.join(' · ')}`
          : s.activeSubagents > 0
            ? `运行中：${s.activeSubagents} 个并行子代理`
            : '当前无活跃子代理';
    }
    const savedUsd = this.shadow.getElementById('ao-saved-usd');
    if (savedUsd) savedUsd.textContent = `缓存省 $${s.cacheSavedUsd.toFixed(2)}`;

    // KPI strip
    const eqWrap = this.shadow.getElementById('ao-eq-wrap');
    if (eqWrap) eqWrap.classList.toggle('active', s.activity !== 'idle');
    const tpsEl = this.shadow.getElementById('ao-tps');
    if (tpsEl) tpsEl.innerHTML = `${tpsText} <span class="muted">tok/s</span>`;
    const cacheEl = this.shadow.getElementById('ao-cache');
    if (cacheEl) cacheEl.textContent = `${cachePct}%`;
    const ttftEl = this.shadow.getElementById('ao-ttft');
    if (ttftEl) ttftEl.textContent = formatTtft(s.ttftMs);

    // Quotas
    const quotas = s.quotas && s.quotas.length > 0 ? s.quotas : DEFAULT_QUOTAS;
    const activeQuota = quotas.find((q) => q.provider === this.selectedProvider) ?? quotas[0]!;
    this.selectedProvider = activeQuota.provider;

    const provSwitch = this.shadow.getElementById('ao-prov-switch');
    if (provSwitch) {
      provSwitch.innerHTML = quotas
        .map(
          (q) =>
            `<button type="button" class="prov-btn${q.provider === activeQuota.provider ? ' active' : ''}" data-provider="${q.provider}">${q.label}</button>`,
        )
        .join('');
    }

    const qMeta = quotaStatusMeta(activeQuota.status);
    const qTitle = this.shadow.getElementById('ao-q-title');
    if (qTitle) qTitle.textContent = activeQuota.label;
    const qBadge = this.shadow.getElementById('ao-q-badge');
    if (qBadge) {
      qBadge.textContent = qMeta.text;
      qBadge.style.color = qMeta.color;
    }

    this.renderQuotaBar('ao-q5h-val', 'ao-q5h-bar', activeQuota.window5hFraction, activeQuota.window5hResetText, qMeta.grad);
    this.renderQuotaBar('ao-qwk-val', 'ao-qwk-bar', activeQuota.weeklyFraction, activeQuota.weeklyResetText, qMeta.grad);

    const compactBtn = this.shadow.getElementById('ao-compact-btn');
    if (compactBtn) {
      compactBtn.style.display = ratio >= 0.8 ? 'inline-flex' : 'none';
    }
    this.syncAnimationState();
  }

  private renderQuotaBar(
    valId: string,
    barId: string,
    fraction: number | null,
    resetText: string | null,
    grad: string,
  ): void {
    const valEl = this.shadow?.getElementById(valId);
    const barEl = this.shadow?.getElementById(barId);
    if (!valEl || !barEl) return;

    if (fraction === null || !Number.isFinite(fraction)) {
      valEl.innerHTML = `<span class="muted">--</span>`;
      barEl.style.width = '0%';
      return;
    }

    const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
    const suffix = resetText ? ` <span class="muted">· ${resetText} 后重置</span>` : '';
    valEl.innerHTML = `${pct}%${suffix}`;
    barEl.style.width = `${pct}%`;
    barEl.style.background = grad;
  }
}

window.__antigravityOrbit?.registerChannel(new HybridTelemetryHudChannel());
