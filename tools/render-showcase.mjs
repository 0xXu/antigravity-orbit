import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const desktopDistDir = path.join(rootDir, 'packages', 'desktop', 'dist');
const channelsDistDir = path.join(rootDir, 'packages', 'runtime', 'dist', 'channels');
const outDir = path.join(rootDir, 'docs', 'assets', 'screenshots');

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

function findChrome() {
  const found = CHROME_CANDIDATES.find((p) => fs.existsSync(p));
  if (!found) throw new Error('Google Chrome / Chromium not found');
  return found;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.json': 'application/json; charset=utf-8',
};

function buildMockHeatmap() {
  const days = [];
  const today = new Date('2026-11-27T00:00:00Z');
  let seed = 42;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0xffffffff;
  };
  for (let i = 181; i >= 0; i--) {
    const dt = new Date(today.getTime() - i * 86_400_000);
    const dow = dt.getUTCDay();
    const activeProb = dow === 0 || dow === 6 ? 0.45 : 0.82;
    const r = rand();
    const tokens = r < activeProb ? Math.round((0.15 + rand() * rand() * 2.8) * 1_000_000) : 0;
    const requests = tokens > 0 ? Math.max(4, Math.round(tokens / 42_000)) : 0;
    days.push({
      date: dt.toISOString().slice(0, 10),
      tokens,
      requests,
      costUsd: +(tokens * 0.00000062).toFixed(2),
    });
  }
  return days;
}

const MOCK_HEATMAP = buildMockHeatmap();

const BASE_ORBIT_CONFIG = {
  schemaVersion: 1,
  theme: 'obsidian',
  followSystemTheme: false,
  accent: 'model',
  visualBudget: 'full-optics',
  language: 'zh-CN',
  privacyMask: false,
  hud: { enabled: true, style: 'hybrid' },
  i18n: { enabled: false, autoYield: true },
  workbench: {
    enabled: true,
    codeFoldMinLines: 48,
    outlineRail: true,
    btwContextMenu: true,
    inkStreamFade: true,
    effortSlider: true,
  },
  translator: { mode: 'off', bilingual: true, translateTitles: false, endpoint: '', model: '' },
  omni: { enabled: false, inlineDiff: false, linkTarget: 'builtin' },
  chatMode: { enabled: false },
  optics: { picker3d: false, wallpaper: false, wallpaperPath: '', wallpaperOpacity: 0.28, horizonRipple: true },
  proxy: { mode: 'system', manualUrl: '' },
  autoLaunchAntigravity: false,
};

function buildDesktopMockScript(initialPage = 'overview') {
  const mockData = {
    config: { ...BASE_ORBIT_CONFIG, theme: 'crystal', i18n: { enabled: true, autoYield: true }, omni: { enabled: true, inlineDiff: true, linkTarget: 'builtin' } },
    status: {
      version: '0.1.0',
      pid: 48120,
      startedAt: '2026-11-27T01:00:00.000Z',
      cdpConnected: true,
      cdpPort: 63795,
      bareHostDetected: false,
      targets: [{ id: 'win-1', title: 'aurora-synth - Antigravity', url: 'https://127.0.0.1:63797/c/demo', isRemoteSsh: false }],
      activeChannels: ['ch01-core', 'ch02-hud', 'ch03-i18n', 'ch04-workbench', 'ch06-omni', 'ch07-inline-diff'],
      configPath: '~/Library/Application Support/Antigravity Orbit/config.json',
      ledgerPath: '~/Library/Application Support/Antigravity Orbit/usage-ledger.sqlite',
    },
    hud: {
      conversationId: 'aurora-synth-01',
      activity: 'streaming',
      turns: 36,
      currentTurnMs: 1420,
      avgTps: 218.4,
      ttftMs: 420,
      activeSubagents: 2,
      activeSubagentNames: ['ShaderVerifier', 'AudioBench'],
      totalTokens: 124_800_000,
      cacheHitRate: 0.959,
      estimatedCostUsd: 42.18,
      cacheSavedUsd: 138.64,
      contextUsed: 226_000,
      contextLimit: 512_000,
      contextEstimated: false,
      compactionCount: 1,
      currentModel: 'gemini-4-neon',
      currentRole: 'executor',
      pastModels: ['gemini-4-hydrogen', 'claude-opus-5.5'],
      isRemoteSsh: false,
      quotas: [
        { provider: 'gemini', label: 'Gemini', status: 'abundant', window5hFraction: 0.92, window5hResetText: '4h 38m', weeklyFraction: 0.74, weeklyResetText: '5d 14h' },
        { provider: 'claude', label: 'Claude / GPT', status: 'abundant', window5hFraction: 0.86, window5hResetText: '3h 15m', weeklyFraction: 0.91, weeklyResetText: '6d 2h' },
      ],
    },
    usage: {
      totalTokens: 124_800_000,
      totalRequests: 512,
      localTokens: 96_400_000,
      sshTokens: 28_400_000,
      cacheHitRate: 0.959,
      estimatedCostUsd: 42.18,
      cacheSavedUsd: 138.64,
      heatmap: MOCK_HEATMAP,
      models: [
        { model: 'gemini-4-neon', requests: 294, totalTokens: 78_200_000, estimatedCostUsd: 21.45, cacheSavedUsd: 89.2 },
        { model: 'claude-opus-5.5', requests: 126, totalTokens: 28_600_000, estimatedCostUsd: 14.82, cacheSavedUsd: 34.6 },
        { model: 'gemini-4-hydrogen', requests: 92, totalTokens: 18_000_000, estimatedCostUsd: 5.91, cacheSavedUsd: 14.84 },
      ],
    },
    quotas: [
      {
        environment: 'local',
        accountEmail: 'alex.chen@aurora.dev',
        recommendedScore: 94,
        models: [
          { modelId: 'gemini-4-neon', effectiveRemainingFraction: 0.92, windows: [{ resetAt: '2026-11-27T18:30:00Z' }] },
          { modelId: 'claude-opus-5.5', effectiveRemainingFraction: 0.86, windows: [{ resetAt: '2026-11-27T17:10:00Z' }] },
        ],
      },
      {
        environment: 'local',
        accountEmail: 'lab.backup@aurora.dev',
        recommendedScore: 99,
        models: [
          { modelId: 'gemini-4-neon', effectiveRemainingFraction: 1.0, windows: [] },
          { modelId: 'claude-opus-5.5', effectiveRemainingFraction: 0.98, windows: [] },
        ],
      },
    ],
    accounts: [
      { email: 'alex.chen@aurora.dev', nickname: '主开发账号 (Pro)', active: true, savedAt: '2026-11-18T09:00:00Z' },
      { email: 'lab.backup@aurora.dev', nickname: '高配额备用账号', active: false, savedAt: '2026-11-22T14:20:00Z' },
      { email: 'ci-bench@aurora.dev', nickname: '远程 SSH 专用', active: false, savedAt: '2026-11-25T11:45:00Z' },
    ],
    proxy: {
      mode: 'system',
      effectiveUrl: 'http://127.0.0.1:7890 (系统代理)',
      warning: null,
    },
  };

  return `<script>
    (function () {
      const DATA = ${JSON.stringify(mockData)};
      window.__TAURI_INTERNALS__ = {
        transformCallback: () => 0,
        invoke: async (cmd, args) => {
          if (cmd === 'ensure_daemon') return 'already-running';
          if (cmd === 'ipc_call') {
            const m = args?.method;
            if (m === 'config.get' || m === 'config.patch' || m === 'config.applyPreset') return DATA.config;
            if (m === 'daemon.status' || m === 'cdp.reconnect') return DATA.status;
            if (m === 'usage.summary') return DATA.usage;
            if (m === 'quota.summary') return DATA.quotas;
            if (m === 'hud.snapshot') return DATA.hud;
            if (m === 'accounts.list') return DATA.accounts;
            if (m === 'proxy.diagnose') return DATA.proxy;
          }
          return null;
        }
      };
      const PAGE_LABELS = {
        overview: '总览与配额',
        accounts: '多账号中心',
        usage: '用量与账单',
        maintenance: '运维与代理',
        appearance: '外观与视觉实验室'
      };
      let lastPage = ${JSON.stringify(initialPage)};
      window.__orbitSelectDesktopPage = (pageId) => {
        if (pageId === lastPage) return;
        lastPage = pageId;
        const label = PAGE_LABELS[pageId];
        if (!label) return;
        for (const btn of document.querySelectorAll('.nav-btn')) {
          if ((btn.textContent || '').includes(label)) {
            btn.click();
            break;
          }
        }
      };
      const targetPage = ${JSON.stringify(initialPage)};
      if (targetPage && targetPage !== 'overview') {
        window.addEventListener('DOMContentLoaded', () => {
          const tryClick = () => {
            const label = PAGE_LABELS[targetPage];
            const btn = Array.from(document.querySelectorAll('.nav-btn')).find(b => (b.textContent || '').includes(label));
            if (btn) btn.click();
            else setTimeout(tryClick, 30);
          };
          setTimeout(tryClick, 60);
        });
      }
    })();
  </script>`;
}

const THEME_SPECS = {
  obsidian: {
    mode: 'dark',
    name: '深空黑曜',
    key: 'obsidian',
    sidebarBg: '#0c0d11',
    canvasBg: '#0e0f14',
    surfaceBg: '#16171e',
    elevated: '#1d1f28',
    border: 'rgba(255,255,255,0.09)',
    text: '#f4f4f5',
    sub: '#a1a1aa',
    muted: '#71717a',
    accent: '#3b82f6',
    bubble: 'rgba(30, 34, 46, 0.92)',
    codeBg: '#0c0d12',
    chipBg: 'rgba(24, 26, 35, 0.78)',
  },
  warm: {
    mode: 'dark',
    name: '暖炭玄岩',
    key: 'warm',
    sidebarBg: '#161513',
    canvasBg: '#1c1b19',
    surfaceBg: '#23221f',
    elevated: '#2b2926',
    border: 'rgba(255,245,235,0.09)',
    text: '#f2ece4',
    sub: '#bdb3a7',
    muted: '#8c8379',
    accent: '#d97757',
    bubble: 'rgba(42, 39, 35, 0.94)',
    codeBg: '#171614',
    chipBg: 'rgba(36, 34, 30, 0.82)',
  },
  crystal: {
    mode: 'light',
    name: '白昼冷晶',
    key: 'crystal',
    sidebarBg: '#f3f5f9',
    canvasBg: '#f7f9fc',
    surfaceBg: '#ffffff',
    elevated: '#eef2f8',
    border: 'rgba(15,23,42,0.08)',
    text: '#0f172a',
    sub: '#475569',
    muted: '#64748b',
    accent: '#2563eb',
    bubble: '#ffffff',
    codeBg: '#f1f5f9',
    chipBg: 'rgba(255, 255, 255, 0.82)',
  },
  alabaster: {
    mode: 'light',
    name: '暖白画册',
    key: 'alabaster',
    sidebarBg: '#f1ece2',
    canvasBg: '#f8f5ef',
    surfaceBg: '#fcfbf7',
    elevated: '#f3efe6',
    border: 'rgba(41,37,36,0.1)',
    text: '#1c1917',
    sub: '#44403c',
    muted: '#78716c',
    accent: '#c25934',
    bubble: '#fcfbf7',
    codeBg: '#f2ede3',
    chipBg: 'rgba(252, 251, 247, 0.86)',
  },
};

