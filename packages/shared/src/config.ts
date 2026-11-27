export type ThemePalette = 'obsidian' | 'warm' | 'crystal' | 'alabaster';
export type AccentTone = 'model' | 'cobalt' | 'iris' | 'amber' | 'mono';
export type VisualBudgetMode = 'full-optics' | 'focus' | 'silent-eco';
export type DisplayLanguage = 'system' | 'zh-CN' | 'en';
export type HudStyle = 'capsules' | 'vial' | 'hybrid';
export type ProxyMode = 'off' | 'system' | 'manual';
export type ThoughtTranslateMode = 'off' | 'machine' | 'llm';

export const CHANNEL_IDS = [
  'ch01-core',
  'ch02-hud',
  'ch03-i18n',
  'ch04-workbench',
  'ch05-translator',
  'ch06-omni',
  'ch07-inline-diff',
  'ch08-chat-mode',
  'ch09-optics-picker',
  'ch11-optics-wallpaper',
  'ch12-settings',
] as const;

export type ChannelId = (typeof CHANNEL_IDS)[number];

export interface ChannelManifestEntry {
  readonly id: ChannelId;
  readonly file: string;
  readonly codeHash: string;
  readonly bytes: number;
  readonly alwaysOn: boolean;
  readonly world?: 'isolated' | 'main';
}

export interface AuxiliaryBundleEntry {
  readonly file: string;
  readonly codeHash: string;
  readonly bytes: number;
  readonly world: 'main';
}

export interface ChannelManifest {
  readonly version: string;
  readonly builtAt: string;
  readonly channels: Record<ChannelId, ChannelManifestEntry>;
  readonly auxiliary?: Record<string, AuxiliaryBundleEntry>;
}

export interface VisualChannelContract {
  readonly id: ChannelId;
  mount(root: Document): void;
  onVisibilityChange(hidden: boolean): void;
  onWindowBlur(blurred: boolean): void;
  setBudgetMode(mode: VisualBudgetMode): void;
  reclaimVram(): void;
  dispose(): void;
}

export interface AntigravityOrbitConfig {
  readonly schemaVersion: 1;
  readonly theme: ThemePalette;
  readonly followSystemTheme: boolean;
  readonly accent: AccentTone;
  readonly visualBudget: VisualBudgetMode;
  readonly language: DisplayLanguage;
  readonly privacyMask: boolean;
  readonly hud: {
    readonly enabled: boolean;
    readonly style: HudStyle;
  };
  readonly i18n: {
    readonly enabled: boolean;
    readonly autoYield: boolean;
  };
  readonly workbench: {
    readonly enabled: boolean;
    readonly codeFoldMinLines: number;
    readonly outlineRail: boolean;
    readonly btwContextMenu: boolean;
    readonly inkStreamFade: boolean;
    readonly effortSlider: boolean;
  };
  readonly translator: {
    readonly mode: ThoughtTranslateMode;
    readonly bilingual: boolean;
    readonly translateTitles: boolean;
    readonly endpoint: string;
    readonly model: string;
  };
  readonly omni: {
    readonly enabled: boolean;
    readonly inlineDiff: boolean;
    readonly linkTarget: 'builtin' | 'external';
  };
  readonly chatMode: {
    readonly enabled: boolean;
  };
  readonly optics: {
    readonly picker3d: boolean;
    readonly wallpaper: boolean;
    readonly wallpaperPath: string;
    readonly wallpaperOpacity: number;
    readonly horizonRipple: boolean;
  };
  readonly proxy: {
    readonly mode: ProxyMode;
    readonly manualUrl: string;
  };
  readonly autoLaunchAntigravity: boolean;
  readonly autoStartOnLogin: boolean;
  readonly autoAttachBareHost: boolean;
}

export const DEFAULT_CONFIG: AntigravityOrbitConfig = {
  schemaVersion: 1,
  theme: 'obsidian',
  followSystemTheme: true,
  accent: 'model',
  visualBudget: 'full-optics',
  language: 'system',
  privacyMask: false,
  hud: {
    enabled: true,
    style: 'hybrid',
  },
  i18n: {
    enabled: true,
    autoYield: true,
  },
  workbench: {
    enabled: true,
    codeFoldMinLines: 48,
    outlineRail: true,
    btwContextMenu: true,
    inkStreamFade: true,
    effortSlider: true,
  },
  translator: {
    mode: 'off',
    bilingual: true,
    translateTitles: false,
    endpoint: '',
    model: '',
  },
  omni: {
    enabled: true,
    inlineDiff: true,
    linkTarget: 'builtin',
  },
  chatMode: {
    enabled: false,
  },
  optics: {
    picker3d: true,
    wallpaper: false,
    wallpaperPath: '',
    wallpaperOpacity: 0.28,
    horizonRipple: true,
  },
  proxy: {
    mode: 'off',
    manualUrl: '',
  },
  autoLaunchAntigravity: false,
  autoStartOnLogin: false,
  autoAttachBareHost: true,
};

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Record<string, unknown> ? DeepPartial<T[K]> : T[K];
};

