import type { AccentTone, ThemePalette } from '@antigravity-orbit/shared';

export interface PaletteTokens {
  readonly mode: 'dark' | 'light';
  readonly sidebarBg: string;
  readonly sidebarSecondary: string;
  readonly sidebarMuted: string;
  readonly canvasBg: string;
  readonly surfaceBg: string;
  readonly surfaceElevated: string;
  readonly bubbleBg: string;
  readonly bubbleBorder: string;
  readonly secondaryBg: string;
  readonly mutedBg: string;
  readonly borderSubtle: string;
  readonly cardBorder: string;
  readonly textPrimary: string;
  readonly textSecondary: string;
  readonly textMuted: string;
  readonly placeholder: string;
  readonly onyxFrame: string;
  readonly onyxWell: string;
  readonly onyxRaised: string;
  readonly scrim: string;
  readonly shadowCard: string;
}

export const PALETTES: Record<ThemePalette, PaletteTokens> = {
  obsidian: {
    mode: 'dark',
    sidebarBg: '#09090b',
    sidebarSecondary: 'rgba(255, 255, 255, 0.075)',
    sidebarMuted: 'rgba(255, 255, 255, 0.042)',
    canvasBg: '#0e0e11',
    surfaceBg: '#141418',
    surfaceElevated: '#1a1a21',
    bubbleBg: 'linear-gradient(180deg, rgba(28, 28, 36, 0.94), rgba(20, 20, 26, 0.96))',
    bubbleBorder: 'rgba(255, 255, 255, 0.1)',
    secondaryBg: 'rgba(255, 255, 255, 0.07)',
    mutedBg: 'rgba(255, 255, 255, 0.04)',
    borderSubtle: 'rgba(255, 255, 255, 0.08)',
    cardBorder: 'rgba(255, 255, 255, 0.095)',
    textPrimary: '#f4f4f5',
    textSecondary: '#d4d4d8',
    textMuted: '#a1a1aa',
    placeholder: '#71717a',
    onyxFrame: '#0b0b0e',
    onyxWell: 'rgba(255, 255, 255, 0.055)',
    onyxRaised: '#191920',
    scrim: 'rgba(0, 0, 0, 0.58)',
    shadowCard: '0 8px 28px rgba(0, 0, 0, 0.38)',
  },
  warm: {
    mode: 'dark',
    sidebarBg: '#10100f',
    sidebarSecondary: 'rgba(255, 245, 230, 0.08)',
    sidebarMuted: 'rgba(255, 245, 230, 0.045)',
    canvasBg: '#141413',
    surfaceBg: '#1c1b19',
    surfaceElevated: '#23211e',
    bubbleBg: 'linear-gradient(180deg, rgba(36, 33, 29, 0.94), rgba(27, 25, 22, 0.96))',
    bubbleBorder: 'rgba(255, 240, 220, 0.11)',
    secondaryBg: 'rgba(255, 245, 230, 0.07)',
    mutedBg: 'rgba(255, 245, 230, 0.04)',
    borderSubtle: 'rgba(255, 245, 230, 0.09)',
    cardBorder: 'rgba(255, 245, 230, 0.11)',
    textPrimary: '#f5f2eb',
    textSecondary: '#d6d3cd',
    textMuted: '#a8a29e',
    placeholder: '#78716c',
    onyxFrame: '#121110',
    onyxWell: 'rgba(255, 245, 230, 0.055)',
    onyxRaised: '#22201d',
    scrim: 'rgba(10, 9, 8, 0.58)',
    shadowCard: '0 8px 28px rgba(0, 0, 0, 0.42)',
  },
  crystal: {
    mode: 'light',
    sidebarBg: '#e8eef6',
    sidebarSecondary: 'rgba(15, 23, 42, 0.075)',
    sidebarMuted: 'rgba(15, 23, 42, 0.042)',
    canvasBg: '#f4f7fb',
    surfaceBg: '#ffffff',
    surfaceElevated: '#f9fbfe',
    bubbleBg: 'linear-gradient(180deg, #ffffff, #f3f7fc)',
    bubbleBorder: 'rgba(37, 99, 235, 0.14)',
    secondaryBg: 'rgba(15, 23, 42, 0.06)',
    mutedBg: 'rgba(15, 23, 42, 0.038)',
    borderSubtle: 'rgba(15, 23, 42, 0.08)',
    cardBorder: 'rgba(15, 23, 42, 0.095)',
    textPrimary: '#0f172a',
    textSecondary: '#334155',
    textMuted: '#475569',
    placeholder: '#64748b',
    onyxFrame: '#edf2f9',
    onyxWell: 'rgba(15, 23, 42, 0.05)',
    onyxRaised: '#ffffff',
    scrim: 'rgba(15, 23, 42, 0.28)',
    shadowCard: '0 6px 22px rgba(15, 23, 42, 0.08)',
  },
  alabaster: {
    mode: 'light',
    sidebarBg: '#ebe6dc',
    sidebarSecondary: 'rgba(41, 37, 36, 0.075)',
    sidebarMuted: 'rgba(41, 37, 36, 0.042)',
    canvasBg: '#f6f4ee',
    surfaceBg: '#fcfbf7',
    surfaceElevated: '#ffffff',
    bubbleBg: 'linear-gradient(180deg, #fdfcf9, #f3efe6)',
    bubbleBorder: 'rgba(120, 100, 80, 0.16)',
    secondaryBg: 'rgba(41, 37, 36, 0.06)',
    mutedBg: 'rgba(41, 37, 36, 0.038)',
    borderSubtle: 'rgba(41, 37, 36, 0.09)',
    cardBorder: 'rgba(41, 37, 36, 0.11)',
    textPrimary: '#1c1917',
    textSecondary: '#44403c',
    textMuted: '#57534e',
    placeholder: '#78716c',
    onyxFrame: '#f0ece3',
    onyxWell: 'rgba(41, 37, 36, 0.05)',
    onyxRaised: '#fcfbf7',
    scrim: 'rgba(28, 25, 23, 0.28)',
    shadowCard: '0 6px 22px rgba(41, 37, 36, 0.08)',
  },
};