const FOLDER_SVG = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" data-project-glyph="1" style="opacity:.72;flex-shrink:0"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z"/></svg>`;

function buildIdeStageHtml(themeId, opts = {}) {
  const t = THEME_SPECS[themeId] || THEME_SPECS.obsidian;
  const view = opts.view || 'conv'; // 'home' | 'conv'
  const openHud = Boolean(opts.openHud);
  const diffMode = Boolean(opts.diffMode);
  const fullEngine = Boolean(opts.fullEngine);
  const inkDemo = Boolean(opts.inkDemo);
  const isHomeInitial = view === 'home';

  return `<!doctype html>
<html lang="zh-CN" class="${t.mode === 'dark' ? 'dark' : ''}">
<head>
<meta charset="utf-8" />
<script>
  (function () {
    // Keep real WebGL2 Optics Engine & CSS running animations awake in headless capture
    try { document.hasFocus = function () { return true; }; } catch {}
    try { Object.defineProperty(document, 'hidden', { get: function () { return false; } }); } catch {}
    try { Object.defineProperty(document, 'visibilityState', { get: function () { return 'visible'; } }); } catch {}
    const origGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, attrs) {
      if (type === 'webgl2' || type === 'webgl' || type === 'experimental-webgl') {
        return origGetContext.call(this, type, Object.assign({}, attrs || {}, { preserveDrawingBuffer: true, antialias: true }));
      }
      return origGetContext.call(this, type, attrs);
    };
  })();
