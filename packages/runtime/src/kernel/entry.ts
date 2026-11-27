import type {
  ChannelId,
  ConsolePage,
  DeepPartial,
  HudMetricsSnapshot,
  AntigravityOrbitConfig,
  VisualChannelContract,
} from '@antigravity-orbit/shared';
import { PALETTES, buildThemeCss, collectSidecarThemeVars } from './themes.js';
import { InkStreamEngine } from './ink-stream.js';

declare const __ORBIT_STYLE_CSS__: string | undefined;

interface OrbitRuntimeApi {
  refreshConfig?: (cfg: Record<string, unknown>) => unknown;
  flattenCss?: () => void;
  destroy?: () => void;
}

declare global {
  interface Window {
    __antigravityOrbit?: AntigravityOrbitMicrokernel;
    __antigravityOrbitSetting?: (payload: string) => void;
    __antigravityOrbitOpenConsole?: (payload: string) => void;
    __antigravityOrbitUiState?: (payload: string) => void;
    __antigravityOrbitRpc?: (payload: string) => void;
    __agCsUiMain?: (cfg: Record<string, unknown>) => void;
    __agOrbit?: OrbitRuntimeApi;
  }
}

interface PendingRpc {
  readonly resolve: (value: unknown) => void;
  readonly reject: (err: Error) => void;
  readonly timer: number;
}

const ORBIT_STYLE_ID = 'ag-orbit-css';
const STYLE_ELEMENT_ID = 'antigravity-orbit-core-theme-style';

function toOrbitEngineConfig(config: AntigravityOrbitConfig): Record<string, unknown> {
  const palette = config.theme === 'warm' ? 'warm' : 'obsidian';
  const lightPreset = config.theme === 'alabaster' || config.theme === 'warm' ? 'alabaster' : 'crystal';
  const accentTone = config.accent === 'model' ? 'follow' : config.accent;
  const motionLevel =
    config.visualBudget === 'silent-eco'
      ? 'off'
      : config.visualBudget === 'focus'
        ? 'standard'
        : 'ultra';
  const ambientIntensity =
    config.visualBudget === 'silent-eco'
      ? '0'
      : config.visualBudget === 'focus'
        ? '70'
        : '100';
  const rippleEnabled = config.visualBudget !== 'silent-eco' && config.optics.horizonRipple;

  return {
    language: config.language === 'system' ? 'auto' : config.language,
    lang: config.language === 'system' ? 'auto' : config.language,
    palette,
    lightPreset,
    darkAuraStyle: 'orbit',
    darkAura: 'balanced',
    accentTone,
    motionLevel,
    targetFps: '180',
    ambientIntensity,
    cornerStyle: 'balanced',
    homeLayout: 'classic',
    homeMode: 'classic',
    homeRipple: rippleEnabled,
    ripple: rippleEnabled ? 'on' : 'off',
    convRipple: rippleEnabled && config.visualBudget === 'full-optics' ? 'subtle' : 'off',
    composerRestyle: true,
    composer: 'on',
    placeholderStyle: 'studio',
    promptStyle: 'studio',
    sidebarRestyle: true,
    sidebar: 'on',
    sidebarCompact: false,
    sidebarNavFold: 'off',
    smoothCaret: config.visualBudget !== 'silent-eco',
    scrollBottomMotion: config.visualBudget === 'silent-eco' ? 'instant' : 'smooth',
    contextMenu: config.workbench.enabled && config.workbench.btwContextMenu,
    effortSliderModule: config.workbench.enabled && config.workbench.effortSlider ? 'auto' : 'off',
    effortMemory: 'on',
    periodicModelPicker:
      config.visualBudget !== 'silent-eco' && config.optics.picker3d ? 'on' : 'off',
    // Keep built-in optical engine telemetry / mascot / i18n / thought / omni OFF
    // so Antigravity Orbit's Hybrid HUD (ch02-hud) and modular channels own them cleanly.
    telemetryModule: 'off',
    mascot: 'off',
    hostLocalization: 'off',
    thoughtTranslate: 'off',
    omniModule: 'off',
    sidebarStudio: 'off',
    autoUpdate: 'off',
    __fromFile: true,
  };
}

