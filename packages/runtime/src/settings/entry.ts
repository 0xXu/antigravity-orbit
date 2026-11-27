import type { ThemePalette, VisualBudgetMode, VisualChannelContract } from '@antigravity-orbit/shared';

const HOST_ID = 'antigravity-orbit-inapp-settings-host';

class InAppSettingsChannel implements VisualChannelContract {
  readonly id = 'ch12-settings' as const;
  private host: HTMLElement | null = null;

  mount(root: Document): void {
    const appearanceRe = /^(?:appearance|外观|外觀|外観|외관|모양|apariencia|apparence|darstellung)$/i;
    let nativeAnchor: Element | null = null;
    for (const h2 of root.querySelectorAll('[role="dialog"] h2')) {
      if (appearanceRe.test((h2.textContent ?? '').trim())) {
        nativeAnchor = h2.closest('div.p-6') || h2.parentElement?.parentElement || h2.parentElement;
        break;
      }
    }
    const anchor =
      nativeAnchor ||
      root.querySelector('[data-antigravity-orbit-settings-anchor]') ||
      root.querySelector('[data-testid="settings-panel"]') ||
      root.body;
    if (!anchor) return;

    const host = root.createElement('div');
    host.id = HOST_ID;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        .pb-card {
          font-family: system-ui, -apple-system, sans-serif;
          background: var(--pb-surface-bg, #16161b);
          color: var(--pb-text-primary, #f4f4f5);
          border: 1px solid var(--pb-border-subtle, rgba(255,255,255,0.1));
          border-radius: 12px;
          padding: 16px;
          margin: 12px 0;
        }
        .pb-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
        .pb-title { font-size: 14px; font-weight: 600; }
        .pb-row { display: flex; gap: 8px; flex-wrap: wrap; margin: 8px 0; }
        button {
          background: rgba(255,255,255,0.06);
          color: inherit;
          border: 1px solid rgba(255,255,255,0.12);
          border-radius: 8px;
          padding: 6px 10px;
          font-size: 12px;
          cursor: pointer;
        }
        button.primary {
          background: var(--pb-accent, #3b82f6);
          color: #fff;
          border-color: transparent;
        }
      </style>
      <div class="pb-card">
        <div class="pb-header">
          <span class="pb-title">Antigravity Orbit · 外观与视觉快捷抽屉</span>
          <button class="primary" data-open-console="overview">打开完整控制台 ↗</button>
        </div>
        <div class="pb-row">
          <button data-theme="obsidian">深空黑曜</button>
          <button data-theme="warm">暖炭玄岩</button>
          <button data-theme="crystal">白昼冷晶</button>
          <button data-theme="alabaster">暖白画册</button>
        </div>
        <div class="pb-row">
          <button data-budget="full-optics">完整光效</button>
          <button data-budget="focus">专注编码</button>
          <button data-budget="silent-eco">静默省电</button>
        </div>
      </div>
    `;

    shadow.addEventListener('click', (ev) => {
      const btn = (ev.target as HTMLElement | null)?.closest('button');
      if (!btn) return;
      const theme = btn.getAttribute('data-theme') as ThemePalette | null;
      const budget = btn.getAttribute('data-budget') as VisualBudgetMode | null;
      const consolePage = btn.getAttribute('data-open-console');

      if (theme) window.__antigravityOrbit?.patchConfig({ theme });
      if (budget) window.__antigravityOrbit?.patchConfig({ visualBudget: budget });
      if (consolePage) window.__antigravityOrbit?.openDesktopConsole('overview');
    });

    anchor.appendChild(host);
    this.host = host;
  }

  onVisibilityChange(): void {}
  onWindowBlur(): void {}
  setBudgetMode(): void {}
  reclaimVram(): void {}

  dispose(): void {
    this.host?.remove();
    this.host = null;
  }
}

window.__antigravityOrbit?.registerChannel(new InAppSettingsChannel());