</script>
<style>
  :root {
    color-scheme: ${t.mode};
    --background: ${t.canvasBg};
    --content: ${t.canvasBg};
    --shell: ${t.sidebarBg};
    --sidebar: ${t.sidebarBg};
    --card: ${t.surfaceBg};
    --border: ${t.border};
    --foreground: ${t.text};
    --secondary-foreground: ${t.sub};
    --muted-foreground: ${t.muted};
    --primary: ${t.accent};
    --pb-mode: ${t.mode};
    --pb-sidebar-bg: ${t.sidebarBg};
    --pb-canvas-bg: ${t.canvasBg};
    --pb-surface-bg: ${t.surfaceBg};
    --pb-surface-elevated: ${t.elevated};
    --pb-border-subtle: ${t.border};
    --pb-text-primary: ${t.text};
    --pb-text-muted: ${t.muted};
    --pb-accent: ${t.accent};
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    width: 100%; height: 100%; overflow: hidden;
    background: var(--pb-canvas-bg);
    color: var(--pb-text-primary);
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', 'Inter', sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .shell { display: flex; width: 100%; height: 100%; position: relative; }

  /* ── Sidebar (Exact Antigravity structure so real ch01-core styles apply!) ── */
  aside.sidebar {
    width: 244px; flex-shrink: 0;
    background: var(--pb-sidebar-bg);
    border-right: 1px solid var(--pb-border-subtle);
    display: flex; flex-direction: column;
    padding: 12px 10px 12px; gap: 2px;
    position: relative; z-index: 10;
  }
  .sb-topbar {
    display: flex; align-items: center; gap: 10px;
    padding: 2px 6px 10px;
  }
  .win-dots { display: flex; gap: 7px; align-items: center; }
  .win-dots span { width: 11px; height: 11px; border-radius: 50%; display: block; }
  .win-dots span:nth-child(1) { background: #ff5f57; }
  .win-dots span:nth-child(2) { background: #febc2e; }
  .win-dots span:nth-child(3) { background: #28c840; }
  .sb-nav-icons {
    display: flex; align-items: center; gap: 9px; margin-left: 6px;
    color: var(--pb-text-muted); opacity: 0.78;
  }
  .sb-action {
    height: 30px; border-radius: 8px; padding: 0 9px;
    display: flex; align-items: center; gap: 8px;
    font-size: 12.5px; font-weight: 500; color: var(--pb-text-primary);
  }
  .sb-action svg { opacity: 0.74; flex-shrink: 0; }
  .sb-sec {
    font-size: 11px; font-weight: 600; color: var(--pb-text-muted);
    padding: 12px 9px 4px;
    display: flex; align-items: center; justify-content: space-between;
  }
  .sb-proj {
    display: flex; align-items: center; gap: 7px;
    height: 28px; padding: 0 9px;
    font-size: 12.5px; font-weight: 550; color: var(--pb-text-primary);
  }
  [data-testid="conversation-row-sidebar"] {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    padding: 6px 10px 6px 18px !important;
    margin: 1px 0;
    cursor: pointer;
    min-width: 0;
  }
  [data-testid="conversation-row-sidebar"] .truncate {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    flex: 1 1 auto; min-width: 0; font-size: 12.5px;
  }
  .sb-time {
    font-size: 11px; color: var(--pb-text-muted); flex-shrink: 0;
    font-variant-numeric: tabular-nums;
  }
  .sb-foot {
    margin-top: auto; padding: 8px 9px 2px;
    display: flex; align-items: center; justify-content: space-between;
    font-size: 12.5px; color: var(--pb-text-muted);
  }
  .sb-foot-left { display: flex; align-items: center; gap: 7px; }

  /* ── Main Stage ── */
  .stage-main {
    flex: 1; display: flex; flex-direction: column;
    position: relative; overflow: hidden;
    background: var(--pb-canvas-bg);
  }
  .stage-main > .ag-cs-ripple-host {
    position: absolute !important; inset: 0 !important;
    pointer-events: none !important; z-index: 1 !important;
  }

  /* Home Center Greeting (Exact Image 3 layout: Blue Arch Logo + single crisp greeting) */
  .home-center {
    position: absolute; inset: 0 0 180px 0;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 16px; z-index: 5; pointer-events: none;
    will-change: transform, opacity;
  }
  .home-brand-arch {
    width: 34px; height: 34px;
    display: flex; align-items: center; justify-content: center;
    filter: ${t.mode === 'dark' ? 'drop-shadow(0 6px 18px rgba(59,130,246,0.42))' : 'drop-shadow(0 4px 12px rgba(37,99,235,0.22))'};
  }
  .home-greeting-text {
    font-size: 24px; font-weight: 520; letter-spacing: -0.35px;
    color: var(--pb-text-primary);
  }

  /* Conversation Layer (Overlaid cleanly for silky crossfade transition!) */
  .conv-layer {
    position: absolute; inset: 0 0 144px 0;
    z-index: 6; display: flex; flex-direction: column;
    will-change: transform, opacity;
  }
  .conv-topbar {
    height: 44px; padding: 0 24px;
    border-bottom: 1px solid var(--pb-border-subtle);
    display: flex; align-items: center; justify-content: space-between;
    font-size: 13px; font-weight: 560;
    background: ${t.mode === 'dark' ? 'rgba(14,15,20,0.68)' : 'rgba(247,249,252,0.72)'};
    backdrop-filter: blur(12px);
  }
  .topbar-tag {
    font-size: 11px; font-weight: 500; color: var(--pb-text-muted);
    padding: 3px 10px; border-radius: 999px;
    border: 1px solid var(--pb-border-subtle);
    background: var(--pb-surface-bg);
  }
  .messages {
    flex: 1; padding: 20px 56px 12px;
    display: flex; flex-direction: column; gap: 14px;
    max-width: 920px; width: 100%; margin: 0 auto;
    overflow: hidden;
  }
  .user-bubble {
    align-self: flex-end; max-width: 78%;
    background: ${t.bubble};
    border: 1px solid var(--pb-border-subtle);
    border-radius: 14px; padding: 10px 15px;
    font-size: 13.5px; line-height: 1.55;
    box-shadow: ${t.mode === 'dark' ? '0 6px 20px rgba(0,0,0,0.28)' : '0 4px 16px rgba(15,23,42,0.06)'};
  }
  .thought-pill {
    display: inline-flex; align-items: center; gap: 7px;
    font-size: 12px; color: var(--pb-text-muted);
    padding: 4px 11px; border-radius: 999px;
    background: ${t.mode === 'dark'
      ? 'linear-gradient(90deg, rgba(59,130,246,0.16), rgba(139,92,246,0.18), rgba(56,189,248,0.14))'
      : 'linear-gradient(90deg, rgba(59,130,246,0.10), rgba(139,92,246,0.10), rgba(56,189,248,0.08))'};
    border: 1px solid ${t.mode === 'dark' ? 'rgba(147,197,253,0.28)' : 'rgba(59,130,246,0.24)'};
    box-shadow: ${t.mode === 'dark' ? '0 0 18px rgba(56,189,248,0.16)' : '0 2px 10px rgba(59,130,246,0.08)'};
    width: fit-content;
  }
  .reply {
    display: flex; flex-direction: column; gap: 10px;
    font-size: 13.5px; line-height: 1.65; color: var(--pb-text-primary);
  }
  .reply h3 { font-size: 14.5px; font-weight: 700; letter-spacing: -0.1px; }
  .reply p { color: ${t.sub}; }
  .code-card {
    background: ${t.codeBg};
    border: 1px solid var(--pb-border-subtle);
    border-radius: 11px; overflow: hidden;
    font-family: 'SF Mono', 'JetBrains Mono', ui-monospace, monospace;
    font-size: 12px; line-height: 1.55;
  }
  .code-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 6px 12px;
    border-bottom: 1px solid var(--pb-border-subtle);
    font-size: 11px; color: var(--pb-text-muted);
    background: ${t.mode === 'dark' ? 'rgba(255,255,255,0.025)' : 'rgba(15,23,42,0.025)'};
  }
  .fold-chip {
    padding: 2px 8px; border-radius: 6px;
    border: 1px solid var(--pb-border-subtle);
    background: var(--pb-surface-bg); color: ${t.sub}; font-size: 10.5px;
  }
  .code-body { padding: 10px 14px; color: ${t.sub}; white-space: pre; }
  .kw { color: ${t.mode === 'dark' ? '#93c5fd' : '#2563eb'}; }
  .fn { color: ${t.mode === 'dark' ? '#c4b5fd' : '#7c3aed'}; }
  .num { color: ${t.mode === 'dark' ? '#fbbf24' : '#d97706'}; }
  .str { color: ${t.mode === 'dark' ? '#6ee7b7' : '#059669'}; }

  .diff-card {
    background: var(--pb-surface-bg);
    border: 1px solid var(--pb-border-subtle);
    border-radius: 11px; overflow: hidden;
    font-family: 'SF Mono', ui-monospace, monospace; font-size: 11.5px;
  }
  .diff-head {
    padding: 7px 12px; display: flex; justify-content: space-between; align-items: center;
    border-bottom: 1px solid var(--pb-border-subtle); font-family: -apple-system, sans-serif;
    font-size: 12px; font-weight: 600;
  }
  .diff-line { padding: 3px 12px; white-space: pre; }
  .diff-del { background: rgba(239,68,68,0.12); color: ${t.mode === 'dark' ? '#fca5a5' : '#b91c1c'}; }
  .diff-add { background: rgba(16,185,129,0.13); color: ${t.mode === 'dark' ? '#6ee7b7' : '#047857'}; }

  .stream-seg { display: inline; }
  .stream-f0 { color: color-mix(in srgb, var(--primary) 24%, transparent); }
  .stream-f1 { color: color-mix(in srgb, var(--foreground) 38%, var(--primary) 12%); }
  .stream-f2 { color: color-mix(in srgb, var(--foreground) 64%, transparent); }
  .stream-f3 { color: color-mix(in srgb, var(--foreground) 86%, transparent); }
  .stream-f4 { color: var(--foreground); }

  /* ── Bottom Composer Dock (Exact Image 3 bottom anchoring + context chips!) ── */
  .composer-dock {
    position: absolute !important; left: 0 !important; right: 0 !important; bottom: 0 !important;
    margin: 0 !important;
    z-index: 14;
    padding: 0 56px 24px !important;
    display: flex; flex-direction: column; align-items: center;
    pointer-events: none;
  }
  .composer-column {
    width: 100%; max-width: 780px;
    display: flex; flex-direction: column; gap: 10px;
    pointer-events: auto;
  }
  .context-chips {
    display: flex; align-items: center; gap: 8px;
    will-change: transform, opacity;
  }
  .ctx-chip {
    display: inline-flex; align-items: center; gap: 6px;
    height: 29px; padding: 0 11px; border-radius: 999px;
    background: ${t.chipBg};
    border: 1px solid ${t.mode === 'dark' ? 'rgba(255,255,255,0.12)' : 'rgba(15,23,42,0.08)'};
    box-shadow: ${t.mode === 'dark' ? '0 4px 14px rgba(0,0,0,0.32)' : '0 4px 14px rgba(15,23,42,0.07)'};
    backdrop-filter: blur(12px);
    font-size: 12px; font-weight: 500; color: var(--pb-text-primary);
  }
  .ctx-chip svg { opacity: 0.72; }
  .surface-composer-card {
    position: relative;
    background: ${t.mode === 'dark' ? 'rgba(22, 23, 30, 0.90)' : 'rgba(255, 255, 255, 0.94)'};
    border: 1px solid ${t.mode === 'dark' ? 'rgba(255,255,255,0.11)' : 'rgba(15,23,42,0.09)'};
    border-radius: 16px;
    padding: 14px 15px 10px;
    backdrop-filter: blur(16px);
    box-shadow: ${t.mode === 'dark' ? '0 18px 46px rgba(0,0,0,0.48)' : '0 14px 36px rgba(15,23,42,0.10)'};
  }
  .composer-input {
    min-height: 36px; font-size: 13.5px; color: var(--pb-text-muted);
    padding: 2px 4px 10px;
  }
  .agy-composer-footer {
    display: flex; align-items: center; justify-content: space-between; gap: 6px; height: 30px;
  }
  .footer-left { display: flex; align-items: center; gap: 8px; }
  .footer-right { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
  .flex { display: inline-flex; align-items: center; }
  .circle-btn {
    width: 28px; height: 28px; border-radius: 999px;
    border: 1px solid var(--pb-border-subtle);
    background: transparent; color: ${t.sub};
    display: inline-flex; align-items: center; justify-content: center; font-size: 15px;
    cursor: pointer;
  }
  .model-pill {
    height: 28px; padding: 0 11px 0 9px; border-radius: 999px;
    border: 1px solid var(--pb-border-subtle);
    background: ${t.mode === 'dark' ? 'rgba(255,255,255,0.045)' : 'rgba(15,23,42,0.035)'};
    display: inline-flex; align-items: center; gap: 6px;
    font-size: 12.5px; font-weight: 550; color: var(--pb-text-primary);
    cursor: pointer;
  }
  .model-pill .model-label-text {
    display: inline-flex; align-items: center; gap: 5px;
  }
  .model-pill .tier { color: var(--pb-text-muted); font-weight: 450; }
  .perm-btn {
    height: 28px; padding: 0 9px; border-radius: 8px;
    border: 1px solid transparent; background: transparent;
    color: ${t.sub}; font-size: 12.5px; font-weight: 500;
    display: inline-flex; align-items: center; gap: 5px; cursor: pointer;
  }
  .icon-btn {
    width: 28px; height: 28px; border-radius: 8px;
    border: none; background: transparent; color: ${t.sub};
    display: inline-flex; align-items: center; justify-content: center;
  }
</style>
</head>
<body class="${t.mode === 'dark' ? 'theme-dark' : 'theme-light'}">
  <div class="shell">
    <aside class="sidebar">
      <div class="sb-topbar">
        <div class="win-dots"><span></span><span></span><span></span></div>
        <div class="sb-nav-icons">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M9 3v18"/></svg>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m15 18-6-6 6-6"/></svg>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m9 18 6-6-6-6"/></svg>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
        </div>
      </div>

      <div class="sb-action" data-testid="new-conversation-button">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.375 2.625a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4Z"/></svg>
        <span>新建会话</span>
      </div>
      <div class="sb-action">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/></svg>
        <span>自动化</span>
      </div>
      <div class="sb-action">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/></svg>
        <span>自定义扩展</span>
      </div>

      <div class="sb-sec"><span>项目列表</span><span style="opacity:.65">+</span></div>

      <div class="sb-proj" data-testid="project-header">${FOLDER_SVG}<span>aurora-synth</span></div>
      <div data-testid="conversation-row-sidebar" data-ag-cs-row-running="1" id="sb-running-row">
        <span class="truncate">Shader Pipeline Refactor...</span>
        <span data-testid="status-loading-spinner"><span data-agent-state-dot="1"></span></span>
      </div>

      <div class="sb-proj" data-testid="project-header">${FOLDER_SVG}<span>antigravity-orbit</span></div>
      <div data-testid="conversation-row-sidebar" data-selected="true" id="sb-selected-row">
        <span class="truncate">音频环形缓冲与边缘光晕</span>
        <span class="sb-time">now</span>
      </div>

      <div class="sb-proj" data-testid="project-header">${FOLDER_SVG}<span>shader-lab</span></div>
      <div data-testid="conversation-row-sidebar">
        <span class="truncate">WebGPU 频谱抗锯齿调优</span>
        <span class="sb-time">2h</span>
      </div>
      <div data-testid="conversation-row-sidebar">
        <span class="truncate">SQLite WAL 账本压缩策略</span>
        <span class="sb-time">1d</span>
      </div>

      <div class="sb-sec"><span>会话列表</span><span style="opacity:.65">+</span></div>
      <div data-testid="conversation-row-sidebar">
        <span class="truncate">双周期配额融合边界验证</span>
        <span class="sb-time">6h</span>
      </div>
      <div data-testid="conversation-row-sidebar">
        <span class="truncate">SSH 远程上下文探针设计</span>
        <span class="sb-time">2d</span>
      </div>

      <div class="sb-foot">
        <span class="sb-foot-left">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.604.852.997 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/></svg>
          <span>设置</span>
        </span>
        <span style="font-size:11px;opacity:.6">v0.1.0</span>
      </div>
    </aside>

    <section class="stage-main ${isHomeInitial ? 'agy-home' : ''}" id="stage-main" data-testid="${isHomeInitial ? 'home-view' : 'conversation-view'}">
      <!-- New Session Center Greeting (Exact Image 3 aesthetic) -->
      <div class="home-center" id="home-center" data-testid="home-greeting" style="opacity:${isHomeInitial ? 1 : 0};transform:translate3d(0,0,0)">
        <div class="home-brand-arch">
          <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
            <defs>
              <linearGradient id="ag-arch-g" x1="4" y1="28" x2="28" y2="4" gradientUnits="userSpaceOnUse">
                <stop offset="0%" stop-color="#2563eb"/>
                <stop offset="55%" stop-color="#3b82f6"/>
                <stop offset="100%" stop-color="#60a5fa"/>
              </linearGradient>
            </defs>
            <path d="M8.2 26.2C9.5 18.8 12.2 6.8 16 6.8C19.8 6.8 22.5 18.8 23.8 26.2C24 27.2 22.8 27.8 22 27.1C19.8 25.1 18.1 21.8 16 21.8C13.9 21.8 12.2 25.1 10 27.1C9.2 27.8 8 27.2 8.2 26.2Z" fill="url(#ag-arch-g)"/>
          </svg>
        </div>
        <div class="home-greeting-text">很高兴见到你，Orbit。接下来做什么？</div>
      </div>

      <!-- Active Conversation Layer -->
      <div class="conv-layer" id="conv-layer" style="opacity:${isHomeInitial ? 0 : 1};pointer-events:${isHomeInitial ? 'none' : 'auto'}">
        <header class="conv-topbar">
          <span>音频环形缓冲与边缘光晕 — antigravity-orbit</span>
          <span class="topbar-tag">${t.name} · Full Optics</span>
        </header>
        <div class="messages" id="conv-messages">
          <div class="user-bubble">
            帮我把音频波形渲染改成零分配环形缓冲，并加上 120Hz 节拍高光过渡。
          </div>
          <div class="thought-pill" data-testid="thinking-collapsible-trigger">
            <span>已思考 6 秒 · 分析 3 个着色器模块</span>
          </div>
          <div class="reply">
            <h3>1. 零分配环形采样缓冲与 GPU 合成</h3>
            <p id="stream-para">已将帧间波形拷贝替换为预分配 Float32Array 环形队列，在 120Hz 刷新下保持零 GC 抖动，并按能量包络平滑插值边缘光晕。</p>
            <div class="code-card">
              <div class="code-head">
                <span>src/audio/ring-visualizer.ts</span>
                <span class="fold-chip">折叠代码 (64 行)</span>
              </div>
              <div class="code-body"><span class="kw">export function</span> <span class="fn">stepRingHalo</span>(samples: Float32Array, smooth: <span class="kw">number</span>): HaloFrame {
  <span class="kw">const</span> energy = <span class="fn">computeRmsWindow</span>(samples, <span class="num">256</span>);
  <span class="kw">const</span> radius = <span class="num">1.0</span> + <span class="fn">lerp</span>(smooth, energy, <span class="num">0.18</span>) * <span class="num">0.42</span>;
  <span class="kw">return</span> { radius, glowAlpha: Math.min(<span class="num">0.92</span>, <span class="num">0.24</span> + energy * <span class="num">0.85</span>), label: <span class="str">'aurora-120hz'</span> };
}</div>
            </div>
            ${diffMode ? `
            <div class="diff-card">
              <div class="diff-head">
                <span>src/audio/ring-visualizer.ts · 安全行内 Diff</span>
                <span style="color:#10b981;font-size:11px;">+3 / -2</span>
              </div>
              <div class="diff-line diff-del">- const frame = Array.from(samples).map((v) => v * gain);</div>
              <div class="diff-line diff-del">- ctx.filter = 'blur(18px)';</div>
              <div class="diff-line diff-add">+ ringBuffer.writeWindow(samples, offset, 256);</div>
              <div class="diff-line diff-add">+ uniforms.setHalo(radius, glowAlpha); // compositor-only 0 GC</div>
            </div>` : ''}
          </div>
        </div>
      </div>

      <!-- Bottom-Anchored Composer Dock (Exact Image 3 layout + wrapped model-selector-trigger!) -->
      <div class="composer-dock" id="composer-box" data-testid="agent-input-box">
        <div class="composer-column">
          <div class="context-chips" id="context-chips" style="opacity:${isHomeInitial ? 1 : 0};max-height:${isHomeInitial ? '34px' : '0'};overflow:hidden">
            <span class="ctx-chip">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
              <span>此电脑</span><span style="opacity:.55;font-size:10px">▾</span>
            </span>
            <span class="ctx-chip">
              ${FOLDER_SVG}
              <span>antigravity-orbit</span><span style="opacity:.55;font-size:10px">▾</span>
            </span>
            <span class="ctx-chip">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/></svg>
              <span>main</span><span style="opacity:.55;font-size:10px">▾</span>
            </span>
          </div>

          <div class="surface-composer-card">
            <div class="composer-input" id="composer-input-text">How can I help you today?</div>
            <div class="agy-composer-footer">
              <div class="footer-left">
                <button class="circle-btn" type="button" aria-haspopup="menu">+</button>
                <!-- Nested flex wrapper matches real Antigravity DOM so style.css preserves full model text! -->
                <div class="flex">
                  <div class="flex">
                    <button class="model-pill" id="model-trigger" type="button" aria-haspopup="menu" data-testid="model-selector-trigger" data-model-label="Gemini 4 Neon High">
                      <span class="model-label-text"><span>Gemini 4 Neon</span><span class="tier">High</span></span>
                      <span style="opacity:.6;font-size:10px;">▾</span>
                    </button>
                  </div>
                </div>
              </div>
              <div class="footer-right">
                <button class="perm-btn" type="button" data-testid="permissions-selector-trigger">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                    <path d="M12 8v4"/><path d="M12 16h.01"/>
                  </svg>
                  <span>极速</span>
                  <span style="opacity:.6;font-size:10px;">▾</span>
                </button>
                <button class="icon-btn" type="button">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                    <rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><path d="M12 19v3"/>
                  </svg>
                </button>
                <button class="icon-btn" type="button">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
                    <path d="M4 12v-2"/><path d="M8 15V9"/><path d="M12 18V6"/><path d="M16 14v-4"/><path d="M20 12v-1"/>
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  </div>

  ${fullEngine ? `<script src="/channels/ch01-core.js"></script>` : `
  <script>
    let hudListener = null;
    window.__antigravityOrbit = {
      registerChannel(ch) { this.ch = ch; ch.mount(document); ch.setBudgetMode('full-optics'); },
      onHudUpdate(fn) { hudListener = fn; return () => {}; },
      openDesktopConsole() {},
      getConfig() { return ${JSON.stringify({ ...BASE_ORBIT_CONFIG, theme: t.key })}; },
      updateHud(s) { hudListener?.(s); }
    };
  </script>`}
  <script src="/channels/ch02-hud.js"></script>
  <script>
    const STAGE_CONFIG = ${JSON.stringify({ ...BASE_ORBIT_CONFIG, theme: t.key })};
    const BASE_HUD = {
      conversationId: 'aurora-synth-01',
      activity: 'streaming',
      turns: 36,
      currentTurnMs: 1420,
      avgTps: 218.4,
      ttftMs: 420,
      activeSubagents: 2,
      activeSubagentNames: ['ShaderVerifier', 'AudioBench'],
      totalTokens: 124800000,
      cacheHitRate: 0.959,
      estimatedCostUsd: 42.18,
      cacheSavedUsd: 138.64,
      contextUsed: 226000,
      contextLimit: 512000,
      contextEstimated: false,
      compactionCount: 0,
      currentModel: 'gemini-4-neon',
      currentRole: 'executor',
      pastModels: [],
      isRemoteSsh: false,
      quotas: [
        { provider: 'gemini', label: 'Gemini', status: 'abundant', window5hFraction: 0.92, window5hResetText: '4h 38m', weeklyFraction: 0.74, weeklyResetText: '5d 14h' },
        { provider: 'claude', label: 'Claude / GPT', status: 'abundant', window5hFraction: 0.86, window5hResetText: '3h 15m', weeklyFraction: 0.91, weeklyResetText: '6d 2h' }
      ]
    };

    if (window.__antigravityOrbit?.applyConfig) {
      window.__antigravityOrbit.applyConfig(STAGE_CONFIG);
    }
    window.__antigravityOrbit?.updateHud?.(BASE_HUD);

    const FULL_STREAM_TEXT = '已将帧间波形拷贝替换为预分配 Float32Array 环形队列，在 120Hz 刷新下保持零 GC 抖动，并按能量包络平滑插值边缘光晕。';
    const paraEl = document.getElementById('stream-para');
    function setStreamProgress(p) {
      if (!paraEl) return;
      const len = FULL_STREAM_TEXT.length;
      const shown = Math.max(8, Math.min(len, Math.floor(p * len)));
      const tail = Math.min(18, shown);
      const solidEnd = Math.max(0, shown - tail);
      let html = FULL_STREAM_TEXT.slice(0, solidEnd);
      for (let i = solidEnd; i < shown; i++) {
        const ratio = (shown - i) / tail;
        const cls = ratio > 0.8 ? 'stream-f0' : ratio > 0.6 ? 'stream-f1' : ratio > 0.4 ? 'stream-f2' : ratio > 0.2 ? 'stream-f3' : 'stream-f4';
        html += '<span class="stream-seg ' + cls + '">' + FULL_STREAM_TEXT[i] + '</span>';
      }
      paraEl.innerHTML = html;
    }

    function getHudShadow() {
      return document.getElementById('antigravity-orbit-hybrid-hud-host')?.shadowRoot || null;
    }
    function setHudOpen(open) {
      const sh = getHudShadow();
      const btn = sh?.getElementById('ao-trigger');
      const pop = sh?.getElementById('pb-popover');
      if (!btn || !pop) return;
      if (pop.classList.contains('open') !== open) btn.click();
    }
    function setHudProvider(provider) {
      const sh = getHudShadow();
      const tab = sh?.querySelector('[data-provider="' + provider + '"]');
      if (tab) tab.click();
    }

    function dispatchPointerMove(x, y) {
      const stage = document.getElementById('stage-main');
      const el = document.elementFromPoint(x, y) || stage || document.body;
      const init = { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse' };
      el.dispatchEvent(new PointerEvent('pointermove', init));
      stage?.dispatchEvent(new PointerEvent('pointermove', init));
      window.dispatchEvent(new PointerEvent('pointermove', init));
    }

    function dispatchBgRippleClick(x, y) {
      const stage = document.getElementById('stage-main');
      if (!stage) return;
      const init = { bubbles: true, cancelable: true, button: 0, buttons: 1, clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse' };
      stage.dispatchEvent(new PointerEvent('pointermove', init));
      stage.dispatchEvent(new PointerEvent('pointerdown', init));
      stage.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0 }));
    }

    if (${openHud}) {
      setTimeout(() => setHudOpen(true), 120);
    }
    if (${inkDemo}) {
      setStreamProgress(0.76);
    }

    window.__orbitStage = {
      dispatchPointerMove,
      dispatchBgRippleClick,
      setHudOpen,
      setHudProvider,
      setStreamProgress,
      updateHud(patch) {
        window.__antigravityOrbit?.updateHud?.({ ...BASE_HUD, ...patch });
      },
      setPromptText(text, isPlaceholder = false) {
        const el = document.getElementById('composer-input-text');
        if (!el) return;
        el.textContent = text;
        el.style.color = isPlaceholder ? 'var(--pb-text-muted)' : 'var(--pb-text-primary)';
      },
      setViewBlend(blend) {
        // blend: 0 = full New Session Home, 1 = full Conversation View (silky frame-accurate transition!)
        const b = Math.max(0, Math.min(1, blend));
        const home = document.getElementById('home-center');
        const chips = document.getElementById('context-chips');
        const conv = document.getElementById('conv-layer');
        if (home) {
          const hp = Math.max(0, 1 - b * 1.45);
          home.style.opacity = String(hp);
          home.style.transform = 'translate3d(0,' + (-32 * b).toFixed(2) + 'px,0) scale(' + (1 - 0.04 * b).toFixed(4) + ')';
        }
        if (chips) {
          const cp = Math.max(0, 1 - b * 1.8);
          chips.style.opacity = String(cp);
          chips.style.maxHeight = (34 * cp).toFixed(1) + 'px';
          chips.style.transform = 'translate3d(0,' + (10 * (1 - cp)).toFixed(2) + 'px,0)';
        }
        if (conv) {
          const cvp = Math.max(0, Math.min(1, (b - 0.18) / 0.82));
          conv.style.opacity = String(cvp);
          conv.style.transform = 'translate3d(0,' + (24 * (1 - cvp)).toFixed(2) + 'px,0)';
          conv.style.pointerEvents = cvp > 0.5 ? 'auto' : 'none';
        }
      },
      getAnchors() {
        const sh = getHudShadow();
        const rectOf = (el) => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2, left: r.left, top: r.top, width: r.width, height: r.height };
        };
        return {
          composer: rectOf(document.querySelector('.surface-composer-card')),
          modelBtn: rectOf(document.getElementById('model-trigger')),
          hudTrig: rectOf(sh?.getElementById('ao-trigger')),
          consoleBtn: rectOf(sh?.getElementById('ao-console-btn')),
          claudeTab: rectOf(sh?.querySelector('[data-provider="claude"]')),
        };
      },
      async triggerRichOpticsBurst() {
        const w = window.innerWidth;
        const h = window.innerHeight;
        const card = document.querySelector('.surface-composer-card');
        const cr = card ? card.getBoundingClientRect() : { left: w * 0.3, top: h * 0.72, width: w * 0.5, height: 110 };
        // Fire REAL background click shockwaves on .agy-home!
        dispatchBgRippleClick(w * 0.44, h * 0.58);
        await new Promise((r) => setTimeout(r, 110));
        dispatchBgRippleClick(w * 0.76, h * 0.64);
        await new Promise((r) => setTimeout(r, 120));
        // Sweep across composer edge so real optics-rim-canvas specular glow lights up!
        for (const f of [0.22, 0.48, 0.72]) {
          dispatchPointerMove(cr.left + cr.width * f, cr.top + cr.height - 2);
          await new Promise((r) => setTimeout(r, 70));
        }
      },
      getDiagnostics() {
        const modelBtn = document.getElementById('model-trigger');
        return {
          hasOrbitEngine: Boolean(window.__agOrbit),
          rippleCanvases: document.querySelectorAll('canvas').length,
          hudMode: document.getElementById('antigravity-orbit-hybrid-hud-host')?.getAttribute('data-hud-mode'),
          modelBtnWidth: modelBtn ? Math.round(modelBtn.getBoundingClientRect().width) : 0,
          modelBtnText: modelBtn ? modelBtn.textContent?.trim() : '',
          hasRunningRow: Boolean(document.querySelector('[data-testid="conversation-row-sidebar"][data-ag-cs-row-running="1"]')),
          hasSpinner: Boolean(document.querySelector('[data-testid="status-loading-spinner"]')),
        };
      },
    };
  </script>
</body>
</html>`;
}

/**
 * Cinema Director Stage:
 * Composes live Light (Crystal) + Dark (Obsidian) stages with:
 * - Real WebGL2 background click ripple shockwaves
 * - Silky diagonal luminous light-curtain Dark/Light transition
 * - Cinematic camera zoom/pan rig
 * - Smooth Home -> Conversation crossfade + Turbo-left HUD close-up push-in
 * - Spring-animated Tauri 2 Desktop Console reveal with smooth crossfade tabs
 * - Seamless loop back to frame 0
 */
function buildHeroCinemaHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    width: 1440px; height: 810px; overflow: hidden;
    background: #080b12;
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'PingFang SC', sans-serif;
  }
  .cinema-viewport {
    position: relative; width: 1440px; height: 810px; overflow: hidden;
  }
  #camera-rig {
    position: absolute; inset: 0;
    transform-origin: 0 0;
    will-change: transform;
  }
  .stage-layer {
    position: absolute; inset: 0; width: 1440px; height: 810px; border: none;
  }
  #layer-light { z-index: 1; }
  #layer-dark {
    z-index: 2;
    clip-path: polygon(115% 0%, 115% 0%, 115% 100%, 115% 100%);
    will-change: clip-path;
  }
  /* Luminous optical light-beam seam during Crystal -> Obsidian wipe */
  #wipe-beam {
    position: absolute; top: -120px; bottom: -120px; width: 92px;
    left: 0; z-index: 6; pointer-events: none; opacity: 0;
    transform: translate3d(1600px, 0, 0) skewX(-12deg);
    background: linear-gradient(90deg,
      rgba(56, 189, 248, 0) 0%,
      rgba(99, 102, 241, 0.34) 32%,
      rgba(224, 242, 254, 0.92) 50%,
      rgba(56, 189, 248, 0.44) 68%,
      rgba(56, 189, 248, 0) 100%);
    filter: blur(8px);
    mix-blend-mode: screen;
  }
  /* Desktop Console Overlay (Tauri 2 Native Window) */
  #console-backdrop {
    position: absolute; inset: 0; z-index: 20;
    display: flex; align-items: center; justify-content: center;
    background: rgba(6, 9, 18, 0.56);
    backdrop-filter: blur(12px);
    opacity: 0; pointer-events: none;
  }
  #console-win {
    width: 1140px; height: 686px;
    border-radius: 16px; overflow: hidden;
    border: 1px solid rgba(255,255,255,0.16);
    box-shadow: 0 40px 110px rgba(0,0,0,0.72), 0 0 0 1px rgba(59,130,246,0.18) inset;
    background: #11131a;
    display: flex; flex-direction: column;
    transform: translate3d(0, 32px, 0) scale(0.92);
    will-change: transform, opacity;
  }
  .console-titlebar {
    height: 36px; padding: 0 14px;
    background: #161923;
    border-bottom: 1px solid rgba(255,255,255,0.08);
    display: flex; align-items: center; justify-content: space-between;
    font-size: 12px; font-weight: 600; color: #cbd5e1;
  }
  .win-dots { display: flex; gap: 7px; }
  .win-dots span { width: 11px; height: 11px; border-radius: 50%; display: block; }
  .win-dots span:nth-child(1) { background: #ff5f57; }
  .win-dots span:nth-child(2) { background: #febc2e; }
  .win-dots span:nth-child(3) { background: #28c840; }
  .console-frames { position: relative; flex: 1; width: 100%; }
  .console-frames iframe {
    position: absolute; inset: 0; width: 100%; height: 100%; border: none;
    will-change: opacity, transform;
  }
  /* Seamless loop-out optical veil */
  #loop-veil {
    position: absolute; inset: 0; z-index: 40; pointer-events: none; opacity: 0;
  }
  /* Crisp Virtual Cursor + Expanding Click Shockwave Ring (inside camera rig so it tracks zoom!) */
  #v-cursor {
    position: absolute; z-index: 30; left: 0; top: 0;
    width: 24px; height: 24px; pointer-events: none;
    opacity: 0; transform: translate3d(720px, 405px, 0);
    filter: drop-shadow(0 4px 8px rgba(0,0,0,0.38));
    will-change: transform, opacity;
  }
  #click-ring {
    position: absolute; z-index: 29; left: 0; top: 0;
    width: 44px; height: 44px; margin: -22px 0 0 -22px;
    border-radius: 999px;
    border: 2px solid #38bdf8;
    box-shadow: 0 0 16px rgba(56,189,248,0.55);
    pointer-events: none; opacity: 0; transform: scale(0.35);
  }
  /* Subtle Cinema Caption Pill (top-right floating chapter indicator) */
  #chapter-pill {
    position: absolute; top: 18px; right: 22px; z-index: 35;
    display: inline-flex; align-items: center; gap: 8px;
    padding: 6px 14px; border-radius: 999px;
    background: rgba(10, 14, 26, 0.72);
    border: 1px solid rgba(255,255,255,0.16);
    backdrop-filter: blur(12px);
    color: #f8fafc; font-size: 12.5px; font-weight: 600; letter-spacing: 0.1px;
    box-shadow: 0 10px 28px rgba(0,0,0,0.28);
    will-change: opacity, transform;
  }
  #chapter-dot {
    width: 7px; height: 7px; border-radius: 999px;
    background: #38bdf8; box-shadow: 0 0 10px #38bdf8;
  }
</style>
</head>
<body>
  <div class="cinema-viewport">
    <div id="camera-rig">
      <iframe id="layer-light" class="stage-layer" src="/stage/ide?theme=crystal&view=home&full=1"></iframe>
      <iframe id="layer-dark" class="stage-layer" src="/stage/ide?theme=obsidian&view=home&full=1"></iframe>
      <div id="wipe-beam"></div>

      <svg id="v-cursor" viewBox="0 0 24 24" fill="none">
        <path d="M4 2.5L19.5 11.2L12.3 13.1L9.6 20.2L4 2.5Z" fill="#ffffff" stroke="#0f172a" stroke-width="1.6" stroke-linejoin="round"/>
      </svg>
      <div id="click-ring"></div>
    </div>

    <div id="console-backdrop">
      <div id="console-win">
        <div class="console-titlebar">
          <div class="win-dots"><span></span><span></span><span></span></div>
          <span>Antigravity Orbit · 桌面控制台</span>
          <span style="width:46px"></span>
        </div>
        <div class="console-frames">
          <iframe id="desk-overview" src="/desktop/index.html?page=overview" style="opacity:1"></iframe>
          <iframe id="desk-usage" src="/desktop/index.html?page=usage" style="opacity:0"></iframe>
          <iframe id="desk-appearance" src="/desktop/index.html?page=appearance" style="opacity:0"></iframe>
        </div>
      </div>
    </div>

    <div id="chapter-pill">
      <span id="chapter-dot"></span>
      <span id="chapter-text">白昼冷晶 · WebGL2 地平线波纹与点击激波</span>
    </div>
  </div>

  <script>
    const clamp01 = (v) => Math.max(0, Math.min(1, v));
    const easeInOutCubic = (x) => {
      const c = clamp01(x);
      return c < 0.5 ? 4 * c * c * c : 1 - Math.pow(-2 * c + 2, 3) / 2;
    };
    const easeOutQuint = (x) => 1 - Math.pow(1 - clamp01(x), 5);
    const easeOutBack = (x) => {
      const c = clamp01(x);
      const c1 = 1.35, c3 = c1 + 1;
      return 1 + c3 * Math.pow(c - 1, 3) + c1 * Math.pow(c - 1, 2);
    };
    const lerp = (a, b, t) => a + (b - a) * t;

    const lightFrame = document.getElementById('layer-light');
    const darkFrame = document.getElementById('layer-dark');
    const rig = document.getElementById('camera-rig');
    const beam = document.getElementById('wipe-beam');
    const cursor = document.getElementById('v-cursor');
    const ring = document.getElementById('click-ring');
    const backdrop = document.getElementById('console-backdrop');
    const consoleWin = document.getElementById('console-win');
    const deskOv = document.getElementById('desk-overview');
    const deskUs = document.getElementById('desk-usage');
    const deskAp = document.getElementById('desk-appearance');
    const chapText = document.getElementById('chapter-text');
    const chapDot = document.getElementById('chapter-dot');

    const PROMPT_TEXT = '帮我把音频波形渲染改成零分配环形缓冲，并加上 120Hz 节拍高光过渡。';
    const firedClicks = new Set();

    function setCamera(zoom, focusX, focusY) {
      // Keeps (focusX, focusY) centered while zooming smoothly!
      const tx = 720 - focusX * zoom;
      const ty = 405 - focusY * zoom;
      // Clamp pan so viewport edges never expose black bars
      const minTx = 1440 - 1440 * zoom;
      const minTy = 810 - 810 * zoom;
      const cx = Math.min(0, Math.max(minTx, tx));
      const cy = Math.min(0, Math.max(minTy, ty));
      rig.style.transform = 'translate3d(' + cx.toFixed(2) + 'px,' + cy.toFixed(2) + 'px,0) scale(' + zoom.toFixed(4) + ')';
    }

    function showClickRing(x, y, progress) {
      if (progress <= 0 || progress >= 1) {
        ring.style.opacity = '0';
        return;
      }
      const p = easeOutQuint(progress);
      ring.style.left = x + 'px';
      ring.style.top = y + 'px';
      ring.style.opacity = String((1 - p) * 0.95);
      ring.style.transform = 'scale(' + (0.35 + p * 1.9).toFixed(3) + ')';
    }

    function setChapter(text, color) {
      if (chapText.textContent !== text) chapText.textContent = text;
      chapDot.style.background = color;
      chapDot.style.boxShadow = '0 0 10px ' + color;
    }

    window.__cinema = {
      getDiagnostics() {
        return {
          light: lightFrame.contentWindow?.__orbitStage?.getDiagnostics?.() || null,
          dark: darkFrame.contentWindow?.__orbitStage?.getDiagnostics?.() || null,
        };
      },
      setFrame(t) {
        const L = lightFrame.contentWindow?.__orbitStage;
        const D = darkFrame.contentWindow?.__orbitStage;
        if (!L || !D) return;
        const dAnchors = D.getAnchors();
        const hudPt = dAnchors.hudTrig || { x: 1080, y: 748 };
        const consolePt = dAnchors.consoleBtn || { x: 1120, y: 696 };
        const claudePt = dAnchors.claudeTab || { x: 1110, y: 525 };
        const compRect = dAnchors.composer || { left: 452, top: 678, width: 780, height: 108 };

        // ── SCENE 1 (0.00 - 3.50s): 白昼冷晶新会话 · 从容欣赏点击背景触发真实 WebGL2 字符波纹激波 ──
        if (t < 3.5) {
          setChapter('白昼冷晶 · WebGL2 地平线波纹与点击激波', '#3b82f6');
          darkFrame.style.clipPath = 'polygon(120% 0%, 120% 0%, 120% 100%, 120% 100%)';
          beam.style.opacity = '0';
          backdrop.style.opacity = '0';
          L.setViewBlend(0);
          D.setViewBlend(0);
          D.setHudOpen(false);
          L.setHudOpen(false);
          D.setPromptText('How can I help you today?', true);

          // Gentle establishing push-in from 1.035 -> 1.00
          const camZ = lerp(1.035, 1.0, easeOutQuint(t / 1.8));
          setCamera(camZ, 780, 440);

          // Unhurried pointer glide -> Click 1 at (600, 450) @ 0.95s -> hold -> Click 2 at (1080, 470) @ 2.25s
          let cx, cy;
          if (t < 0.95) {
            const p = easeInOutCubic(t / 0.95);
            cx = lerp(480, 600, p);
            cy = lerp(370, 450, p);
          } else if (t < 1.35) {
            cx = 600; cy = 450;
          } else if (t < 2.25) {
            const p = easeInOutCubic((t - 1.35) / 0.90);
            cx = lerp(600, 1080, p);
            cy = lerp(450, 470, p) - Math.sin(p * Math.PI) * 38;
          } else if (t < 2.75) {
            cx = 1080; cy = 470;
          } else {
            const p = easeInOutCubic((t - 2.75) / 0.75);
            cx = lerp(1080, 860, p);
            cy = lerp(470, 540, p);
          }
          L.dispatchPointerMove(cx, cy);
          D.dispatchPointerMove(cx, cy);

          if (t >= 0.95 && !firedClicks.has('L1')) {
            firedClicks.add('L1');
            L.dispatchBgRippleClick(600, 450);
          }
          if (t >= 2.25 && !firedClicks.has('L2')) {
            firedClicks.add('L2');
            L.dispatchBgRippleClick(1080, 470);
          }
          if (t >= 0.95 && t < 1.48) showClickRing(600, 450, (t - 0.95) / 0.53);
          else if (t >= 2.25 && t < 2.78) showClickRing(1080, 470, (t - 2.25) / 0.53);
          else ring.style.opacity = '0';

          cursor.style.opacity = String(clamp01(t / 0.35));
          cursor.style.transform = 'translate3d(' + cx.toFixed(1) + 'px,' + cy.toFixed(1) + 'px,0)';
          return;
        }

        // ── SCENE 2 (3.50 - 6.80s): 丝滑极光斜切转场 (1.3s 慢速光幕) + 暗色点击激波 + 光学流光边框 ──
        if (t < 6.8) {
          const lt = t - 3.5;
          // 3.50 - 4.80s: Lush 1.30s diagonal luminous optical curtain sweeping right -> left!
          const wipeP = easeInOutCubic(lt / 1.30);
          const xTop = lerp(118, -18, wipeP);
          const xBot = xTop + 14;
          darkFrame.style.clipPath = 'polygon(' + xTop.toFixed(2) + '% 0%, 118% 0%, 118% 100%, ' + xBot.toFixed(2) + '% 100%)';

          const beamAlpha = wipeP > 0.02 && wipeP < 0.98 ? Math.sin(wipeP * Math.PI) : 0;
          beam.style.opacity = String((beamAlpha * 0.92).toFixed(3));
          beam.style.transform = 'translate3d(' + ((xTop / 100) * 1440 - 30).toFixed(1) + 'px,0,0) skewX(-12deg)';

          if (wipeP < 0.52) setChapter('丝滑极光转场 · 白昼冷晶 → 深空黑曜', '#818cf8');
          else setChapter('深空黑曜 · 点击激波与光学流光边框', '#38bdf8');

          backdrop.style.opacity = '0';
          D.setHudOpen(false);

          // Calm camera push toward composer as typing begins
          const pushP = easeInOutCubic((lt - 1.55) / 1.45);
          const camZ = lerp(1.0, 1.11, pushP);
          setCamera(camZ, lerp(800, 840, pushP), lerp(440, 635, pushP));

          // Cursor fires a dark-mode WebGL2 shockwave at lt=1.35s, then slowly sweeps across composer rim!
          let cx, cy;
          if (lt < 1.35) {
            const p = easeInOutCubic(lt / 1.35);
            cx = lerp(860, 760, p);
            cy = lerp(540, 470, p);
          } else if (lt < 1.65) {
            cx = 760; cy = 470;
          } else if (lt < 2.70) {
            const p = easeInOutCubic((lt - 1.65) / 1.05);
            cx = lerp(compRect.left + 120, compRect.left + compRect.width - 110, p);
            cy = compRect.top + compRect.height - 6;
          } else {
            const p = easeInOutCubic((lt - 2.70) / 0.60);
            cx = lerp(compRect.left + compRect.width - 110, compRect.left + compRect.width - 36, p);
            cy = compRect.top + compRect.height - 14;
          }
          D.dispatchPointerMove(cx, cy);

          if (lt >= 1.35 && !firedClicks.has('D1')) {
            firedClicks.add('D1');
            D.dispatchBgRippleClick(760, 470);
          }
          if (lt >= 1.35 && lt < 1.88) showClickRing(760, 470, (lt - 1.35) / 0.53);
          else ring.style.opacity = '0';

          // Natural prompt typing speed in bottom composer
          if (lt < 1.65) {
            D.setPromptText('How can I help you today?', true);
          } else {
            const tp = clamp01((lt - 1.65) / 1.05);
            const chars = Math.max(1, Math.floor(tp * PROMPT_TEXT.length));
            D.setPromptText(PROMPT_TEXT.slice(0, chars), false);
          }

          // Smooth Home -> Conversation crossfade over 0.65s (lt = 2.65..3.30)
          const blend = easeInOutCubic((lt - 2.65) / 0.65);
          D.setViewBlend(blend);
          if (blend > 0.35) D.setPromptText('How can I help you today?', true);

          cursor.style.opacity = '1';
          cursor.style.transform = 'translate3d(' + cx.toFixed(1) + 'px,' + cy.toFixed(1) + 'px,0)';
          return;
        }

        // ── SCENE 3 (6.80 - 10.60s): 对话流墨迹渐显 + 缓速镜头推近极速左侧混合 HUD 配额弹层 ──
        if (t < 10.6) {
          const lt = t - 6.8;
          darkFrame.style.clipPath = 'polygon(0% 0%, 100% 0%, 100% 100%, 0% 100%)';
          beam.style.opacity = '0';
          backdrop.style.opacity = '0';
          D.setViewBlend(1);
          D.setPromptText('How can I help you today?', true);

          setChapter(lt < 1.25 ? '流式吐字墨迹渐显 · 侧边栏运行态光轨' : '极速左侧内嵌 HUD · 双周期配额弹层', '#38bdf8');

          // Relaxed streaming ink fade & live TPS/context telemetry
          D.setStreamProgress(Math.min(1, 0.22 + lt * 0.36));
          D.updateHud({
            avgTps: +(204 + 24 * Math.sin(lt * 2.1)).toFixed(1),
            contextUsed: Math.round(214000 + lt * 8000),
          });

          // Smooth unhurried camera dolly-in onto the Turbo-left HUD & opening Quota Popover!
          const zoomIn = easeInOutCubic((lt - 0.55) / 1.15);
          const camZ = lerp(1.11, 1.32, zoomIn);
          const fx = lerp(840, 1020, zoomIn);
          const fy = lerp(635, 610, zoomIn);
          setCamera(camZ, fx, fy);

          // Relaxed cursor flow: glide to HUD trigger (1.15s) -> hold on Gemini -> click Claude/GPT (2.35s) -> hold -> click 打开控制台 (3.45s)
          let cx, cy;
          if (lt < 1.15) {
            const p = easeInOutCubic(lt / 1.15);
            cx = lerp(compRect.left + compRect.width - 36, hudPt.x, p);
            cy = lerp(compRect.top + compRect.height - 14, hudPt.y, p);
          } else if (lt < 1.65) {
            cx = hudPt.x; cy = hudPt.y;
          } else if (lt < 2.35) {
            const p = easeInOutCubic((lt - 1.65) / 0.70);
            cx = lerp(hudPt.x, claudePt.x, p);
            cy = lerp(hudPt.y, claudePt.y, p);
          } else if (lt < 2.85) {
            cx = claudePt.x; cy = claudePt.y;
          } else {
            const p = easeInOutCubic((lt - 2.85) / 0.60);
            cx = lerp(claudePt.x, consolePt.x, p);
            cy = lerp(claudePt.y, consolePt.y, p);
          }
          D.dispatchPointerMove(cx, cy);
          D.setHudOpen(lt >= 1.15);
          D.setHudProvider(lt >= 2.35 ? 'claude' : 'gemini');

          if (lt >= 1.15 && lt < 1.60) showClickRing(hudPt.x, hudPt.y, (lt - 1.15) / 0.45);
          else if (lt >= 2.35 && lt < 2.80) showClickRing(claudePt.x, claudePt.y, (lt - 2.35) / 0.45);
          else if (lt >= 3.45 && lt < 3.80) showClickRing(consolePt.x, consolePt.y, (lt - 3.45) / 0.35);
          else ring.style.opacity = '0';

          cursor.style.opacity = '1';
          cursor.style.transform = 'translate3d(' + cx.toFixed(1) + 'px,' + cy.toFixed(1) + 'px,0)';
          return;
        }

        // ── SCENE 4 (10.60 - 14.40s): 镜头缓速拉远 + Tauri 2 桌面控制台三页从容切换 -> 无缝回环 ──
        const lt = t - 10.6;
        D.setHudOpen(false);
        ring.style.opacity = '0';
        cursor.style.opacity = '0';

        // Pull camera smoothly back from 1.32 -> 1.00
        const pullP = easeOutQuint(lt / 0.75);
        setCamera(lerp(1.32, 1.0, pullP), lerp(1020, 720, pullP), lerp(610, 405, pullP));

        // Console spring entrance + smooth exit dissolve back into Scene 1 Light Crystal!
        const inP = clamp01(lt / 0.55);
        const outP = t > 13.70 ? easeInOutCubic((t - 13.70) / 0.70) : 0;
        const vis = easeOutQuint(inP) * (1 - outP);
        backdrop.style.opacity = String(vis.toFixed(3));
        const sc = lerp(0.91, 1.0, easeOutBack(inP)) - 0.04 * outP;
        const ty = lerp(34, 0, easeOutQuint(inP)) + 16 * outP;
        consoleWin.style.transform = 'translate3d(0,' + ty.toFixed(2) + 'px,0) scale(' + sc.toFixed(4) + ')';

        // Comfortable 1.15s hold on each tab + smooth 0.38s crossfade!
        const pUsage = easeInOutCubic((lt - 1.15) / 0.38);
        const pAppear = easeInOutCubic((lt - 2.35) / 0.38);
        deskOv.style.opacity = String((1 - pUsage).toFixed(3));
        deskUs.style.opacity = String((pUsage * (1 - pAppear)).toFixed(3));
        deskAp.style.opacity = String(pAppear.toFixed(3));

        if (lt < 1.25) setChapter('Tauri 2 独立桌面控制台 · 总览与双周期配额', '#3b82f6');
        else if (lt < 2.45) setChapter('SQLite 用量账本 · 26 周编码热力图', '#6366f1');
        else setChapter('外观与 11 通道视觉实验室 · 毫秒热同步', '#38bdf8');

        // Silently reset underlying stage back to Light Crystal while console is opaque for seamless loop!
        if (t > 13.10) {
          const resetP = easeInOutCubic((t - 13.10) / 0.55);
          const xTop = lerp(-18, 120, resetP);
          darkFrame.style.clipPath = 'polygon(' + xTop.toFixed(2) + '% 0%, 120% 0%, 120% 100%, ' + (xTop + 14).toFixed(2) + '% 100%)';
          if (t > 13.75) {
            D.setViewBlend(0);
            L.setViewBlend(0);
            setChapter('白昼冷晶 · WebGL2 地平线波纹与点击激波', '#3b82f6');
          }
        }
      }
    };
  </script>
</body>
</html>`;
}