export class AntigravityOrbitMicrokernel {
  private config: AntigravityOrbitConfig | null = null;
  private latestHud: HudMetricsSnapshot | null = null;
  private readonly hudListeners = new Set<(snapshot: HudMetricsSnapshot) => void>();
  private readonly channels = new Map<ChannelId, VisualChannelContract>();
  private readonly inkStream = new InkStreamEngine();
  private readonly cleanups: Array<() => void> = [];
  private settingsObserver: MutationObserver | null = null;
  private lastSettingsOpen = false;
  private originalBodyThemeClass: 'theme-dark' | 'theme-light' | null = null;
  private wallpaperSource: { url: string; mime: string } | null = null;
  private orbitBooted = false;
  private rpcSeq = 0;
  private readonly pendingRpcs = new Map<string, PendingRpc>();

  constructor() {
    this.installLifecycleGuards();
    this.installSettingsDetector();
  }

  getConfig(): AntigravityOrbitConfig | null {
    return this.config;
  }

  applyConfig(config: AntigravityOrbitConfig): void {
    this.config = config;
    const root = document.documentElement;
    root.setAttribute('data-antigravity-orbit-theme', config.theme);
    root.setAttribute('data-antigravity-orbit-accent', config.accent);
    root.setAttribute('data-antigravity-orbit-budget', config.visualBudget);
    root.toggleAttribute('data-antigravity-orbit-privacy', config.privacyMask);

    this.syncBodyThemeClass(PALETTES[config.theme].mode);
    this.upsertOrbitEngine(config);
    this.upsertStyle(buildThemeCss(config.theme, config.accent));
    this.syncSidecarIframes(config);
    this.inkStream.setEnabled(
      config.workbench.enabled &&
        config.workbench.inkStreamFade &&
        config.visualBudget !== 'silent-eco',
    );

    for (const channel of this.channels.values()) {
      channel.setBudgetMode(config.visualBudget);
    }
  }

  setWallpaperSource(url: string, mime: string): void {
    this.wallpaperSource = url ? { url, mime } : null;
    const wp = this.channels.get('ch11-optics-wallpaper') as
      | (VisualChannelContract & { setSource?: (u: string, m: string) => void })
      | undefined;
    if (wp?.setSource && this.wallpaperSource) {
      wp.setSource(this.wallpaperSource.url, this.wallpaperSource.mime);
    }
  }

  getWallpaperSource(): { url: string; mime: string } | null {
    return this.wallpaperSource;
  }

  registerChannel(channel: VisualChannelContract): void {
    this.disposeChannel(channel.id);
    this.channels.set(channel.id, channel);
    channel.mount(document);
    if (this.config) {
      channel.setBudgetMode(this.config.visualBudget);
    }
    if (channel.id === 'ch11-optics-wallpaper' && this.wallpaperSource) {
      const wp = channel as VisualChannelContract & { setSource?: (u: string, m: string) => void };
      wp.setSource?.(this.wallpaperSource.url, this.wallpaperSource.mime);
    }
  }

  disposeChannel(id: ChannelId): void {
    const existing = this.channels.get(id);
    if (!existing) return;
    try {
      existing.reclaimVram();
      existing.dispose();
    } finally {
      this.channels.delete(id);
    }
  }

  patchConfig(patch: DeepPartial<AntigravityOrbitConfig>): void {
    window.__antigravityOrbitSetting?.(JSON.stringify(patch));
  }

  openDesktopConsole(page: ConsolePage = 'overview'): void {
    window.__antigravityOrbitOpenConsole?.(JSON.stringify({ page }));
  }