export const ACCENTS: Record<AccentTone, string> = {
  model: '#3b82f6',
  cobalt: '#2563eb',
  iris: '#7c3aed',
  amber: '#d97706',
  mono: '#94a3b8',
};

export function buildThemeCss(palette: ThemePalette, accent: AccentTone): string {
  const t = PALETTES[palette];
  const accentHex = palette === 'warm' && accent === 'model' ? '#d97757' : palette === 'alabaster' && accent === 'model' ? '#c25934' : ACCENTS[accent];

  return `
:root[data-antigravity-orbit-theme="${palette}"] {
  color-scheme: ${t.mode} !important;
  --pb-mode: ${t.mode};
  --pb-sidebar-bg: ${t.sidebarBg};
  --pb-canvas-bg: ${t.canvasBg};
  --pb-surface-bg: ${t.surfaceBg};
  --pb-surface-elevated: ${t.surfaceElevated};
  --pb-border-subtle: ${t.borderSubtle};
  --pb-text-primary: ${t.textPrimary};
  --pb-text-muted: ${t.textMuted};
  --pb-accent: ${accentHex};
}

/* Browser-hole transparency preservation (Electron WebContentsView) */
body[data-has-browser-hole="true"],
body[data-has-drawer-browser-hole="true"],
.browser-hole-ancestor[data-has-browser-hole="true"] {
  background: transparent !important;
  background-color: transparent !important;
}

/* Privacy mask */
:root[data-antigravity-orbit-privacy] [data-testid="account-email"],
:root[data-antigravity-orbit-privacy] [title*="@"] {
  filter: blur(5px) !important;
  transition: filter 150ms ease;
}
:root[data-antigravity-orbit-privacy] [data-testid="account-email"]:hover,
:root[data-antigravity-orbit-privacy] [title*="@"]:hover {
  filter: none !important;
}

/* 5-bucket CSS.highlights Ink-Stream fade */
::highlight(pb-ink-f0) { color: color-mix(in srgb, currentColor 18%, transparent); }
::highlight(pb-ink-f1) { color: color-mix(in srgb, currentColor 38%, transparent); }
::highlight(pb-ink-f2) { color: color-mix(in srgb, currentColor 60%, transparent); }
::highlight(pb-ink-f3) { color: color-mix(in srgb, currentColor 82%, transparent); }
::highlight(pb-ink-f4) { color: currentColor; }
`.trim();
}

export function collectSidecarThemeVars(palette: ThemePalette, accent: AccentTone): Record<string, string> {
  const t = PALETTES[palette];
  const accentHex = ACCENTS[accent];
  return {
    '--pb-mode': t.mode,
    '--pb-sidebar-bg': t.sidebarBg,
    '--pb-canvas-bg': t.canvasBg,
    '--pb-surface-bg': t.surfaceBg,
    '--pb-border-subtle': t.borderSubtle,
    '--pb-text-primary': t.textPrimary,
    '--pb-text-muted': t.textMuted,
    '--pb-accent': accentHex,
    '--background': t.canvasBg,
    '--foreground': t.textPrimary,
    '--sidebar': t.sidebarBg,
    '--card': t.surfaceBg,
    '--border': t.borderSubtle,
    '--primary': accentHex,
  };
}