function buildPosterHtml(kind, images) {
  if (kind === 'optics-engine') {
    return `<!doctype html>
<html><head><meta charset="utf-8" /><style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    width: 2400px; height: 1420px; overflow: hidden;
    background:
      radial-gradient(1280px 640px at 50% 14%, rgba(56,189,248,0.22), transparent 68%),
      radial-gradient(960px 580px at 82% 84%, rgba(139,92,246,0.20), transparent 72%),
      linear-gradient(150deg, #060912 0%, #090d18 55%, #0c1224 100%);
    padding: 46px;
    display: grid;
    grid-template-columns: 1fr 1fr;
    grid-template-rows: 1.62fr 1fr;
    gap: 30px;
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'PingFang SC', sans-serif;
  }
  .panel {
    position: relative;
    border-radius: 22px; overflow: hidden;
    border: 1px solid rgba(255,255,255,0.16);
    box-shadow: 0 36px 90px rgba(0,0,0,0.68), 0 0 0 1px rgba(56,189,248,0.14) inset;
    background: #090c14;
  }
  .panel.hero { grid-column: 1 / span 2; }
  .panel img {
    width: 100%; height: 100%; object-fit: cover; display: block;
  }
  .badge {
    position: absolute; bottom: 18px; right: 20px;
    padding: 8px 16px; border-radius: 999px;
    background: rgba(9, 13, 24, 0.86);
    border: 1px solid rgba(255,255,255,0.2);
    color: #f8fafc; font-size: 16px; font-weight: 600;
    backdrop-filter: blur(12px);
  }
</style></head>
<body>
  <div class="panel hero">
    <img src="${images.rippleDark}" style="object-position: center bottom;" />
    <span class="badge">WebGL2 地平线字符波纹 · 点击激波 · 侧边栏运行态光轨（深空黑曜）</span>
  </div>
  <div class="panel">
    <img src="${images.rippleLight}" style="object-position: center bottom;" />
    <span class="badge">白昼冷晶 · 极光折射与完整新会话底栏</span>
  </div>
  <div class="panel">
    <img src="${images.inkStream}" style="object-position: center top;" />
    <span class="badge">思考微光流 · 流式吐字墨迹渐显 · 光学流光边框</span>
  </div>
</body></html>`;
  }

  if (kind === 'palettes') {
    return `<!doctype html>
<html><head><meta charset="utf-8" /><style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    width: 2400px; height: 1100px; overflow: hidden;
    background:
      radial-gradient(960px 540px at 54% 18%, rgba(59,130,246,0.22), transparent 70%),
      radial-gradient(820px 500px at 84% 82%, rgba(217,119,87,0.16), transparent 72%),
      linear-gradient(155deg, #0b101d 0%, #090c15 55%, #0d1220 100%);
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'PingFang SC', sans-serif;
    display: flex; align-items: center; justify-content: center;
    position: relative;
  }
  .stage { position: relative; width: 2280px; height: 960px; perspective: 2200px; }
  .shot {
    position: absolute; top: 96px; width: 980px; height: 612px;
    border-radius: 18px; overflow: hidden;
    border: 1px solid rgba(255,255,255,0.14);
    box-shadow: 0 38px 90px rgba(0,0,0,0.62);
    transform-style: preserve-3d;
  }
  .shot img { width: 100%; height: 100%; display: block; object-fit: cover; }
  .s1 { left: 20px; top: 150px; transform: rotateY(15deg) scale(0.88); z-index: 1; opacity: 0.94; }
  .s2 { left: 420px; top: 122px; transform: rotateY(10deg) scale(0.94); z-index: 2; }
  .s3 { left: 860px; top: 92px; transform: rotateY(-5deg) scale(1.02); z-index: 4; box-shadow: 0 42px 100px rgba(0,0,0,0.68), 0 0 0 1px rgba(255,255,255,0.28); }
  .s4 { left: 1320px; top: 138px; transform: rotateY(-14deg) scale(0.91); z-index: 3; }

  .legend { position: absolute; bottom: 44px; left: 0; right: 0; display: flex; justify-content: center; gap: 22px; }
  .chip {
    display: inline-flex; align-items: center; gap: 10px;
    padding: 9px 18px; border-radius: 999px;
    background: rgba(15, 23, 42, 0.72);
    border: 1px solid rgba(255,255,255,0.14);
    color: #e2e8f0; font-size: 18px; font-weight: 600;
    backdrop-filter: blur(12px);
  }
  .swatch { width: 14px; height: 14px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.35); }
</style></head>
<body>
  <div class="stage">
    <div class="shot s1"><img src="${images.obsidian}" /></div>
    <div class="shot s2"><img src="${images.warm}" /></div>
    <div class="shot s3"><img src="${images.crystal}" /></div>
    <div class="shot s4"><img src="${images.alabaster}" /></div>
  </div>
  <div class="legend">
    <div class="chip"><span class="swatch" style="background:#0e0e11"></span>深空黑曜 · Obsidian</div>
    <div class="chip"><span class="swatch" style="background:#1c1b19"></span>暖炭玄岩 · Warm</div>
    <div class="chip"><span class="swatch" style="background:#e8eef6"></span>白昼冷晶 · Crystal</div>
    <div class="chip"><span class="swatch" style="background:#ebe6dc"></span>暖白画册 · Alabaster</div>
  </div>
</body></html>`;
  }

  if (kind === 'console') {
    return `<!doctype html>
<html><head><meta charset="utf-8" /><style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    width: 2400px; height: 1350px; overflow: hidden;
    background:
      radial-gradient(1000px 620px at 32% 16%, rgba(59,130,246,0.22), transparent 70%),
      radial-gradient(880px 560px at 82% 84%, rgba(99,102,241,0.18), transparent 72%),
      linear-gradient(150deg, #0b101d 0%, #090c14 55%, #0e1424 100%);
    padding: 64px;
    display: grid;
    grid-template-columns: 1.28fr 1fr;
    grid-template-rows: 1fr 1fr;
    gap: 36px;
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'PingFang SC', sans-serif;
  }
  .panel {
    position: relative;
    border-radius: 22px; overflow: hidden;
    border: 1px solid rgba(255,255,255,0.14);
    box-shadow: 0 34px 80px rgba(0,0,0,0.58);
    background: #111522;
  }
  .panel.hero { grid-row: 1 / span 2; }
  .panel img { width: 100%; height: 100%; object-fit: cover; object-position: top left; display: block; }
  .badge {
    position: absolute; bottom: 18px; right: 20px;
    padding: 7px 15px; border-radius: 999px;
    background: rgba(15, 23, 42, 0.82);
    border: 1px solid rgba(255,255,255,0.16);
    color: #f8fafc; font-size: 16px; font-weight: 600;
    backdrop-filter: blur(10px);
  }
</style></head>
<body>
  <div class="panel hero">
    <img src="${images.overview}" />
    <span class="badge">总览与双周期配额监控</span>
  </div>
  <div class="panel">
    <img src="${images.usage}" />
    <span class="badge">SQLite 用量账本 · 26 周热力图</span>
  </div>
  <div class="panel">
    <img src="${images.appearance}" />
    <span class="badge">外观与 11 通道视觉实验室</span>
  </div>
</body></html>`;
  }

  return `<!doctype html>
<html><head><meta charset="utf-8" /><style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    width: 2400px; height: 1350px; overflow: hidden;
    background:
      radial-gradient(960px 600px at 26% 24%, rgba(56,189,248,0.2), transparent 70%),
      radial-gradient(920px 560px at 80% 78%, rgba(124,58,237,0.18), transparent 72%),
      linear-gradient(150deg, #0b101d 0%, #090c14 55%, #0e1424 100%);
    padding: 64px;
    display: grid;
    grid-template-columns: 1.15fr 1fr;
    grid-template-rows: 1fr 1fr;
    gap: 36px;
    font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'PingFang SC', sans-serif;
  }
  .panel {
    position: relative;
    border-radius: 22px; overflow: hidden;
    border: 1px solid rgba(255,255,255,0.14);
    box-shadow: 0 34px 80px rgba(0,0,0,0.58);
    background: #111522;
  }
  .panel.hero { grid-row: 1 / span 2; }
  .panel img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .badge {
    position: absolute; bottom: 18px; right: 20px;
    padding: 7px 15px; border-radius: 999px;
    background: rgba(15, 23, 42, 0.82);
    border: 1px solid rgba(255,255,255,0.16);
    color: #f8fafc; font-size: 16px; font-weight: 600;
    backdrop-filter: blur(10px);
  }
</style></head>
<body>
  <div class="panel hero">
    <img src="${images.hudClose}" style="object-fit: cover; object-position: center bottom;" />
    <span class="badge">极速左侧内嵌 HUD · 实时配额弹层</span>
  </div>
  <div class="panel">
    <img src="${images.diffView}" style="object-position: center;" />
    <span class="badge">工作台代码折叠 · 安全行内 Diff</span>
  </div>
  <div class="panel">
    <img src="${images.accounts}" style="object-position: top left;" />
    <span class="badge">多账号中心 · 四阶段 WAL 原子切号</span>
  </div>
</body></html>`;
}