const VALID_THEMES = new Set<ThemePalette>(['obsidian', 'warm', 'crystal', 'alabaster']);
const VALID_ACCENTS = new Set<AccentTone>(['model', 'cobalt', 'iris', 'amber', 'mono']);
const VALID_BUDGETS = new Set<VisualBudgetMode>(['full-optics', 'focus', 'silent-eco']);
const VALID_LANGS = new Set<DisplayLanguage>(['system', 'zh-CN', 'en']);
const VALID_HUD_STYLES = new Set<HudStyle>(['capsules', 'vial', 'hybrid']);
const VALID_PROXY_MODES = new Set<ProxyMode>(['off', 'system', 'manual']);
const VALID_TRANSLATE_MODES = new Set<ThoughtTranslateMode>(['off', 'machine', 'llm']);

export function normalizeConfig(
  raw: DeepPartial<AntigravityOrbitConfig> | undefined,
  base: AntigravityOrbitConfig = DEFAULT_CONFIG,
): AntigravityOrbitConfig {
  if (!raw || typeof raw !== 'object') return base;
  const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

  return {
    schemaVersion: 1,
    theme: VALID_THEMES.has(raw.theme as ThemePalette) ? (raw.theme as ThemePalette) : base.theme,
    followSystemTheme:
      typeof raw.followSystemTheme === 'boolean' ? raw.followSystemTheme : base.followSystemTheme,
    accent: VALID_ACCENTS.has(raw.accent as AccentTone) ? (raw.accent as AccentTone) : base.accent,
    visualBudget: VALID_BUDGETS.has(raw.visualBudget as VisualBudgetMode)
      ? (raw.visualBudget as VisualBudgetMode)
      : base.visualBudget,
    language: VALID_LANGS.has(raw.language as DisplayLanguage)
      ? (raw.language as DisplayLanguage)
      : base.language,
    privacyMask: typeof raw.privacyMask === 'boolean' ? raw.privacyMask : base.privacyMask,
    hud: {
      enabled: typeof raw.hud?.enabled === 'boolean' ? raw.hud.enabled : base.hud.enabled,
      style: VALID_HUD_STYLES.has(raw.hud?.style as HudStyle)
        ? (raw.hud?.style as HudStyle)
        : base.hud.style,
    },
    i18n: {
      enabled: typeof raw.i18n?.enabled === 'boolean' ? raw.i18n.enabled : base.i18n.enabled,
      autoYield:
        typeof raw.i18n?.autoYield === 'boolean' ? raw.i18n.autoYield : base.i18n.autoYield,
    },
    workbench: {
      enabled:
        typeof raw.workbench?.enabled === 'boolean' ? raw.workbench.enabled : base.workbench.enabled,
      codeFoldMinLines:
        typeof raw.workbench?.codeFoldMinLines === 'number' &&
        Number.isFinite(raw.workbench.codeFoldMinLines)
          ? Math.round(clamp(raw.workbench.codeFoldMinLines, 16, 400))
          : base.workbench.codeFoldMinLines,
      outlineRail:
        typeof raw.workbench?.outlineRail === 'boolean'
          ? raw.workbench.outlineRail
          : base.workbench.outlineRail,
      btwContextMenu:
        typeof raw.workbench?.btwContextMenu === 'boolean'
          ? raw.workbench.btwContextMenu
          : base.workbench.btwContextMenu,
      inkStreamFade:
        typeof raw.workbench?.inkStreamFade === 'boolean'
          ? raw.workbench.inkStreamFade
          : base.workbench.inkStreamFade,
      effortSlider:
        typeof raw.workbench?.effortSlider === 'boolean'
          ? raw.workbench.effortSlider
          : base.workbench.effortSlider,
    },
    translator: {
      mode: VALID_TRANSLATE_MODES.has(raw.translator?.mode as ThoughtTranslateMode)
        ? (raw.translator?.mode as ThoughtTranslateMode)
        : base.translator.mode,
      bilingual:
        typeof raw.translator?.bilingual === 'boolean'
          ? raw.translator.bilingual
          : base.translator.bilingual,
      translateTitles:
        typeof raw.translator?.translateTitles === 'boolean'
          ? raw.translator.translateTitles
          : base.translator.translateTitles,
      endpoint:
        typeof raw.translator?.endpoint === 'string'
          ? raw.translator.endpoint.trim().slice(0, 512)
          : base.translator.endpoint,
      model:
        typeof raw.translator?.model === 'string'
          ? raw.translator.model.trim().slice(0, 128)
          : base.translator.model,
    },
    omni: {
      enabled: typeof raw.omni?.enabled === 'boolean' ? raw.omni.enabled : base.omni.enabled,
      inlineDiff:
        typeof raw.omni?.inlineDiff === 'boolean' ? raw.omni.inlineDiff : base.omni.inlineDiff,
      linkTarget:
        raw.omni?.linkTarget === 'builtin' || raw.omni?.linkTarget === 'external'
          ? raw.omni.linkTarget
          : base.omni.linkTarget,
    },
    chatMode: {
      enabled:
        typeof raw.chatMode?.enabled === 'boolean' ? raw.chatMode.enabled : base.chatMode.enabled,
    },
    optics: {
      picker3d:
        typeof raw.optics?.picker3d === 'boolean' ? raw.optics.picker3d : base.optics.picker3d,
      wallpaper:
        typeof raw.optics?.wallpaper === 'boolean' ? raw.optics.wallpaper : base.optics.wallpaper,
      wallpaperPath:
        typeof raw.optics?.wallpaperPath === 'string'
          ? raw.optics.wallpaperPath.slice(0, 1024)
          : base.optics.wallpaperPath,
      wallpaperOpacity:
        typeof raw.optics?.wallpaperOpacity === 'number' &&
        Number.isFinite(raw.optics.wallpaperOpacity)
          ? clamp(raw.optics.wallpaperOpacity, 0.05, 0.85)
          : base.optics.wallpaperOpacity,
      horizonRipple:
        typeof raw.optics?.horizonRipple === 'boolean'
          ? raw.optics.horizonRipple
          : base.optics.horizonRipple,
    },
    proxy: {
      mode: VALID_PROXY_MODES.has(raw.proxy?.mode as ProxyMode)
        ? (raw.proxy?.mode as ProxyMode)
        : base.proxy.mode,
      manualUrl:
        typeof raw.proxy?.manualUrl === 'string'
          ? raw.proxy.manualUrl.trim().slice(0, 512)
          : base.proxy.manualUrl,
    },
    autoLaunchAntigravity:
      typeof raw.autoLaunchAntigravity === 'boolean'
        ? raw.autoLaunchAntigravity
        : base.autoLaunchAntigravity,
    autoStartOnLogin:
      typeof raw.autoStartOnLogin === 'boolean' ? raw.autoStartOnLogin : base.autoStartOnLogin,
    autoAttachBareHost:
      typeof raw.autoAttachBareHost === 'boolean'
        ? raw.autoAttachBareHost
        : base.autoAttachBareHost,
  };
}

