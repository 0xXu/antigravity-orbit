import type { VisualChannelContract } from '@antigravity-orbit/shared';

const MENU_HOST_ID = 'antigravity-orbit-btw-menu-host';
const SLASH_ITEMS = [
  { cmd: '/btw', label: '/btw 侧边提问' },
  { cmd: '/plan', label: '/plan 制定方案' },
  { cmd: '/compact', label: '/compact 压缩上下文' },
  { cmd: '/learn', label: '/learn 固化经验' },
  { cmd: '/grill-me', label: '/grill-me 深度质询' },
];

/**
 * Ch04: Workbench Productivity Suite
 * - Manual sticky fold for long code blocks (>= codeFoldMinLines)
 * - Alt+ArrowUp / Alt+ArrowDown turn navigation
 * - Curated right-click context menu for /btw and native slash commands
 */
class WorkbenchChannel implements VisualChannelContract {
  readonly id = 'ch04-workbench' as const;
  private cleanups: Array<() => void> = [];
  private menuHost: HTMLElement | null = null;
  private observer: MutationObserver | null = null;

  mount(root: Document): void {
    const onKeyDown = (ev: KeyboardEvent) => {
      if (!ev.altKey || (ev.key !== 'ArrowUp' && ev.key !== 'ArrowDown')) return;
      const active = root.activeElement;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || (active as HTMLElement).isContentEditable)) {
        return;
      }
      const turns = Array.from(root.querySelectorAll<HTMLElement>('[data-testid="conversation-turn"], .conversation-turn'));
      if (turns.length === 0) return;
      ev.preventDefault();
      const idx = turns.findIndex((el) => el.getBoundingClientRect().top >= 10);
      const targetIdx =
        ev.key === 'ArrowDown'
          ? Math.min(turns.length - 1, Math.max(0, idx + 1))
          : Math.max(0, (idx === -1 ? turns.length - 1 : idx) - 1);
      turns[targetIdx]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };

    const onContextMenu = (ev: MouseEvent) => {
      if (!window.__antigravityOrbit?.getConfig()?.workbench.btwContextMenu) return;
      // Yield to the curated context-menu engine when active
      if ((window as unknown as Record<string, unknown>).__agOrbitContextMenu) return;
      const target = ev.target as HTMLElement | null;
      if (
        !target?.closest(
          '[data-testid="conversation-turn"], .markdown, .prose, .surface-composer-card, main',
        )
      ) {
        return;
      }
      if (target.closest('input, textarea, [contenteditable="true"], a, pre, code')) return;
      ev.preventDefault();
      this.showContextMenu(root, ev.clientX, ev.clientY);
    };

    const onDocClick = () => this.hideContextMenu();

    root.addEventListener('keydown', onKeyDown);
    root.addEventListener('contextmenu', onContextMenu);
    root.addEventListener('click', onDocClick);
    this.cleanups.push(() => {
      root.removeEventListener('keydown', onKeyDown);
      root.removeEventListener('contextmenu', onContextMenu);
      root.removeEventListener('click', onDocClick);
    });

    this.decorateLongCodeBlocks(root);
    this.observer = new MutationObserver(() => this.decorateLongCodeBlocks(root));
    this.observer.observe(root.body ?? root.documentElement, { childList: true, subtree: true });
  }

  onVisibilityChange(): void {}
  onWindowBlur(): void {
    this.hideContextMenu();
  }
  setBudgetMode(): void {}
  reclaimVram(): void {}

  dispose(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.hideContextMenu();
    for (const fn of this.cleanups.splice(0)) fn();
    document.querySelectorAll('[data-antigravity-orbit-fold-btn]').forEach((el) => el.remove());
  }

  private decorateLongCodeBlocks(root: Document): void {
    const minLines = window.__antigravityOrbit?.getConfig()?.workbench.codeFoldMinLines ?? 48;
    const blocks = root.querySelectorAll<HTMLElement>('pre > code');
    for (const code of blocks) {
      const pre = code.parentElement;
      if (!pre || pre.hasAttribute('data-antigravity-orbit-fold-ready')) continue;
      const lineCount = (code.textContent ?? '').split('\n').length;
      if (lineCount < minLines) continue;

      pre.setAttribute('data-antigravity-orbit-fold-ready', 'true');
      const btn = root.createElement('button');
      btn.setAttribute('data-antigravity-orbit-fold-btn', 'true');
      btn.textContent = `折叠代码 (${lineCount} 行)`;
      btn.style.cssText =
        'position:sticky;top:4px;float:right;font-size:11px;padding:2px 8px;border-radius:6px;border:1px solid rgba(255,255,255,0.14);background:rgba(20,20,25,0.85);color:#e4e4e7;cursor:pointer;';
      let folded = false;
      btn.addEventListener('click', () => {
        folded = !folded;
        code.style.display = folded ? 'none' : '';
        btn.textContent = folded ? `展开代码 (${lineCount} 行)` : `折叠代码 (${lineCount} 行)`;
      });
      pre.prepend(btn);
    }
  }

  private showContextMenu(root: Document, x: number, y: number): void {
    this.hideContextMenu();
    const clampedX = Math.max(8, Math.min(x, window.innerWidth - 184));
    const clampedY = Math.max(8, Math.min(y, window.innerHeight - 210));
    const host = root.createElement('div');
    host.id = MENU_HOST_ID;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        .menu {
          position: fixed; left: ${clampedX}px; top: ${clampedY}px; z-index: 2147483002;
          background: var(--pb-surface-bg, #16161b); color: var(--pb-text-primary, #f4f4f5);
          border: 1px solid var(--pb-border-subtle, rgba(255,255,255,0.12));
          border-radius: 10px; padding: 4px; min-width: 168px; box-shadow: 0 12px 28px rgba(0,0,0,0.45);
          font-family: system-ui, sans-serif; font-size: 12px;
        }
        button {
          display: block; width: 100%; text-align: left; background: transparent; color: inherit;
          border: none; padding: 7px 10px; border-radius: 6px; cursor: pointer;
        }
        button:hover { background: rgba(59, 130, 246, 0.25); }
      </style>
      <div class="menu">
        ${SLASH_ITEMS.map((i) => `<button data-cmd="${i.cmd}">${i.label}</button>`).join('')}
      </div>
    `;
    shadow.addEventListener('click', (ev) => {
      const cmd = (ev.target as HTMLElement | null)?.getAttribute('data-cmd');
      if (cmd) {
        const input = root.querySelector<HTMLElement>(
          '[role="combobox"][contenteditable="true"], [contenteditable="true"], textarea',
        );
        if (input) {
          input.focus();
          if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
            input.value = `${cmd} ${input.value}`;
            input.dispatchEvent(new Event('input', { bubbles: true }));
          } else if (input.isContentEditable) {
            document.execCommand?.('insertText', false, `${cmd} `);
          }
        }
      }
      this.hideContextMenu();
    });
    root.body.appendChild(host);
    this.menuHost = host;
  }

  private hideContextMenu(): void {
    this.menuHost?.remove();
    this.menuHost = null;
  }
}

window.__antigravityOrbit?.registerChannel(new WorkbenchChannel());