function startStageServer(tempShotsDir) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      const p = u.pathname;

      if (p === '/stage/hero-cinema') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(buildHeroCinemaHtml());
        return;
      }

      if (p === '/stage/ide') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          buildIdeStageHtml(u.searchParams.get('theme') || 'obsidian', {
            view: u.searchParams.get('view') || 'conv',
            openHud: u.searchParams.get('openHud') === '1',
            diffMode: u.searchParams.get('diff') === '1',
            fullEngine: u.searchParams.get('full') === '1',
            inkDemo: u.searchParams.get('ink') === '1',
          }),
        );
        return;
      }

      if (p.startsWith('/stage/poster/')) {
        const kind = p.replace('/stage/poster/', '');
        const images = {};
        for (const [k, v] of u.searchParams.entries()) images[k] = `/shots/${v}`;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(buildPosterHtml(kind, images));
        return;
      }

      if (p.startsWith('/shots/')) {
        const file = path.join(tempShotsDir, path.basename(p));
        if (fs.existsSync(file)) {
          res.writeHead(200, { 'Content-Type': 'image/png' });
          fs.createReadStream(file).pipe(res);
          return;
        }
      }

      if (p.startsWith('/channels/')) {
        const file = path.join(channelsDistDir, path.basename(p));
        if (fs.existsSync(file)) {
          res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
          fs.createReadStream(file).pipe(res);
          return;
        }
      }

      if (p === '/desktop/' || p === '/desktop/index.html') {
        const page = u.searchParams.get('page') || 'overview';
        const rawHtml = fs.readFileSync(path.join(desktopDistDir, 'index.html'), 'utf8');
        const patched = rawHtml
          .replace('</head>', `${buildDesktopMockScript(page)}\n</head>`)
          .replaceAll('"/assets/', '"/desktop/assets/');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(patched);
        return;
      }

      if (p.startsWith('/assets/')) {
        const file = path.join(desktopDistDir, p.replace(/^\//, ''));
        if (fs.existsSync(file) && fs.statSync(file).isFile()) {
          res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
          fs.createReadStream(file).pipe(res);
          return;
        }
      }

      if (p.startsWith('/desktop/')) {
        const rel = p.replace(/^\/desktop\//, '');
        const file = path.join(desktopDistDir, rel);
        if (fs.existsSync(file) && fs.statSync(file).isFile()) {
          res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
          fs.createReadStream(file).pipe(res);
          return;
        }
      }

      res.writeHead(404);
      res.end('Not Found');
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
  });
}