/**
 * Computes which runtime channels should be active for a given configuration.
 * Channels that are off stay strictly 0-byte unloaded in the IDE.
 */
export function resolveActiveChannels(
  config: AntigravityOrbitConfig,
  opts: { settingsOpen?: boolean; modelMenuOpen?: boolean } = {},
): ChannelId[] {
  const active: ChannelId[] = ['ch01-core'];
  const isSilent = config.visualBudget === 'silent-eco';

  if (config.hud.enabled) active.push('ch02-hud');
  if (config.i18n.enabled && config.language !== 'en') active.push('ch03-i18n');
  if (config.workbench.enabled) active.push('ch04-workbench');
  if (config.translator.mode !== 'off') active.push('ch05-translator');
  if (config.omni.enabled) active.push('ch06-omni');
  if (config.omni.enabled && config.omni.inlineDiff) active.push('ch07-inline-diff');
  if (config.chatMode.enabled) active.push('ch08-chat-mode');

  // Cool optical channels — strictly gated by config + budget
  if (!isSilent && config.optics.picker3d) {
    active.push('ch09-optics-picker');
  }
  if (!isSilent && config.optics.wallpaper && config.optics.wallpaperPath.length > 0) {
    active.push('ch11-optics-wallpaper');
  }
  if (opts.settingsOpen) {
    active.push('ch12-settings');
  }

  return active;
}
