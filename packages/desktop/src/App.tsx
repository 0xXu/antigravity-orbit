import { useCallback, useEffect, useMemo, useState } from 'react';
import orbitLogoUrl from './assets/logo.png';
import {
  DEFAULT_CONFIG,
  maskEmail,
  type AccentTone,
  type AccountQuotaSummary,
  type AntigravityOrbitConfig,
  type AutoStartStatus,
  type ConsolePage,
  type DaemonStatus,
  type DeepPartial,
  type DisplayLanguage,
  type EnvironmentKind,
  type HeatmapDay,
  type HudMetricsSnapshot,
  type HudStyle,
  type IpcMethod,
  type MaintenanceCandidate,
  type MaintenanceManifest,
  type ProxyDiagnostics,
  type ProxyMode,
  type SavedAccount,
  type ThemePalette,
  type ThoughtTranslateMode,
  type UpdateCheckResult,
  type UpdateInstallResult,
  type UsageSummary,
  type VisualBudgetMode,
} from '@antigravity-orbit/shared';

function isTauriEnv(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

async function callDaemon<T>(method: IpcMethod, params?: Record<string, unknown>): Promise<T | null> {
  if (isTauriEnv()) {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke<T>('ipc_call', { method, params: params ?? {} });
  }
  return null;
}

async function ensureCoreDaemon(): Promise<void> {
  if (isTauriEnv()) {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke<string>('ensure_daemon');
  }
}

const PAGES: Array<{ id: ConsolePage; label: string; icon: string }> = [
  { id: 'overview', label: '总览与配额', icon: '◎' },
  { id: 'accounts', label: '多账号中心', icon: '◈' },
  { id: 'usage', label: '用量与账单', icon: '▦' },
  { id: 'maintenance', label: '运维与代理', icon: '⚙' },
  { id: 'appearance', label: '外观与视觉实验室', icon: '✦' },
];

const THEME_CARDS: Array<{
  id: ThemePalette;
  name: string;
  desc: string;
  bg: string;
  side: string;
  accent: string;
}> = [
  { id: 'obsidian', name: '烟熏黑曜石', desc: '深邃高对比暗色', bg: '#0c0d12', side: '#090a0e', accent: '#3b82f6' },
  { id: 'warm', name: '暖砂暮光', desc: '低蓝光暖调炭黑', bg: '#131110', side: '#0f0d0c', accent: '#f59e0b' },
  { id: 'crystal', name: '琉璃冰晶', desc: '冷冽深海蓝曜', bg: '#0b101b', side: '#080c15', accent: '#06b6d4' },
  { id: 'alabaster', name: '雪花石膏', desc: '通透日间亮色', bg: '#f6f7f9', side: '#eceef2', accent: '#2563eb' },
];

const ACCENT_TONES: Array<{ id: AccentTone; label: string; color: string }> = [
  { id: 'model', label: '跟随模型', color: 'linear-gradient(135deg,#3b82f6,#a855f7)' },
  { id: 'cobalt', label: '钴蓝', color: '#3b82f6' },
  { id: 'iris', label: '鸢尾紫', color: '#8b5cf6' },
  { id: 'amber', label: '琥珀金', color: '#f59e0b' },
  { id: 'mono', label: '极简银', color: '#a1a1aa' },
];

const BUDGET_CARDS: Array<{ id: VisualBudgetMode; title: string; desc: string }> = [
  { id: 'full-optics', title: '全光学 Full Optics', desc: '开启完整主题、微光流与 3D 光学通道' },
  { id: 'focus', title: '专注 Focus', desc: '保留实用 HUD 与工作台，关闭装饰动效' },
  { id: 'silent-eco', title: '静默节能 Silent Eco', desc: '极低内存与零 GPU，仅保留核心通道' },
];

function fmtCompact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

function fmtBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function quotaTone(fraction: number | null): 'ok' | 'warn' | 'danger' {
  if (fraction === null) return 'ok';
  if (fraction >= 0.5) return 'ok';
  if (fraction >= 0.2) return 'warn';
  return 'danger';
}

function fmtResetIso(iso: string | null): string {
  if (!iso) return '';
  const diffMs = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(diffMs) || diffMs <= 0) return '即将重置';
  const mins = Math.round(diffMs / 60_000);
  if (mins < 60) return `${mins}m 后重置`;
  const hrs = Math.floor(mins / 60);
  const remM = mins % 60;
  if (hrs < 24) return `${hrs}h ${remM}m 后重置`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h 后重置`;
}

function ActivityHeatmap({ days }: { days: readonly HeatmapDay[] }) {
  const cells = useMemo(() => {
    const map = new Map<string, HeatmapDay>();
    let maxTokens = 0;
    for (const d of days) {
      map.set(d.date, d);
      if (d.tokens > maxTokens) maxTokens = d.tokens;
    }

    const totalDays = 26 * 7;
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const out: Array<{
      week: number;
      dow: number;
      date: string;
      level: 0 | 1 | 2 | 3 | 4;
      title: string;
    }> = [];

    for (let i = totalDays - 1; i >= 0; i -= 1) {
      const dt = new Date(today.getTime() - i * 86_400_000);
      const dateStr = dt.toISOString().slice(0, 10);
      const idx = totalDays - 1 - i;
      const week = Math.floor(idx / 7);
      const dow = idx % 7;
      const hit = map.get(dateStr);
      let level: 0 | 1 | 2 | 3 | 4 = 0;
      if (hit && hit.tokens > 0 && maxTokens > 0) {
        const ratio = hit.tokens / maxTokens;
        if (ratio > 0.75) level = 4;
        else if (ratio > 0.45) level = 3;
        else if (ratio > 0.18) level = 2;
        else level = 1;
      }
      out.push({
        week,
        dow,
        date: dateStr,
        level,
        title: hit
          ? `${dateStr} · ${fmtCompact(hit.tokens)} tok · ${hit.requests} 次 · $${hit.costUsd.toFixed(2)}`
          : `${dateStr} · 无记录`,
      });
    }
    return out;
  }, [days]);

  const colors = ['var(--heat-0)', 'var(--heat-1)', 'var(--heat-2)', 'var(--heat-3)', 'var(--heat-4)'];
  const cellSize = 11;
  const gap = 3;
  const width = 26 * (cellSize + gap);
  const height = 7 * (cellSize + gap);

  return (
    <div>
      <div className="heatmap-wrap">
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="26周用量热力图">
          {cells.map((c) => (
            <rect
              key={c.date}
              className="heat-cell"
              x={c.week * (cellSize + gap)}
              y={c.dow * (cellSize + gap)}
              width={cellSize}
              height={cellSize}
              rx={2.5}
              fill={colors[c.level]}
            >
              <title>{c.title}</title>
            </rect>
          ))}
        </svg>
      </div>
      <div className="heatmap-legend">
        <span>少</span>
        {colors.map((c, idx) => (
          <span key={idx} className="heat-swatch" style={{ background: c }} />
        ))}
        <span>多</span>
      </div>
    </div>
  );
}

function ToggleRow({
  title,
  desc,
  checked,
  onToggle,
}: {
  title: string;
  desc: string;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="setting-row">
      <div>
        <div style={{ fontWeight: 550 }}>{title}</div>
        <div className="muted">{desc}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        className={`switch ${checked ? 'on' : ''}`}
        onClick={onToggle}
      />
    </div>
  );
}

export function App() {
  const isTray =
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('view') === 'tray';

  const [page, setPage] = useState<ConsolePage>('overview');
  const [config, setConfig] = useState<AntigravityOrbitConfig>(DEFAULT_CONFIG);
  const [status, setStatus] = useState<DaemonStatus | null>(null);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [quotas, setQuotas] = useState<AccountQuotaSummary[]>([]);
  const [hud, setHud] = useState<HudMetricsSnapshot | null>(null);
  const [accounts, setAccounts] = useState<SavedAccount[]>([]);
  const [proxyDiag, setProxyDiag] = useState<ProxyDiagnostics | null>(null);
  const [envFilter, setEnvFilter] = useState<EnvironmentKind | 'all'>('all');
  const [daemonError, setDaemonError] = useState<string | null>(null);
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [installingUpdate, setInstallingUpdate] = useState(false);
  const [updateMessage, setUpdateMessage] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [autoStartStatus, setAutoStartStatus] = useState<AutoStartStatus | null>(null);
  const [switchingEmail, setSwitchingEmail] = useState<string | null>(null);

  // Maintenance scanner state
  const [scanCandidates, setScanCandidates] = useState<MaintenanceCandidate[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [trashManifests, setTrashManifests] = useState<MaintenanceManifest[]>([]);
  const [scanningMaint, setScanningMaint] = useState(false);

  // Local text inputs synced from config
  const [manualProxyDraft, setManualProxyDraft] = useState('');
  const [translatorEndpointDraft, setTranslatorEndpointDraft] = useState('');
  const [translatorModelDraft, setTranslatorModelDraft] = useState('');
  const [wallpaperPathDraft, setWallpaperPathDraft] = useState('');

  const refresh = useCallback(async (): Promise<boolean> => {
    try {
      const [cfg, st, usg, q, h, accts, px, autoSt] = await Promise.all([
        callDaemon<AntigravityOrbitConfig>('config.get'),
        callDaemon<DaemonStatus>('daemon.status'),
        callDaemon<UsageSummary>('usage.summary', { environment: envFilter }),
        callDaemon<AccountQuotaSummary[]>('quota.summary'),
        callDaemon<HudMetricsSnapshot | null>('hud.snapshot'),
        callDaemon<SavedAccount[]>('accounts.list'),
        callDaemon<ProxyDiagnostics>('proxy.diagnose'),
        callDaemon<AutoStartStatus>('autostart.status'),
      ]);
      if (cfg) {
        setConfig(cfg);
        setManualProxyDraft((prev) => (prev === '' ? cfg.proxy.manualUrl : prev));
        setTranslatorEndpointDraft((prev) => (prev === '' ? cfg.translator.endpoint : prev));
        setTranslatorModelDraft((prev) => (prev === '' ? cfg.translator.model : prev));
        setWallpaperPathDraft((prev) => (prev === '' ? cfg.optics.wallpaperPath : prev));
      }
      if (st) setStatus(st);
      if (usg) setUsage(usg);
      if (q) setQuotas(q);
      if (h !== undefined) setHud(h);
      if (accts) setAccounts(accts);
      if (px) setProxyDiag(px);
      if (autoSt) setAutoStartStatus(autoSt);
      setDaemonError(null);
      return Boolean(st);
    } catch (err) {
      setStatus(null);
      setDaemonError(err instanceof Error ? err.message : String(err));
      return false;
    }
  }, [envFilter]);

  useEffect(() => {
    let cancelled = false;
    const boot = async () => {
      try {
        await ensureCoreDaemon();
      } catch (err) {
        if (!cancelled) setDaemonError(err instanceof Error ? err.message : String(err));
        return;
      }
      for (let attempt = 0; attempt < 8 && !cancelled; attempt += 1) {
        const connected = await refresh();
        if (connected || !isTauriEnv()) break;
        await new Promise((r) => setTimeout(r, 350));
      }
    };
    void boot();
    const timer = window.setInterval(() => {
      if (!cancelled) void refresh();
    }, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [refresh]);

  const patchConfig = async (patch: DeepPartial<AntigravityOrbitConfig>) => {
    const next = await callDaemon<AntigravityOrbitConfig>('config.patch', { patch });
    setConfig((prev) => next ?? { ...prev, ...(patch as Partial<AntigravityOrbitConfig>) });
  };

  const applyPreset = async (preset: VisualBudgetMode) => {
    const next = await callDaemon<AntigravityOrbitConfig>('config.applyPreset', { preset });
    if (next) setConfig(next);
  };

  const handleLaunchAntigravity = async () => {
    try {
      await ensureCoreDaemon();
      const res = await callDaemon<{ message?: string }>('antigravity.launch');
      setDaemonError(null);
      if (res?.message) setActionNotice(res.message);
      setTimeout(() => void callDaemon('cdp.reconnect').then(() => refresh()).catch(() => {}), 1500);
    } catch (err) {
      setDaemonError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleReconnectCdp = async () => {
    try {
      await ensureCoreDaemon();
      const st = await callDaemon<DaemonStatus>('cdp.reconnect');
      await refresh();
      setActionNotice(
        st?.cdpConnected
          ? `已连接 CDP :${st.cdpPort}，活跃窗口 ${st.targets.length} 个`
          : '暂未检测到开启调试端口的 Antigravity 窗口',
      );
    } catch (err) {
      setDaemonError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleEjectAll = async () => {
    try {
      await callDaemon('cdp.ejectAll');
      await refresh();
      setActionNotice('已安全卸载全部注入通道并还原 Antigravity 原生界面');
    } catch (err) {
      setDaemonError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleSafeRestart = async () => {
    try {
      setActionNotice('正在安全重启 Antigravity 并开启本地调试端口...');
      const res = await callDaemon<{ message?: string }>('antigravity.safeRestart');
      if (res?.message) setActionNotice(res.message);
      setTimeout(() => void callDaemon('cdp.reconnect').then(() => refresh()).catch(() => {}), 3500);
    } catch (err) {
      setDaemonError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCaptureCurrentAccount = async () => {
    try {
      const saved = await callDaemon<SavedAccount>('accounts.captureCurrent');
      await refresh();
      if (saved) setActionNotice(`已捕获并保存当前登录账号：${saved.email}`);
    } catch (err) {
      setDaemonError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleScanMaintenance = async () => {
    setScanningMaint(true);
    try {
      const res = await callDaemon<{
        candidates: MaintenanceCandidate[];
        manifests: MaintenanceManifest[];
      }>('maintenance.scan');
      if (res) {
        setScanCandidates(res.candidates);
        setTrashManifests(res.manifests);
        setSelectedPaths(new Set(res.candidates.filter((c) => c.safe && c.kind === 'cache').map((c) => c.path)));
        setActionNotice(`扫描完成：发现 ${res.candidates.length} 项可清理目录/缓存`);
      }
    } catch (err) {
      setDaemonError(err instanceof Error ? err.message : String(err));
    } finally {
      setScanningMaint(false);
    }
  };

  const handleCleanSelected = async () => {
    if (selectedPaths.size === 0) return;
    try {
      const manifest = await callDaemon<MaintenanceManifest>('maintenance.clean', {
        targets: Array.from(selectedPaths),
      });
      if (manifest) {
        setActionNotice(`已将 ${manifest.entries.length} 项移入可撤回回收站（批次 ${manifest.id.slice(0, 8)}）`);
      }
      await handleScanMaintenance();
    } catch (err) {
      setDaemonError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleRestoreManifest = async (manifestId: string) => {
    try {
      const res = await callDaemon<{ restored: number; skipped: number }>('maintenance.restore', {
        manifestId,
      });
      if (res) {
        setActionNotice(`恢复完成：已还原 ${res.restored} 项，跳过已重建文件 ${res.skipped} 项`);
      }
      await handleScanMaintenance();
    } catch (err) {
      setDaemonError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCheckUpdate = async () => {
    setCheckingUpdate(true);
    setUpdateMessage(null);
    try {
      await ensureCoreDaemon();
      const res = await callDaemon<UpdateCheckResult>('update.check');
      if (res) {
        setUpdateInfo(res);
        setUpdateMessage(
          res.hasUpdate
            ? `发现新版本 v${res.latestVersion}（当前 v${res.currentVersion}）`
            : `当前已是最新版本 v${res.currentVersion}`,
        );
      }
    } catch (err) {
      setUpdateMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setCheckingUpdate(false);
    }
  };

  const handleInstallUpdate = async () => {
    if (!updateInfo?.asset) return;
    setInstallingUpdate(true);
    setUpdateMessage(`正在下载 ${updateInfo.asset.name}...`);
    try {
      const res = await callDaemon<UpdateInstallResult>('update.install', {
        downloadUrl: updateInfo.asset.downloadUrl,
        fileName: updateInfo.asset.name,
      });
      if (res) setUpdateMessage(res.message);
    } catch (err) {
      setUpdateMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setInstallingUpdate(false);
    }
  };

  // --- Tray Popover View ---
  if (isTray) {
    const ctxPct =
      hud && hud.contextLimit > 0 ? Math.min(100, Math.round((hud.contextUsed / hud.contextLimit) * 100)) : 0;
    return (
      <div className="tray">
        <div className="row between">
          <div className="row" style={{ gap: 8 }}>
            <div className="brand-mark brand-mark-sm">
              <img className="brand-logo" src={orbitLogoUrl} alt="Antigravity Orbit" />
            </div>
            <strong>Antigravity Orbit</strong>
          </div>
          <span className={`pill ${status?.cdpConnected ? 'ok' : 'warn'}`}>
            <span className="status-dot" />
            {status?.cdpConnected ? `CDP :${status.cdpPort}` : '等待连接'}
          </span>
        </div>

        <div className="tray-card">
          <div className="row between">
            <span className="muted">实时配额</span>
            <span className="muted tabular">
              {hud ? `${hud.turns} 轮 · ${hud.avgTps.toFixed(0)} tok/s` : '离线'}
            </span>
          </div>
          {hud?.quotas && hud.quotas.length > 0 ? (
            hud.quotas.map((pq) => {
              const p5 = pq.window5hFraction !== null ? Math.round(pq.window5hFraction * 100) : null;
              const pw = pq.weeklyFraction !== null ? Math.round(pq.weeklyFraction * 100) : null;
              return (
                <div key={pq.provider} className="bar-block">
                  <div className="bar-head">
                    <strong>{pq.label}</strong>
                    <span className="muted tabular">
                      5h {p5 ?? '--'}% · 周 {pw ?? '--'}%
                    </span>
                  </div>
                  <div className="progress-track">
                    <div
                      className={`progress-fill ${quotaTone(pq.window5hFraction)}`}
                      style={{ width: `${p5 ?? 0}%` }}
                    />
                  </div>
                </div>
              );
            })
          ) : (
            <div className="muted">打开 Antigravity 后自动同步双周期配额</div>
          )}
        </div>

        <div className="tray-card">
          <div className="row between">
            <span className="muted">当前上下文</span>
            <span className="tabular" style={{ fontSize: 11.5 }}>
              {hud ? `${fmtCompact(hud.contextUsed)} / ${fmtCompact(hud.contextLimit)} (${ctxPct}%)` : '--'}
            </span>
          </div>
          <div className="progress-track">
            <div
              className={`progress-fill ${ctxPct >= 80 ? 'danger' : ctxPct >= 60 ? 'warn' : 'accent'}`}
              style={{ width: `${ctxPct}%` }}
            />
          </div>
          <div className="row between muted tabular" style={{ marginTop: 2 }}>
            <span>累计 {fmtCompact(usage?.totalTokens ?? 0)} tok</span>
            <span>费用 ${(usage?.estimatedCostUsd ?? 0).toFixed(2)}</span>
          </div>
        </div>

        <div className="row">
          <button className="btn primary" style={{ flex: 1 }} onClick={() => void handleLaunchAntigravity()}>
            打开 Antigravity
          </button>
          <button
            className="btn"
            onClick={() => void patchConfig({ privacyMask: !config.privacyMask })}
          >
            {config.privacyMask ? '取消遮挡' : '隐私遮挡'}
          </button>
        </div>
      </div>
    );
  }

  // --- Full 5-Page Desktop Console ---
  const totalEnvTokens = (usage?.localTokens ?? 0) + (usage?.sshTokens ?? 0);
  const localPct = totalEnvTokens > 0 ? Math.round(((usage?.localTokens ?? 0) / totalEnvTokens) * 100) : 100;
  const maxModelTokens = Math.max(1, ...(usage?.models.map((m) => m.totalTokens) ?? [1]));
  const totalSelectedBytes = scanCandidates
    .filter((c) => selectedPaths.has(c.path))
    .reduce((acc, c) => acc + c.sizeBytes, 0);

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <img className="brand-logo" src={orbitLogoUrl} alt="Antigravity Orbit" />
          </div>
          <div>
            <div className="brand-title">Antigravity Orbit</div>
            <div className="brand-ver">v{status?.version ?? '0.1.4'}</div>
          </div>
        </div>

        <nav className="sidebar-nav" aria-label="主导航">
          {PAGES.map((item) => (
            <button
              key={item.id}
              className={`nav-btn ${page === item.id ? 'active' : ''}`}
              onClick={() => setPage(item.id)}
            >
              <span className="nav-icon">{item.icon}</span>
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="muted" style={{ padding: '0 4px', fontSize: 11 }}>
            通道活跃：{status?.activeChannels.length ?? 0} / 11
          </div>
          <button className="btn primary" style={{ width: '100%' }} onClick={() => void handleLaunchAntigravity()}>
            带参启动 Antigravity
          </button>
        </div>
      </aside>

      <main className="main">
        <header className="page-header" key={`hdr-${page}`}>
          <h2 className="page-title">{PAGES.find((p) => p.id === page)?.label}</h2>
          <div className="row">
            <span
              className={`pill ${
                !status ? 'danger' : status.cdpConnected ? 'ok' : status.bareHostDetected ? 'warn' : ''
              }`}
            >
              <span className="status-dot" />
              {!status
                ? 'Core 守护进程离线'
                : status.cdpConnected
                  ? `已连接 CDP :${status.cdpPort} · ${status.targets.length} 窗口`
                  : status.bareHostDetected
                    ? '检测到无调试端口 Antigravity'
                    : 'Core 在线 · 等待 Antigravity'}
            </span>
            <button className="btn sm" onClick={() => void handleReconnectCdp()}>
              刷新同步
            </button>
          </div>
        </header>

        {daemonError && (
          <div className="banner danger">
            <span>{daemonError}</span>
            <button className="btn sm" onClick={() => void handleReconnectCdp()}>
              重试连接 Core
            </button>
          </div>
        )}

        {status?.bareHostDetected && !status.cdpConnected && (
          <div className="banner warn">
            <span>
              检测到 Antigravity 已在无调试端口状态下运行，无法挂载实时配额、HUD 与主题通道。
            </span>
            <button className="btn primary sm" onClick={() => void handleSafeRestart()}>
              安全重启以连接
            </button>
          </div>
        )}

        {actionNotice && (
          <div className="banner info">
            <span>{actionNotice}</span>
            <button className="btn sm" onClick={() => setActionNotice(null)}>
              知道了
            </button>
          </div>
        )}

        {/* 1. OVERVIEW */}
        <div key={page} className="page-stage">
        {page === 'overview' && (
          <>
            <section className="kpi-grid">
              <div className="kpi-tile">
                <div className="kpi-label">当前会话轮次 / 速度</div>
                <div className="kpi-value">{hud ? `${hud.turns} 轮` : '--'}</div>
                <div className="kpi-sub tabular">
                  {hud ? `${hud.avgTps.toFixed(1)} tok/s · 模型 ${hud.currentModel || '--'}` : '等待连接 IDE'}
                </div>
              </div>
              <div className="kpi-tile">
                <div className="kpi-label">上下文窗口占用</div>
                <div className="kpi-value">
                  {hud && hud.contextLimit > 0
                    ? `${Math.round((hud.contextUsed / hud.contextLimit) * 100)}%`
                    : '--'}
                </div>
                <div className="kpi-sub tabular">
                  {hud ? `${fmtCompact(hud.contextUsed)} / ${fmtCompact(hud.contextLimit)}` : '等待遥测'}
                </div>
              </div>
              <div className="kpi-tile">
                <div className="kpi-label">累计 Token & 缓存命中</div>
                <div className="kpi-value">{fmtCompact(usage?.totalTokens ?? 0)}</div>
                <div className="kpi-sub tabular">
                  命中率 {Math.round((usage?.cacheHitRate ?? 0) * 100)}% · 节省 $
                  {(usage?.cacheSavedUsd ?? 0).toFixed(2)}
                </div>
              </div>
              <div className="kpi-tile">
                <div className="kpi-label">等效 API 价值</div>
                <div className="kpi-value">${(usage?.estimatedCostUsd ?? 0).toFixed(2)}</div>
                <div className="kpi-sub tabular">{usage?.totalRequests ?? 0} 次调用已落盘 SQLite</div>
              </div>
            </section>

            <section className="card">
              <div className="row between" style={{ marginBottom: 12 }}>
                <div>
                  <div className="card-title">双周期配额监控（5 小时窗 + 周度池）</div>
                  <div className="card-sub">直接融合 Antigravity 实时遥测与多账号配额快照</div>
                </div>
                <span className="pill">{quotas.length} 个账号快照</span>
              </div>

              {hud?.quotas && hud.quotas.length > 0 ? (
                <div className="quota-grid">
                  {hud.quotas.map((pq) => {
                    const p5 = pq.window5hFraction !== null ? Math.round(pq.window5hFraction * 100) : null;
                    const pw = pq.weeklyFraction !== null ? Math.round(pq.weeklyFraction * 100) : null;
                    return (
                      <div key={pq.provider} className="quota-box">
                        <div className="row between">
                          <strong>{pq.label}</strong>
                          <span className={`pill ${quotaTone(pq.window5hFraction)}`}>
                            {pq.status === 'abundant'
                              ? '充裕'
                              : pq.status === 'moderate'
                                ? '适中'
                                : pq.status === 'low'
                                  ? '偏紧'
                                  : '未知'}
                          </span>
                        </div>
                        <div className="bar-block">
                          <div className="bar-head">
                            <span className="muted">5h 速率窗</span>
                            <span className="tabular">
                              <strong>{p5 !== null ? `${p5}%` : '--'}</strong>
                              {pq.window5hResetText ? ` · ${pq.window5hResetText}` : ''}
                            </span>
                          </div>
                          <div className="progress-track">
                            <div
                              className={`progress-fill ${quotaTone(pq.window5hFraction)}`}
                              style={{ width: `${p5 ?? 0}%` }}
                            />
                          </div>
                        </div>
                        <div className="bar-block">
                          <div className="bar-head">
                            <span className="muted">周度配额池</span>
                            <span className="tabular">
                              <strong>{pw !== null ? `${pw}%` : '--'}</strong>
                              {pq.weeklyResetText ? ` · ${pq.weeklyResetText}` : ''}
                            </span>
                          </div>
                          <div className="progress-track">
                            <div
                              className={`progress-fill ${quotaTone(pq.weeklyFraction)}`}
                              style={{ width: `${pw ?? 0}%` }}
                            />
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : quotas.length > 0 ? (
                <div className="quota-grid">
                  {quotas.map((q) => (
                    <div key={`${q.environment}-${q.accountEmail}`} className="quota-box">
                      <div className="row between">
                        <strong>
                          {config.privacyMask ? maskEmail(q.accountEmail) : q.accountEmail}
                        </strong>
                        <span className="pill ok">综合 {q.recommendedScore}%</span>
                      </div>
                      {q.models.slice(0, 4).map((m) => {
                        const pct =
                          m.effectiveRemainingFraction !== null
                            ? Math.round(m.effectiveRemainingFraction * 100)
                            : null;
                        const reset = m.windows[0]?.resetAt ? fmtResetIso(m.windows[0].resetAt) : '';
                        return (
                          <div key={m.modelId} className="bar-block">
                            <div className="bar-head">
                              <span className="muted">{m.modelId}</span>
                              <span className="tabular">
                                {pct !== null ? `${pct}%` : '--'} {reset && `· ${reset}`}
                              </span>
                            </div>
                            <div className="progress-track">
                              <div
                                className={`progress-fill ${quotaTone(m.effectiveRemainingFraction)}`}
                                style={{ width: `${pct ?? 0}%` }}
                              />
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="muted">等待 Antigravity 连接后自动拉取 5h 与周度配额进度。</p>
              )}
            </section>

            <section className="card">
              <div className="row between" style={{ marginBottom: 10 }}>
                <div>
                  <div className="card-title">快捷控制与版本更新</div>
                  <div className="card-sub">
                    零入侵 CDP 通道可随时一键卸载还原，支持在线检查 GitHub Release
                  </div>
                </div>
              </div>
              <div className="row">
                <button className="btn" onClick={() => void handleReconnectCdp()}>
                  重新扫描 CDP
                </button>
                <button className="btn" onClick={() => void handleEjectAll()}>
                  卸载还原界面
                </button>
                <button
                  className="btn"
                  onClick={() => void patchConfig({ privacyMask: !config.privacyMask })}
                >
                  {config.privacyMask ? '隐私遮挡：开启' : '隐私遮挡：关闭'}
                </button>
                <button
                  className="btn"
                  disabled={checkingUpdate || installingUpdate}
                  onClick={() => void handleCheckUpdate()}
                >
                  {checkingUpdate ? '检查中...' : '检查更新'}
                </button>
                {updateInfo?.hasUpdate && updateInfo.asset && (
                  <button
                    className="btn primary"
                    disabled={installingUpdate}
                    onClick={() => void handleInstallUpdate()}
                  >
                    {installingUpdate ? '下载中...' : `一键更新 v${updateInfo.latestVersion}`}
                  </button>
                )}
              </div>
              {updateMessage && (
                <p className="muted" style={{ marginTop: 10 }}>
                  {updateMessage}
                </p>
              )}
            </section>
          </>
        )}

        {/* 2. ACCOUNTS */}
        {page === 'accounts' && (
          <section className="card">
            <div className="row between" style={{ marginBottom: 14 }}>
              <div>
                <div className="card-title">多账号安全管理（四阶段 WAL 原子切号）</div>
                <div className="card-sub">
                  自动安全退出 Antigravity → 原子写入统一状态库与系统钥匙串 → 自动带参重启生效（异常自动回滚）
                </div>
              </div>
              <button className="btn primary" onClick={() => void handleCaptureCurrentAccount()}>
                + 一键抓取当前登录账号
              </button>
            </div>
            {accounts.length === 0 ? (
              <p className="muted">
                暂无已保存账号。点击右上角即可直接从本机 Antigravity 的 state.vscdb 安全捕获当前账号。
              </p>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {accounts.map((a) => {
                  const matchedQuota = quotas.find((q) => q.accountEmail === a.email);
                  return (
                    <div key={a.email} className="list-item">
                      <div>
                        <div className="row" style={{ gap: 8 }}>
                          <strong>{config.privacyMask ? '•••' : a.nickname}</strong>
                          <span className={`pill ${a.active ? 'ok' : ''}`}>
                            {a.active ? '当前活跃' : '备用'}
                          </span>
                          {matchedQuota && (
                            <span className="pill">推荐度 {matchedQuota.recommendedScore}%</span>
                          )}
                        </div>
                        <div className="muted" style={{ marginTop: 3 }}>
                          {config.privacyMask ? maskEmail(a.email) : a.email} · 保存于{' '}
                          {new Date(a.savedAt).toLocaleDateString()}
                        </div>
                      </div>
                      <div className="row">
                        {!a.active && (
                          <button
                            className="btn sm primary"
                            disabled={switchingEmail !== null}
                            onClick={async () => {
                              setDaemonError(null);
                              setSwitchingEmail(a.email);
                              setActionNotice(`正在自动安全退出 Antigravity 并原子切换至 ${a.email}...`);
                              try {
                                const res = await callDaemon<{ restarted?: boolean; keychainSynced?: boolean }>(
                                  'accounts.switch',
                                  { email: a.email, autoRestart: true },
                                );
                                setActionNotice(
                                  res?.restarted
                                    ? `已原子切换至 ${a.email}${res.keychainSynced ? '（已同步钥匙串）' : ''}，正在自动重启并重连 Antigravity...`
                                    : `已原子切换至 ${a.email}${res?.keychainSynced ? '（已同步钥匙串）' : ''}，请启动 Antigravity 生效`,
                                );
                                await refresh();
                                setTimeout(() => void refresh(), 2500);
                              } catch (e) {
                                setDaemonError(e instanceof Error ? e.message : String(e));
                              } finally {
                                setSwitchingEmail(null);
                              }
                            }}
                          >
                            {switchingEmail === a.email ? '切换中...' : '一键原子切换'}
                          </button>
                        )}
                        <button
                          className="btn sm danger"
                          onClick={() =>
                            void callDaemon('accounts.delete', { email: a.email }).then(() => refresh())
                          }
                        >
                          删除
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        )}

        {/* 3. USAGE & BILLING */}
        {page === 'usage' && (
          <>
            <section className="card">
              <div className="row between" style={{ marginBottom: 14 }}>
                <div>
                  <div className="card-title">本机 + SSH 统一用量账本</div>
                  <div className="card-sub">自动按 (trajectory_id, execution_id) 去重并折叠思考档位</div>
                </div>
                <div className="row">
                  {(['all', 'local', 'ssh'] as const).map((env) => (
                    <button
                      key={env}
                      className={`btn sm ${envFilter === env ? 'primary' : ''}`}
                      onClick={() => setEnvFilter(env)}
                    >
                      {env === 'all' ? '全部环境' : env === 'local' ? '仅本机' : '仅 SSH'}
                    </button>
                  ))}
                </div>
              </div>

              <div className="kpi-grid">
                <div className="kpi-tile">
                  <div className="kpi-label">总 Token 消耗</div>
                  <div className="kpi-value">{fmtCompact(usage?.totalTokens ?? 0)}</div>
                  <div className="kpi-sub tabular">{usage?.totalRequests ?? 0} 次请求</div>
                </div>
                <div className="kpi-tile">
                  <div className="kpi-label">Prompt 缓存命中率</div>
                  <div className="kpi-value">{Math.round((usage?.cacheHitRate ?? 0) * 100)}%</div>
                  <div className="kpi-sub tabular">节省 ${(usage?.cacheSavedUsd ?? 0).toFixed(4)}</div>
                </div>
                <div className="kpi-tile">
                  <div className="kpi-label">等效 API 费用</div>
                  <div className="kpi-value">${(usage?.estimatedCostUsd ?? 0).toFixed(4)}</div>
                  <div className="kpi-sub">含阶梯上下文定价</div>
                </div>
                <div className="kpi-tile">
                  <div className="kpi-label">本机 / SSH 占比</div>
                  <div className="kpi-value">
                    {localPct}% / {100 - localPct}%
                  </div>
                  <div className="progress-track" style={{ marginTop: 6 }}>
                    <div className="progress-fill accent" style={{ width: `${localPct}%` }} />
                  </div>
                </div>
              </div>
            </section>

            <section className="card">
              <div className="row between" style={{ marginBottom: 10 }}>
                <div>
                  <div className="card-title">26 周编码活跃热力图</div>
                  <div className="card-sub">悬停任意方格查看当日 Token、请求数与等效费用</div>
                </div>
              </div>
              <ActivityHeatmap days={usage?.heatmap ?? []} />
            </section>

            <section className="card">
              <div className="card-title" style={{ marginBottom: 10 }}>
                按模型族费用与 Token 分布
              </div>
              {!usage || usage.models.length === 0 ? (
                <p className="muted">暂无用量记录。连接 Antigravity 对话后将自动采集。</p>
              ) : (
                usage.models.map((m) => {
                  const pct = Math.max(4, Math.round((m.totalTokens / maxModelTokens) * 100));
                  return (
                    <div key={m.model} className="model-row">
                      <div className="row between">
                        <strong>
                          {m.model} <span className="muted">({m.requests} 次)</span>
                        </strong>
                        <span className="tabular muted">
                          {fmtCompact(m.totalTokens)} tok · ${m.estimatedCostUsd.toFixed(4)} · 省 $
                          {m.cacheSavedUsd.toFixed(2)}
                        </span>
                      </div>
                      <div className="progress-track">
                        <div className="progress-fill accent" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })
              )}
            </section>
          </>
        )}

        {/* 4. MAINTENANCE & PROXY */}
        {page === 'maintenance' && (
          <>
            <section className="card">
              <div className="row between" style={{ marginBottom: 12 }}>
                <div>
                  <div className="card-title">后台常驻与无感接管</div>
                  <div className="card-sub">
                    关闭窗口自动隐藏到顶部菜单栏托盘保持后台运行，直接打开官方 Antigravity 也能自动生效
                  </div>
                </div>
                <span className={`pill ${autoStartStatus?.enabled ? 'ok' : ''}`}>
                  {autoStartStatus?.enabled ? '已开启开机驻留' : '未开启开机驻留'}
                </span>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div className="list-item">
                  <div>
                    <strong>独立后台守护服务（退出控制台后仍持续生效）</strong>
                    <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                      由系统后台服务（macOS launchd）独立托管 Core 守护进程：开机自启、即使完全退出 Orbit 控制台窗口，直接打开 Antigravity 也会自动生效
                    </div>
                  </div>
                  <button
                    className={`btn sm ${autoStartStatus?.enabled ? 'primary' : ''}`}
                    disabled={autoStartStatus?.supported === false}
                    onClick={async () => {
                      try {
                        const nextEnabled = !(autoStartStatus?.enabled ?? config.autoStartOnLogin);
                        const res = await callDaemon<AutoStartStatus>('autostart.set', { enabled: nextEnabled });
                        if (res) setAutoStartStatus(res);
                        setTimeout(() => void refresh(), 500);
                        setActionNotice(
                          nextEnabled
                            ? '已开启独立后台守护服务：现在即使完全退出 Orbit 控制台，直接打开 Antigravity 也会自动接管生效'
                            : '已关闭独立后台守护服务',
                        );
                      } catch (err) {
                        setDaemonError(err instanceof Error ? err.message : String(err));
                      }
                    }}
                  >
                    {autoStartStatus?.enabled ? '已开启' : '开启'}
                  </button>
                </div>

                <div className="list-item">
                  <div>
                    <strong>直接打开 Antigravity 时自动带参接管</strong>
                    <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                      后台检测到无调试端口的裸启动 Antigravity 时，自动安全重启一次并开启本地 CDP 注入（含 30 秒防循环冷却）
                    </div>
                  </div>
                  <button
                    className={`btn sm ${config.autoAttachBareHost ? 'primary' : ''}`}
                    onClick={() =>
                      void patchConfig({ autoAttachBareHost: !config.autoAttachBareHost }).then(refresh)
                    }
                  >
                    {config.autoAttachBareHost ? '已开启' : '已关闭'}
                  </button>
                </div>

                <div className="list-item">
                  <div>
                    <strong>启动 Orbit 时自动带参拉起 Antigravity</strong>
                    <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                      若 Antigravity 尚未运行，打开 Antigravity Orbit 时自动为其注入调试参数并启动
                    </div>
                  </div>
                  <button
                    className={`btn sm ${config.autoLaunchAntigravity ? 'primary' : ''}`}
                    onClick={() =>
                      void patchConfig({ autoLaunchAntigravity: !config.autoLaunchAntigravity }).then(refresh)
                    }
                  >
                    {config.autoLaunchAntigravity ? '已开启' : '已关闭'}
                  </button>
                </div>
              </div>
            </section>

            <section className="card">
              <div className="row between" style={{ marginBottom: 12 }}>
                <div>
                  <div className="card-title">可撤回存储维护（仅限安全缓存与大体积会话库）</div>
                  <div className="card-sub">
                    自动锁定 state.vscdb / Cookies / 密钥目录，清理前必须退出 Antigravity，随时可按 inode 还原
                  </div>
                </div>
                <div className="row">
                  <button
                    className="btn"
                    disabled={scanningMaint}
                    onClick={() => void handleScanMaintenance()}
                  >
                    {scanningMaint ? '扫描中...' : '扫描可清理缓存'}
                  </button>
                  <button
                    className="btn primary"
                    disabled={selectedPaths.size === 0}
                    onClick={() => void handleCleanSelected()}
                  >
                    移入可逆回收站 ({selectedPaths.size} · {fmtBytes(totalSelectedBytes)})
                  </button>
                </div>
              </div>

              {scanCandidates.length === 0 ? (
                <p className="muted">
                  点击右上角「扫描可清理缓存」检测 GPUCache、Code Cache、DawnWebGPUCache 与大体积会话数据库。
                </p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {scanCandidates.map((c) => {
                    const checked = selectedPaths.has(c.path);
                    return (
                      <label key={c.path} className="list-item" style={{ cursor: 'pointer' }}>
                        <div className="row" style={{ gap: 10 }}>
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => {
                              setSelectedPaths((prev) => {
                                const next = new Set(prev);
                                if (next.has(c.path)) next.delete(c.path);
                                else next.add(c.path);
                                return next;
                              });
                            }}
                          />
                          <div>
                            <div className="row" style={{ gap: 8 }}>
                              <strong>{c.label}</strong>
                              <span className={`pill ${c.kind === 'cache' ? 'ok' : 'warn'}`}>
                                {c.kind === 'cache' ? '安全缓存' : '会话库'}
                              </span>
                            </div>
                            <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
                              {c.path}
                            </div>
                          </div>
                        </div>
                        <strong className="tabular">{fmtBytes(c.sizeBytes)}</strong>
                      </label>
                    );
                  })}
                </div>
              )}

              {trashManifests.length > 0 && (
                <div style={{ marginTop: 16 }}>
                  <div className="card-title" style={{ marginBottom: 8 }}>
                    可撤回回收站历史 ({trashManifests.length})
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {trashManifests.map((m) => (
                      <div key={m.id} className="list-item">
                        <div>
                          <strong>批次 {m.id.slice(0, 8)}</strong>{' '}
                          <span className="muted">
                            · {m.entries.length} 项 ·{' '}
                            {fmtBytes(m.entries.reduce((a, e) => a + e.sizeBytes, 0))} ·{' '}
                            {new Date(m.createdAt).toLocaleString()}
                          </span>
                        </div>
                        {m.restoredAt ? (
                          <span className="pill ok">已还原</span>
                        ) : (
                          <button
                            className="btn sm"
                            onClick={() => void handleRestoreManifest(m.id)}
                          >
                            一键恢复
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </section>

            <section className="card">
              <div className="card-title" style={{ marginBottom: 4 }}>
                免 TUN HTTP(S) 代理注入与冲突诊断
              </div>
              <div className="card-sub" style={{ marginBottom: 12 }}>
                带参启动 Antigravity 时自动注入 --proxy-server，并检测 Shell 环境变量冲突
              </div>
              <div className="row" style={{ marginBottom: 12 }}>
                {(['off', 'system', 'manual'] as ProxyMode[]).map((m) => (
                  <button
                    key={m}
                    className={`btn ${config.proxy.mode === m ? 'primary' : ''}`}
                    onClick={() => void patchConfig({ proxy: { mode: m } }).then(refresh)}
                  >
                    {m === 'off' ? '直连关闭' : m === 'system' ? '跟随系统代理' : '手动代理'}
                  </button>
                ))}
              </div>
              {config.proxy.mode === 'manual' && (
                <div className="row" style={{ marginBottom: 12 }}>
                  <input
                    className="input"
                    placeholder="http://127.0.0.1:7890"
                    value={manualProxyDraft}
                    onChange={(e) => setManualProxyDraft(e.target.value)}
                  />
                  <button
                    className="btn primary"
                    onClick={() =>
                      void patchConfig({ proxy: { manualUrl: manualProxyDraft } }).then(refresh)
                    }
                  >
                    保存代理地址
                  </button>
                </div>
              )}
              <div className="row">
                <span className="pill">当前生效：{proxyDiag?.effectiveUrl ?? '直连'}</span>
                {proxyDiag?.warning && <span className="pill warn">{proxyDiag.warning}</span>}
              </div>
            </section>
          </>
        )}

        {/* 5. APPEARANCE & VISUAL LAB */}
        {page === 'appearance' && (
          <>
            <section className="card">
              <div className="card-title" style={{ marginBottom: 10 }}>
                光学主题调色板（实时同步至 Antigravity 主窗口）
              </div>
              <div className="theme-grid" style={{ marginBottom: 16 }}>
                {THEME_CARDS.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className={`theme-card ${config.theme === t.id ? 'active' : ''}`}
                    onClick={() => void patchConfig({ theme: t.id })}
                  >
                    <div className="theme-preview">
                      <div style={{ width: '28%', background: t.side }} />
                      <div
                        style={{
                          flex: 1,
                          background: t.bg,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'flex-end',
                          paddingRight: 8,
                        }}
                      >
                        <span
                          style={{
                            width: 14,
                            height: 14,
                            borderRadius: 999,
                            background: t.accent,
                          }}
                        />
                      </div>
                    </div>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 12.5 }}>{t.name}</div>
                      <div className="muted" style={{ fontSize: 11 }}>
                        {t.desc}
                      </div>
                    </div>
                  </button>
                ))}
              </div>

              <div className="row between" style={{ marginBottom: 16 }}>
                <div>
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>强调色 Accent</div>
                  <div className="row" style={{ gap: 10 }}>
                    {ACCENT_TONES.map((a) => (
                      <button
                        key={a.id}
                        type="button"
                        title={a.label}
                        className={`accent-dot ${config.accent === a.id ? 'active' : ''}`}
                        style={{ background: a.color }}
                        onClick={() => void patchConfig({ accent: a.id })}
                      />
                    ))}
                  </div>
                </div>
                <div>
                  <div style={{ fontWeight: 600, marginBottom: 6 }}>HUD 形态</div>
                  <div className="row">
                    {(['hybrid', 'capsules', 'vial'] as HudStyle[]).map((style) => (
                      <button
                        key={style}
                        className={`btn sm ${config.hud.style === style ? 'primary' : ''}`}
                        onClick={() => void patchConfig({ hud: { style } })}
                      >
                        {style === 'hybrid' ? '融合条' : style === 'capsules' ? '胶囊' : '液柱'}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div style={{ fontWeight: 600, marginBottom: 8 }}>性能与视觉预算档位</div>
              <div className="budget-grid">
                {BUDGET_CARDS.map((b) => (
                  <button
                    key={b.id}
                    type="button"
                    className={`theme-card ${config.visualBudget === b.id ? 'active' : ''}`}
                    onClick={() => void applyPreset(b.id)}
                  >
                    <div style={{ fontWeight: 600, fontSize: 12.5 }}>{b.title}</div>
                    <div className="muted" style={{ fontSize: 11 }}>
                      {b.desc}
                    </div>
                  </button>
                ))}
              </div>
            </section>

            <section className="card">
              <div className="card-title" style={{ marginBottom: 6 }}>
                按需注入通道矩阵（关闭即 0 字节卸载）
              </div>
              <div className="setting-list">
                <ToggleRow
                  title="Composer 遥测 HUD（ch02-hud）"
                  desc="在输入框底部工具栏 Turbo 左侧无缝嵌入速率、缓存命中、上下文水位与 /compact 快捷按钮"
                  checked={config.hud.enabled}
                  onToggle={() => void patchConfig({ hud: { enabled: !config.hud.enabled } })}
                />
                <div className="setting-row">
                  <div>
                    <div style={{ fontWeight: 550 }}>无入侵中文界面汉化（ch03-i18n）</div>
                    <div className="muted">
                      内置 4,700+ 精确词条与 400+ 动态正则，含四层外部插件自动让路与无损还原
                    </div>
                  </div>
                  <div className="row">
                    {(['system', 'zh-CN', 'en'] as DisplayLanguage[]).map((lang) => (
                      <button
                        key={lang}
                        className={`btn sm ${config.language === lang ? 'primary' : ''}`}
                        onClick={() => void patchConfig({ language: lang })}
                      >
                        {lang === 'system' ? '跟随系统' : lang === 'zh-CN' ? '中文' : '英文(卸载)'}
                      </button>
                    ))}
                    <button
                      type="button"
                      className={`switch ${config.i18n.enabled ? 'on' : ''}`}
                      onClick={() => void patchConfig({ i18n: { enabled: !config.i18n.enabled } })}
                    />
                  </div>
                </div>
                <ToggleRow
                  title="工作台增强（ch04-workbench）"
                  desc="长代码块折叠、右侧大纲导航条、流式墨迹渐显与选中文本 /btw 快捷提问"
                  checked={config.workbench.enabled}
                  onToggle={() =>
                    void patchConfig({ workbench: { enabled: !config.workbench.enabled } })
                  }
                />
                <ToggleRow
                  title="Omni 预览器与裸链激活（ch06-omni）"
                  desc="零 DOM 侵入高亮裸链/本地路径，右键文件胶囊支持复制、@引用与 206 流式沙箱预览"
                  checked={config.omni.enabled}
                  onToggle={() => void patchConfig({ omni: { enabled: !config.omni.enabled } })}
                />
                <ToggleRow
                  title="安全内联 Git Diff（ch07-inline-diff）"
                  desc="在文件变更计数旁展开 Shadow DOM 语法高亮差异卡片，严格阻断恶意 .git/config 钩子"
                  checked={config.omni.inlineDiff}
                  onToggle={() =>
                    void patchConfig({ omni: { inlineDiff: !config.omni.inlineDiff } })
                  }
                />
                <ToggleRow
                  title="沉浸式聊天视图（ch08-chat-mode）"
                  desc="自动收起低频面板，聚焦居中对话流"
                  checked={config.chatMode.enabled}
                  onToggle={() =>
                    void patchConfig({ chatMode: { enabled: !config.chatMode.enabled } })
                  }
                />
                <ToggleRow
                  title="3D WebGL2 模型选择器（ch09-optics-picker）"
                  desc="打开模型菜单时呈现 3D 倾斜键帽矩阵并真实切换宿主模型，失焦立即释放显存"
                  checked={config.optics.picker3d}
                  onToggle={() =>
                    void patchConfig({ optics: { picker3d: !config.optics.picker3d } })
                  }
                />
              </div>
            </section>

            <section className="card">
              <div className="card-title" style={{ marginBottom: 8 }}>
                双模式思考转译（ch05-translator）与动态壁纸（ch11-optics-wallpaper）
              </div>
              <div className="setting-list">
                <div className="setting-row">
                  <div>
                    <div style={{ fontWeight: 550 }}>思考过程实时转译模式</div>
                    <div className="muted">经 Core SSRF 防护代理异步转译思考块，保留可点击 file:// 链接</div>
                  </div>
                  <div className="row">
                    {(['off', 'machine', 'llm'] as ThoughtTranslateMode[]).map((mode) => (
                      <button
                        key={mode}
                        className={`btn sm ${config.translator.mode === mode ? 'primary' : ''}`}
                        onClick={() => void patchConfig({ translator: { mode } })}
                      >
                        {mode === 'off' ? '关闭' : mode === 'machine' ? '零配置机翻' : '自定义 LLM'}
                      </button>
                    ))}
                  </div>
                </div>
                {config.translator.mode !== 'off' && (
                  <>
                    <ToggleRow
                      title="双语对照显示"
                      desc="关闭后切换为沉浸式中文译文（保留「查看原文」按钮）"
                      checked={config.translator.bilingual}
                      onToggle={() =>
                        void patchConfig({
                          translator: { bilingual: !config.translator.bilingual },
                        })
                      }
                    />
                    <ToggleRow
                      title="同步翻译侧栏会话标题"
                      desc="自动翻译英文历史会话标题并在卸载时还原"
                      checked={config.translator.translateTitles}
                      onToggle={() =>
                        void patchConfig({
                          translator: { translateTitles: !config.translator.translateTitles },
                        })
                      }
                    />
                  </>
                )}
                {config.translator.mode === 'llm' && (
                  <div className="setting-row">
                    <div className="row" style={{ width: '100%' }}>
                      <input
                        className="input"
                        placeholder="OpenAI 兼容接口，如 https://api.openai.com/v1/chat/completions"
                        value={translatorEndpointDraft}
                        onChange={(e) => setTranslatorEndpointDraft(e.target.value)}
                      />
                      <input
                        className="input"
                        style={{ maxWidth: 180 }}
                        placeholder="模型名 (gpt-4o-mini)"
                        value={translatorModelDraft}
                        onChange={(e) => setTranslatorModelDraft(e.target.value)}
                      />
                      <button
                        className="btn primary"
                        onClick={() =>
                          void patchConfig({
                            translator: {
                              endpoint: translatorEndpointDraft,
                              model: translatorModelDraft,
                            },
                          })
                        }
                      >
                        保存 LLM 配置
                      </button>
                    </div>
                  </div>
                )}

                <ToggleRow
                  title="动静态背景壁纸（ch11-optics-wallpaper）"
                  desc="通过本地 127.0.0.1 Range 网关零拷贝播放 mp4/webm/webp/png 背景"
                  checked={config.optics.wallpaper}
                  onToggle={() =>
                    void patchConfig({ optics: { wallpaper: !config.optics.wallpaper } })
                  }
                />
                {config.optics.wallpaper && (
                  <div className="setting-row">
                    <div className="row" style={{ width: '100%' }}>
                      <input
                        className="input"
                        placeholder="本地壁纸绝对路径（.mp4 / .webm / .png / .jpg / .webp）"
                        value={wallpaperPathDraft}
                        onChange={(e) => setWallpaperPathDraft(e.target.value)}
                      />
                      <label className="row muted" style={{ gap: 6 }}>
                        <span>不透明度 {Math.round(config.optics.wallpaperOpacity * 100)}%</span>
                        <input
                          type="range"
                          min={0.05}
                          max={0.85}
                          step={0.05}
                          value={config.optics.wallpaperOpacity}
                          onChange={(e) =>
                            void patchConfig({
                              optics: { wallpaperOpacity: Number(e.target.value) },
                            })
                          }
                        />
                      </label>
                      <button
                        className="btn primary"
                        onClick={() =>
                          void patchConfig({ optics: { wallpaperPath: wallpaperPathDraft } })
                        }
                      >
                        应用壁纸
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </section>
          </>
        )}
        </div>
      </main>
    </div>
  );
}