async function launchChromeCdp() {
  const chromeBin = findChrome();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-showcase-chrome-'));
  const proc = spawn(
    chromeBin,
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      '--use-gl=angle',
      '--use-angle=metal',
      '--enable-webgl',
      '--ignore-gpu-blocklist',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--hide-scrollbars',
      '--window-size=1440,810',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );

  const port = await new Promise((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`Chrome startup timeout: ${stderr}`)), 15_000);
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      const m = stderr.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited early (${code}): ${stderr}`));
    });
  });

  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error('No headless Chrome page target');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });

  let seq = 1;
  const pending = new Map();
  const eventWaiters = new Map();

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    } else if (msg.method && eventWaiters.has(msg.method)) {
      const list = eventWaiters.get(msg.method);
      eventWaiters.delete(msg.method);
      for (const fn of list) fn(msg.params);
    }
  };

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = seq++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });

  const waitEvent = (method, timeoutMs = 15_000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${method}`)), timeoutMs);
      const list = eventWaiters.get(method) || [];
      list.push((params) => {
        clearTimeout(timer);
        resolve(params);
      });
      eventWaiters.set(method, list);
    });

  await send('Page.enable');
  await send('Runtime.enable');
  try { await send('Emulation.setFocusEmulationEnabled', { enabled: true }); } catch {}

  async function goto(url, { width, height, scale = 1, scheme = 'dark' }) {
    await send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: scale,
      mobile: false,
    });
    await send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: scheme }],
    });
    const loaded = waitEvent('Page.loadEventFired');
    await send('Page.navigate', { url });
    await loaded;
    await new Promise((r) => setTimeout(r, 500));
  }

  async function evalJs(expression) {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    return r?.result?.value;
  }

  async function screenshot(filePath, clip = undefined) {
    const r = await send('Page.captureScreenshot', { format: 'png', clip, fromSurface: true });
    fs.writeFileSync(filePath, Buffer.from(r.data, 'base64'));
  }

  function close() {
    try { ws.close(); } catch {}
    try { proc.kill('SIGTERM'); } catch {}
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  }

  return { goto, evalJs, screenshot, close };
}

