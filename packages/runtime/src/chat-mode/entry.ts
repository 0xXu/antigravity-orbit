import type { VisualChannelContract } from '@antigravity-orbit/shared';

const CHAT_BAR_ID = 'antigravity-orbit-chat-mode-switcher';

/**
 * Ch08: Dual-Space Code / Chat Mode Switcher.
 * Toggles `html[data-antigravity-orbit-mode="chat"]` so heavy IDE widgets sleep cleanly in Chat mode.
 */
class ChatModeChannel implements VisualChannelContract {
  readonly id = 'ch08-chat-mode' as const;
  private host: HTMLElement | null = null;
  private mode: 'code' | 'chat' = 'code';

  mount(root: Document): void {
    const sidebar = root.querySelector('.bg-sidebar, [data-testid="sidebar"], aside') ?? root.body;
    if (!sidebar) return;

    const host = root.createElement('div');
    host.id = CHAT_BAR_ID;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        .seg { display: flex; gap: 4px; padding: 6px 8px; font-family: system-ui, sans-serif; }
        button {
          flex: 1; font-size: 11px; padding: 5px 8px; border-radius: 7px; cursor: pointer;
          border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.04); color: #a1a1aa;
        }
        button.active { background: var(--pb-accent, #3b82f6); color: #fff; border-color: transparent; }
      </style>
      <div class="seg">
        <button data-mode="code" class="active">Code</button>
        <button data-mode="chat">Chat</button>
      </div>
    `;

    shadow.addEventListener('click', (ev) => {
      const next = (ev.target as HTMLElement | null)?.getAttribute('data-mode') as 'code' | 'chat' | null;
      if (!next || next === this.mode) return;
      this.mode = next;
      root.documentElement.setAttribute('data-antigravity-orbit-mode', next);
      shadow.querySelectorAll('button').forEach((b) => {
        b.classList.toggle('active', b.getAttribute('data-mode') === next);
      });
    });

    sidebar.prepend(host);
    this.host = host;
  }

  onVisibilityChange(): void {}
  onWindowBlur(): void {}
  setBudgetMode(): void {}
  reclaimVram(): void {}

  dispose(): void {
    document.documentElement.removeAttribute('data-antigravity-orbit-mode');
    this.host?.remove();
    this.host = null;
  }
}

window.__antigravityOrbit?.registerChannel(new ChatModeChannel());