  invokeRpc<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 15_000,
  ): Promise<T> {
    if (typeof window.__antigravityOrbitRpc !== 'function') {
      return Promise.reject(new Error('Antigravity Orbit RPC bridge unavailable'));
    }
    const id = `rpc_${Date.now()}_${++this.rpcSeq}`;
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pendingRpcs.delete(id);
        reject(new Error(`RPC timeout (${method})`));
      }, timeoutMs);
      this.pendingRpcs.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      try {
        window.__antigravityOrbitRpc!(JSON.stringify({ id, method, params }));
      } catch (err) {
        window.clearTimeout(timer);
        this.pendingRpcs.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  resolveRpc(id: string, ok: boolean, data: unknown, error: string | null): void {
    const pending = this.pendingRpcs.get(id);
    if (!pending) return;
    this.pendingRpcs.delete(id);
    window.clearTimeout(pending.timer);
    if (ok) {
      pending.resolve(data);
    } else {
      pending.reject(new Error(error || 'RPC failed'));
    }
  }

  updateHud(snapshot: HudMetricsSnapshot): void {
    this.latestHud = snapshot;
    for (const fn of this.hudListeners) {
      fn(snapshot);
    }
  }

  onHudUpdate(listener: (snapshot: HudMetricsSnapshot) => void): () => void {
    this.hudListeners.add(listener);
    if (this.latestHud) listener(this.latestHud);
    return () => this.hudListeners.delete(listener);
  }

  disposeAll(): void {
    for (const [id, pending] of this.pendingRpcs) {
      window.clearTimeout(pending.timer);
      pending.reject(new Error('Antigravity Orbit disposed'));
      this.pendingRpcs.delete(id);
    }
    for (const id of Array.from(this.channels.keys())) {
      this.disposeChannel(id);
    }
    this.teardownOrbitEngine();
    this.inkStream.clear();
    this.settingsObserver?.disconnect();
    this.settingsObserver = null;
    for (const fn of this.cleanups.splice(0)) {
      fn();
    }
    document.getElementById(STYLE_ELEMENT_ID)?.remove();
    this.restoreBodyThemeClass();
    const root = document.documentElement;
    root.removeAttribute('data-antigravity-orbit-theme');
    root.removeAttribute('data-antigravity-orbit-accent');
    root.removeAttribute('data-antigravity-orbit-budget');
    root.removeAttribute('data-antigravity-orbit-privacy');
    root.removeAttribute('data-antigravity-orbit-blur');
    delete window.__antigravityOrbit;
  }

  private upsertOrbitEngine(config: AntigravityOrbitConfig): void {
    const orbitCss = typeof __ORBIT_STYLE_CSS__ === 'string' ? __ORBIT_STYLE_CSS__ : '';
    if (orbitCss) {
      const parent = document.head || document.documentElement;
      if (parent) {
        let styleEl = document.getElementById(ORBIT_STYLE_ID) as HTMLStyleElement | null;
        if (!styleEl) {
          styleEl = document.createElement('style');
          styleEl.id = ORBIT_STYLE_ID;
          parent.appendChild(styleEl);
        }
        if (styleEl.textContent !== orbitCss && !styleEl.getAttribute('data-ag-cs-flat')) {
          styleEl.textContent = orbitCss;
          styleEl.setAttribute('data-ag-cs-css-hash', 'orbit-optics-v1');
        }
      }
    }

    const orbitCfg = toOrbitEngineConfig(config);
    try {
      if (this.orbitBooted && typeof window.__agOrbit?.refreshConfig === 'function') {
        window.__agOrbit.refreshConfig(orbitCfg);
      } else if (typeof window.__agCsUiMain === 'function') {
        // Clear any stale runtime handles left by a previous kernel version before cold-booting Orbit
        try { delete window.__agOrbit; } catch {}
        try { delete (window as unknown as Record<string, unknown>).__agClaudeStyle; } catch {}
        window.__agCsUiMain(orbitCfg);
        this.orbitBooted = Boolean(window.__agOrbit);
      }
      window.__agOrbit?.flattenCss?.();
    } catch (err) {
      (window as unknown as Record<string, unknown>).__antigravityOrbitEngineError =
        err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
    }
  }

  private teardownOrbitEngine(): void {
    try {
      window.__agOrbit?.destroy?.();
    } catch {
      // Ignore cleanup errors
    }
    this.orbitBooted = false;
    document.getElementById(ORBIT_STYLE_ID)?.remove();
    const root = document.documentElement;
    if (root) {
      for (const attr of Array.from(root.attributes)) {
        if (attr.name.startsWith('data-ag-cs-') || attr.name.startsWith('data-ag-orbit-')) {
          root.removeAttribute(attr.name);
        }
      }
    }
    try {
      delete window.__agOrbit;
    } catch {
      // Ignore non-configurable properties
    }
    try {
      delete (window as unknown as Record<string, unknown>).__agClaudeStyle;
    } catch {
      // Ignore non-configurable properties
    }
  }

  private syncBodyThemeClass(mode: 'dark' | 'light'): void {
    const body = document.body;
    if (!body) return;
    if (this.originalBodyThemeClass === null) {
      if (body.classList.contains('theme-dark')) this.originalBodyThemeClass = 'theme-dark';
      else if (body.classList.contains('theme-light')) this.originalBodyThemeClass = 'theme-light';
    }
    body.classList.toggle('theme-dark', mode === 'dark');
    body.classList.toggle('theme-light', mode === 'light');
  }

  private restoreBodyThemeClass(): void {
    const body = document.body;
    if (!body || !this.originalBodyThemeClass) return;
    body.classList.toggle('theme-dark', this.originalBodyThemeClass === 'theme-dark');
    body.classList.toggle('theme-light', this.originalBodyThemeClass === 'theme-light');
    this.originalBodyThemeClass = null;
  }

  private upsertStyle(cssText: string): void {
    let el = document.getElementById(STYLE_ELEMENT_ID) as HTMLStyleElement | null;
    if (!el) {
      el = document.createElement('style');
      el.id = STYLE_ELEMENT_ID;
      document.head.appendChild(el);
    }
    if (el.textContent !== cssText) {
      el.textContent = cssText;
    }
  }

  private syncSidecarIframes(config: AntigravityOrbitConfig): void {
    const vars = collectSidecarThemeVars(config.theme, config.accent);
    const iframes = document.querySelectorAll<HTMLIFrameElement>('iframe[src^="plugin://"]');
    for (const iframe of iframes) {
      try {
        iframe.contentWindow?.postMessage(
          { type: 'antigravity-orbit:theme-sync', theme: config.theme, vars },
          '*',
        );
      } catch {
        // Ignore inaccessible cross-origin frames
      }
    }
  }

  private installLifecycleGuards(): void {
    const onVisibility = () => {
      const hidden = document.hidden;
      if (hidden) this.inkStream.clear();
      for (const ch of this.channels.values()) {
        ch.onVisibilityChange(hidden);
        if (hidden) ch.reclaimVram();
      }
    };
    const onBlur = () => {
      document.documentElement.setAttribute('data-antigravity-orbit-blur', 'true');
      for (const ch of this.channels.values()) ch.onWindowBlur(true);
    };
    const onFocus = () => {
      document.documentElement.removeAttribute('data-antigravity-orbit-blur');
      for (const ch of this.channels.values()) ch.onWindowBlur(false);
    };

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    this.cleanups.push(() => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
    });
  }

  private installSettingsDetector(): void {
    if (typeof MutationObserver === 'undefined') return;
    let timer: number | null = null;
    const appearanceRe = /^(?:appearance|外观|外觀|外観|외관|모양|apariencia|apparence|darstellung)$/i;
    const check = () => {
      timer = null;
      const hasCustomAnchor = Boolean(
        document.querySelector('[data-testid="settings-panel"], [data-antigravity-orbit-settings-anchor]'),
      );
      const hasNativeAppearanceDialog = Array.from(document.querySelectorAll('[role="dialog"] h2')).some((h2) =>
        appearanceRe.test((h2.textContent ?? '').trim()),
      );
      const settingsOpen = hasCustomAnchor || hasNativeAppearanceDialog;
      if (settingsOpen !== this.lastSettingsOpen) {
        this.lastSettingsOpen = settingsOpen;
        window.__antigravityOrbitUiState?.(JSON.stringify({ settingsOpen }));
      }
    };
    this.settingsObserver = new MutationObserver(() => {
      if (timer !== null) return;
      timer = window.setTimeout(check, 120);
    });
    this.settingsObserver.observe(document.body ?? document.documentElement, {
      childList: true,
      subtree: true,
    });
  }
}

if (window.__antigravityOrbit) {
  try {
    window.__antigravityOrbit.disposeAll();
  } catch {
    // Ignore stale microkernel cleanup error
  }
}
window.__antigravityOrbit = new AntigravityOrbitMicrokernel();