function pngToWebp(pngPath, webpPath, quality = 88) {
  execFileSync('cwebp', ['-q', String(quality), '-m', '6', '-quiet', pngPath, '-o', webpPath]);
}

function framesToAnimatedWebp(framesDir, webpPath, fps = 20, quality = 72) {
  const delayMs = Math.round(1000 / fps);
  const frameFiles = fs
    .readdirSync(framesDir)
    .filter((f) => f.endsWith('.png'))
    .sort()
    .map((f) => path.join(framesDir, f));
  execFileSync('img2webp', [
    '-loop', '0',
    '-mixed',
    '-q', String(quality),
    '-m', '4',
    '-d', String(delayMs),
    ...frameFiles,
    '-o', webpPath,
  ]);
}

function framesToSocialMp4(framesDir, mp4Path, fps = 30) {
  fs.mkdirSync(path.dirname(mp4Path), { recursive: true });
  execFileSync('ffmpeg', [
    '-y',
    '-hide_banner',
    '-loglevel', 'error',
    '-framerate', String(fps),
    '-i', path.join(framesDir, 'frame_%04d.png'),
    '-vf', 'scale=1920:1080:flags=lanczos',
    '-c:v', 'libx264',
    '-profile:v', 'high',
    '-level', '4.2',
    '-preset', 'medium',
    '-crf', '16',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    mp4Path,
  ]);
}

async function main() {
  if (!fs.existsSync(path.join(desktopDistDir, 'index.html'))) {
    throw new Error('Missing packages/desktop/dist/index.html. Run npm run build:all first.');
  }
  if (!fs.existsSync(path.join(channelsDistDir, 'ch01-core.js'))) {
    throw new Error('Missing compiled runtime channels. Run npm run build first.');
  }

  fs.mkdirSync(outDir, { recursive: true });
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-showcase-work-'));
  const tempShotsDir = path.join(tempRoot, 'shots');
  fs.mkdirSync(tempShotsDir, { recursive: true });

  const { server, baseUrl } = await startStageServer(tempShotsDir);
  const chrome = await launchChromeCdp();

  const heroOnly = process.argv.includes('--hero-only');
  const mp4Only = process.argv.includes('--mp4');

  try {
    if (!heroOnly && !mp4Only) {
    console.log('1/5 Capturing real WebGL2 Optics Engine shots (New Session + Click Ripples + Sidebar Glow + Streaming Ink)...');
    // Full Panoramic Dark Obsidian New Session (aspect 2.56:1 matches top poster panel so nothing clips!)
    await chrome.goto(`${baseUrl}/stage/ide?theme=obsidian&view=home&full=1`, {
      width: 1560,
      height: 610,
      scale: 2,
      scheme: 'dark',
    });
    await new Promise((r) => setTimeout(r, 700));
    await chrome.evalJs(`window.__orbitStage.triggerRichOpticsBurst()`);
    await new Promise((r) => setTimeout(r, 260));
    const diag = await chrome.evalJs(`window.__orbitStage.getDiagnostics()`);
    console.log('  Optics diagnostics:', JSON.stringify(diag));
    await chrome.screenshot(path.join(tempShotsDir, 'optics-ripple-dark.png'));

    // Light Crystal New Session (aspect 2.19:1 matches bottom-left poster panel so full window fits!)
    await chrome.goto(`${baseUrl}/stage/ide?theme=crystal&view=home&full=1`, {
      width: 1360,
      height: 620,
      scale: 2,
      scheme: 'light',
    });
    await new Promise((r) => setTimeout(r, 650));
    await chrome.evalJs(`window.__orbitStage.triggerRichOpticsBurst()`);
    await new Promise((r) => setTimeout(r, 260));
    await chrome.screenshot(path.join(tempShotsDir, 'optics-ripple-light.png'));

    // Conversation Thinking Shimmer + Streaming Ink Fade + Optical Rim Glow
    await chrome.goto(`${baseUrl}/stage/ide?theme=obsidian&view=conv&full=1&ink=1`, {
      width: 1360,
      height: 650,
      scale: 2,
      scheme: 'dark',
    });
    await new Promise((r) => setTimeout(r, 650));
    await chrome.evalJs(`window.__orbitStage.triggerRichOpticsBurst()`);
    await new Promise((r) => setTimeout(r, 260));
    await chrome.screenshot(path.join(tempShotsDir, 'optics-ink-stream.png'), {
      x: 244,
      y: 44,
      width: 1116,
      height: 606,
      scale: 2,
    });

    console.log('2/5 Capturing 4 theme IDE snapshots (with live WebGL2 optics + sidebar effects)...');
    for (const theme of ['obsidian', 'warm', 'crystal', 'alabaster']) {
      const scheme = theme === 'crystal' || theme === 'alabaster' ? 'light' : 'dark';
      const view = theme === 'obsidian' || theme === 'crystal' ? 'home' : 'conv';
      await chrome.goto(`${baseUrl}/stage/ide?theme=${theme}&view=${view}&full=1`, {
        width: 1280,
        height: 800,
        scale: 2,
        scheme,
      });
      await new Promise((r) => setTimeout(r, 650));
      await chrome.evalJs(`window.__orbitStage.triggerRichOpticsBurst()`);
      await new Promise((r) => setTimeout(r, 240));
      await chrome.screenshot(path.join(tempShotsDir, `theme-${theme}.png`));
    }

    console.log('3/5 Capturing real Desktop Console views & HUD/Diff closeups...');
    await chrome.goto(`${baseUrl}/desktop/index.html?page=overview`, { width: 1020, height: 990, scale: 2, scheme: 'light' });
    await new Promise((r) => setTimeout(r, 450));
    await chrome.screenshot(path.join(tempShotsDir, 'console-overview.png'));

    await chrome.goto(`${baseUrl}/desktop/index.html?page=usage`, { width: 1040, height: 640, scale: 2, scheme: 'light' });
    await new Promise((r) => setTimeout(r, 450));
    await chrome.screenshot(path.join(tempShotsDir, 'console-usage.png'));

    await chrome.goto(`${baseUrl}/desktop/index.html?page=appearance`, { width: 1040, height: 640, scale: 2, scheme: 'light' });
    await new Promise((r) => setTimeout(r, 450));
    await chrome.screenshot(path.join(tempShotsDir, 'console-appearance.png'));

    await chrome.goto(`${baseUrl}/desktop/index.html?page=accounts`, { width: 1040, height: 620, scale: 2, scheme: 'dark' });
    await new Promise((r) => setTimeout(r, 450));
    await chrome.screenshot(path.join(tempShotsDir, 'console-accounts.png'));

    await chrome.goto(`${baseUrl}/stage/ide?theme=obsidian&view=conv&full=1&openHud=1`, { width: 1280, height: 800, scale: 2, scheme: 'dark' });
    await new Promise((r) => setTimeout(r, 450));
    await chrome.screenshot(path.join(tempShotsDir, 'hud-close.png'), { x: 520, y: 215, width: 690, height: 585, scale: 2 });

    await chrome.goto(`${baseUrl}/stage/ide?theme=obsidian&view=conv&diff=1`, { width: 1280, height: 800, scale: 2, scheme: 'dark' });
    await new Promise((r) => setTimeout(r, 250));
    await chrome.screenshot(path.join(tempShotsDir, 'diff-view.png'), { x: 268, y: 185, width: 960, height: 500, scale: 2 });

    console.log('4/5 Composing 2.5K WebP posters (optics-engine, palettes, console, hud-and-workbench)...');
    const posterJobs = [
      {
        name: 'optics-engine',
        w: 2400,
        h: 1420,
        query: 'rippleDark=optics-ripple-dark.png&rippleLight=optics-ripple-light.png&inkStream=optics-ink-stream.png',
      },
      {
        name: 'palettes',
        w: 2400,
        h: 1100,
        query: 'obsidian=theme-obsidian.png&warm=theme-warm.png&crystal=theme-crystal.png&alabaster=theme-alabaster.png',
      },
      {
        name: 'console',
        w: 2400,
        h: 1350,
        query: 'overview=console-overview.png&usage=console-usage.png&appearance=console-appearance.png',
      },
      {
        name: 'hud-and-workbench',
        w: 2400,
        h: 1350,
        query: 'hudClose=hud-close.png&diffView=diff-view.png&accounts=console-accounts.png',
      },
    ];

    for (const job of posterJobs) {
      await chrome.goto(`${baseUrl}/stage/poster/${job.name}?${job.query}`, {
        width: job.w,
        height: job.h,
        scale: 1,
        scheme: 'dark',
      });
      const png = path.join(tempRoot, `${job.name}.png`);
      const webp = path.join(outDir, `${job.name}.webp`);
      await chrome.screenshot(png);
      pngToWebp(png, webp, 86);
      console.log(`  -> ${path.relative(rootDir, webp)} (${Math.round(fs.statSync(webp).size / 1024)} KB)`);
    }

    if (process.argv.includes('--stills')) {
      console.log('Skipping unified Hero Cinema WebP (--stills mode).');
      return;
    }
    }

    const fps = mp4Only ? 30 : 20;
    const scale = mp4Only ? 2 : 1;
    const totalSeconds = 14.4;
    const totalFrames = Math.round(fps * totalSeconds);
    console.log(`5/5 Rendering unified ${fps}fps Cinema Hero (${mp4Only ? '1080p Retina MP4 for social media' : 'Animated WebP'}, 14.4s relaxed pacing)...`);
    const framesDir = path.join(tempRoot, 'hero-cinema');
    fs.mkdirSync(framesDir, { recursive: true });

    await chrome.goto(`${baseUrl}/stage/hero-cinema`, {
      width: 1440,
      height: 810,
      scale,
      scheme: 'dark',
    });
    await new Promise((r) => setTimeout(r, 1100));
    const cinemaDiag = await chrome.evalJs(`window.__cinema.getDiagnostics()`);
    console.log('  Cinema diagnostics:', JSON.stringify(cinemaDiag));

    const sampleDir = process.env.ORBIT_SAMPLE_FRAMES_DIR || '';
    if (sampleDir) fs.mkdirSync(sampleDir, { recursive: true });
    const sampleSet = new Set([24, 84, 150, 195, 250]);

    for (let i = 0; i < totalFrames; i++) {
      const tSec = i / fps;
      await chrome.evalJs(`window.__cinema.setFrame(${tSec.toFixed(4)})`);
      await new Promise((r) => setTimeout(r, mp4Only ? 16 : 20)); // advance real WebGL2 rAF shockwaves & CSS animations
      const fp = path.join(framesDir, `frame_${String(i).padStart(4, '0')}.png`);
      await chrome.screenshot(fp);
      if (sampleDir && sampleSet.has(i)) {
        fs.copyFileSync(fp, path.join(sampleDir, `sample_${String(i).padStart(4, '0')}.png`));
      }
    }

    if (mp4Only) {
      const mp4Path = path.join(rootDir, 'dist', 'antigravity-orbit-showcase-1080p.mp4');
      framesToSocialMp4(framesDir, mp4Path, fps);
      console.log(`  -> ${path.relative(rootDir, mp4Path)} (${(fs.statSync(mp4Path).size / 1024 / 1024).toFixed(2)} MB)`);
    } else {
      const heroWebp = path.join(outDir, 'hero.webp');
      framesToAnimatedWebp(framesDir, heroWebp, fps, 72);
      console.log(`  -> ${path.relative(rootDir, heroWebp)} (${(fs.statSync(heroWebp).size / 1024 / 1024).toFixed(2)} MB)`);
    }
  } finally {
    chrome.close();
    server.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

await main();
