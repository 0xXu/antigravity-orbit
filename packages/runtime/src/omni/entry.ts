import type { VisualChannelContract } from '@antigravity-orbit/shared';

interface OmniSignResponse {
  readonly url: string;
  readonly mime: string;
}

const BARE_URL_RE = /https?:\/\/[^\s<>"'`]+/g;
const LOCAL_PATH_RE = /(?:\/[A-Za-z0-9._-]+){2,}(?:\.[A-Za-z0-9]{1,8})?/g;
const PILL_SELECTOR = '[data-testid="entity-pill"], [data-testid="artifact-card"], .inline-pill';
const PREVIEWABLE_EXT_RE = /\.(mp4|webm|mp3|wav|pdf|svg|png|jpe?g|webp|csv|tsv|jsonl|html|ttf|otf|woff2)$/i;

function extractTargetPath(el: HTMLElement | null): string | null {
  if (!el) return null;
  const pill = el.closest<HTMLElement>(PILL_SELECTOR);
  const source = pill ?? el;

  const attrPath =
    source.getAttribute('data-file-path') ??
    source.getAttribute('data-path') ??
    source.getAttribute('title') ??
    source.querySelector<HTMLAnchorElement>('a[href^="file://"]')?.href ??
    '';

  if (attrPath) {
    return decodeURIComponent(attrPath.replace(/^file:\/\//, '')).trim();
  }

  const text = (source.textContent ?? '').trim();
  const match = text.match(/(?:\/[^\s"'`<>]+|[A-Za-z]:\\[^\s"'`<>]+)/);
  return match ? match[0] : null;
}

function insertAtMention(targetPath: string): boolean {
  const input = document.querySelector<HTMLElement>('[role="combobox"][contenteditable="true"]');
  if (!input) return false;
  input.focus();
  const baseName = targetPath.split(/[/\\]/).pop() || targetPath;
  const snippet = `@${baseName} `;
  if (typeof document.execCommand === 'function') {
    document.execCommand('insertText', false, snippet);
    return true;
  }
  input.textContent = `${input.textContent ?? ''}${snippet}`;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

/**
 * Ch06: Omni Viewer & Bare-Link Activator.
 * - Zero-mutation CSS.highlights for bare URLs & local file paths.
 * - Right-click context menu on entity pills / artifact cards: Copy Path, Insert @mention,
 *   and Sandbox HTTP 206 Streaming Preview Modal backed by Core's HMAC-signed OmniStreamingGateway.
 */
class OmniViewerChannel implements VisualChannelContract {
  readonly id = 'ch06-omni' as const;
  private styleEl: HTMLStyleElement | null = null;
  private observer: MutationObserver | null = null;
  private scanTimer: number | null = null;
  private menuHost: HTMLElement | null = null;
  private modalHost: HTMLElement | null = null;
  private contextListener: ((ev: MouseEvent) => void) | null = null;
  private dismissListener: ((ev: MouseEvent) => void) | null = null;
  private escListener: ((ev: KeyboardEvent) => void) | null = null;

  mount(root: Document): void {
    const style = root.createElement('style');
    style.id = 'antigravity-orbit-omni-highlight-style';
    style.textContent =
      '::highlight(pb-bare-url) { text-decoration: underline; color: #60a5fa; } ' +
      '::highlight(pb-local-path) { text-decoration: underline dotted rgba(147,197,253,0.7); }';
    root.head.appendChild(style);
    this.styleEl = style;
    this.highlightBareLinks(root);

    const target = root.body ?? root.documentElement;
    if (target && typeof MutationObserver !== 'undefined') {
      this.observer = new MutationObserver(() => {
        if (this.scanTimer !== null) return;
        this.scanTimer = window.setTimeout(() => {
          this.scanTimer = null;
          this.highlightBareLinks(root);
        }, 400);
      });
      this.observer.observe(target, { childList: true, subtree: true });
    }

    this.contextListener = (ev: MouseEvent) => {
      const targetEl = ev.target as HTMLElement | null;
      if (!targetEl || targetEl.closest('[data-antigravity-orbit-owned]')) return;
      const pill = targetEl.closest<HTMLElement>(PILL_SELECTOR);
      if (!pill) return;
      const filePath = extractTargetPath(pill);
      if (!filePath) return;
      ev.preventDefault();
      this.openContextMenu(root, ev.clientX, ev.clientY, filePath);
    };

    this.dismissListener = () => this.closeContextMenu();
    this.escListener = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        this.closeContextMenu();
        this.closeModal();
      }
    };

    root.addEventListener('contextmenu', this.contextListener);
    root.addEventListener('click', this.dismissListener);
    window.addEventListener('keydown', this.escListener);
  }

  onVisibilityChange(): void {}
  onWindowBlur(): void {
    this.closeContextMenu();
  }
  setBudgetMode(): void {}
  reclaimVram(): void {
    this.closeModal();
  }

  dispose(): void {
    if (this.scanTimer !== null) {
      window.clearTimeout(this.scanTimer);
      this.scanTimer = null;
    }
    this.observer?.disconnect();
    this.observer = null;
    if (this.contextListener) {
      document.removeEventListener('contextmenu', this.contextListener);
      this.contextListener = null;
    }
    if (this.dismissListener) {
      document.removeEventListener('click', this.dismissListener);
      this.dismissListener = null;
    }
    if (this.escListener) {
      window.removeEventListener('keydown', this.escListener);
      this.escListener = null;
    }
    this.closeContextMenu();
    this.closeModal();
    this.styleEl?.remove();
    this.styleEl = null;
    if (typeof CSS !== 'undefined' && 'highlights' in CSS) {
      CSS.highlights.delete('pb-bare-url');
      CSS.highlights.delete('pb-local-path');
    }
  }

  private highlightBareLinks(root: Document): void {
    if (typeof CSS === 'undefined' || !('highlights' in CSS)) return;
    const urlRanges: Range[] = [];
    const pathRanges: Range[] = [];
    const walker = root.createTreeWalker(root.body ?? root.documentElement, NodeFilter.SHOW_TEXT);
    let node: Node | null = walker.nextNode();
    while (node && (urlRanges.length < 64 || pathRanges.length < 64)) {
      const parent = (node as Text).parentElement;
      if (parent && !parent.closest('a, code, pre, script, style, textarea, [data-antigravity-orbit-owned]')) {
        const text = node.nodeValue ?? '';
        if (urlRanges.length < 64 && text.includes('http')) {
          BARE_URL_RE.lastIndex = 0;
          let match = BARE_URL_RE.exec(text);
          while (match && urlRanges.length < 64) {
            const r = root.createRange();
            r.setStart(node, match.index);
            r.setEnd(node, match.index + match[0].length);
            urlRanges.push(r);
            match = BARE_URL_RE.exec(text);
          }
        }
        if (pathRanges.length < 64 && text.includes('/')) {
          LOCAL_PATH_RE.lastIndex = 0;
          let match = LOCAL_PATH_RE.exec(text);
          while (match && pathRanges.length < 64) {
            if (!text.slice(Math.max(0, match.index - 7), match.index).includes('://')) {
              const r = root.createRange();
              r.setStart(node, match.index);
              r.setEnd(node, match.index + match[0].length);
              pathRanges.push(r);
            }
            match = LOCAL_PATH_RE.exec(text);
          }
        }
      }
      node = walker.nextNode();
    }
    if (urlRanges.length > 0) CSS.highlights.set('pb-bare-url', new Highlight(...urlRanges));
    if (pathRanges.length > 0) CSS.highlights.set('pb-local-path', new Highlight(...pathRanges));
  }

  private closeContextMenu(): void {
    this.menuHost?.remove();
    this.menuHost = null;
  }

  private closeModal(): void {
    this.modalHost?.remove();
    this.modalHost = null;
  }

  private openContextMenu(root: Document, x: number, y: number, filePath: string): void {
    this.closeContextMenu();
    const host = root.createElement('div');
    host.setAttribute('data-antigravity-orbit-owned', 'true');
    const shadow = host.attachShadow({ mode: 'open' });
    const canPreview = PREVIEWABLE_EXT_RE.test(filePath);
    const left = Math.min(x, Math.max(12, window.innerWidth - 220));
    const top = Math.min(y, Math.max(12, window.innerHeight - 150));

    shadow.innerHTML = `
      <style>
        .menu {
          position: fixed; left: ${left}px; top: ${top}px; z-index: 10000; width: 204px;
          padding: 6px; border-radius: 10px;
          background: rgba(18, 20, 28, 0.96); border: 1px solid rgba(255,255,255,0.14);
          box-shadow: 0 16px 40px rgba(0,0,0,0.55); backdrop-filter: blur(12px);
          font-family: -apple-system, BlinkMacSystemFont, sans-serif; color: #f4f4f5;
        }
        .path {
          font-size: 10px; color: #71717a; padding: 4px 8px 6px;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
          border-bottom: 1px solid rgba(255,255,255,0.08); margin-bottom: 4px;
        }
        button {
          width: 100%; text-align: left; padding: 7px 8px; border-radius: 6px;
          border: none; background: transparent; color: #e4e4e7; font-size: 12px; cursor: pointer;
        }
        button:hover { background: rgba(59,130,246,0.22); color: #ffffff; }
      </style>
      <div class="menu">
        <div class="path" title="${filePath.replaceAll('"', '&quot;')}">${filePath.split(/[/\\]/).pop() ?? filePath}</div>
        <button type="button" data-action="copy">复制完整路径</button>
        <button type="button" data-action="mention">插入 @引用到输入框</button>
        ${canPreview ? '<button type="button" data-action="preview">Omni 沙箱流式预览</button>' : ''}
      </div>
    `;

    shadow.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const btn = (ev.target as HTMLElement | null)?.closest<HTMLButtonElement>('[data-action]');
      const action = btn?.getAttribute('data-action');
      this.closeContextMenu();
      if (action === 'copy') {
        void navigator.clipboard?.writeText(filePath);
      } else if (action === 'mention') {
        insertAtMention(filePath);
      } else if (action === 'preview') {
        void this.openPreviewModal(root, filePath);
      }
    });

    root.body.appendChild(host);
    this.menuHost = host;
  }

  private async openPreviewModal(root: Document, filePath: string): Promise<void> {
    this.closeModal();
    const host = root.createElement('div');
    host.setAttribute('data-antigravity-orbit-owned', 'true');
    const shadow = host.attachShadow({ mode: 'open' });

    shadow.innerHTML = `
      <style>
        .backdrop {
          position: fixed; inset: 0; z-index: 10001; display: flex; align-items: center; justify-content: center;
          background: rgba(6, 8, 14, 0.72); backdrop-filter: blur(8px);
          font-family: -apple-system, BlinkMacSystemFont, sans-serif;
        }
        .dialog {
          width: min(880px, 90vw); max-height: 86vh; display: flex; flex-direction: column;
          background: #10131c; border: 1px solid rgba(255,255,255,0.14); border-radius: 14px;
          overflow: hidden; box-shadow: 0 24px 64px rgba(0,0,0,0.65);
        }
        .bar {
          display: flex; align-items: center; justify-content: space-between; gap: 12px;
          padding: 10px 14px; background: rgba(255,255,255,0.04); border-bottom: 1px solid rgba(255,255,255,0.08);
          color: #e4e4e7; font-size: 12px;
        }
        .close {
          background: transparent; border: 1px solid rgba(255,255,255,0.16); color: #d4d4d8;
          border-radius: 6px; padding: 3px 9px; cursor: pointer; font-size: 11px;
        }
        .stage {
          flex: 1; min-height: 360px; display: flex; align-items: center; justify-content: center;
          padding: 14px; overflow: auto; color: #a1a1aa; font-size: 13px;
        }
        img, video { max-width: 100%; max-height: 72vh; border-radius: 8px; }
        audio { width: 80%; }
        iframe { width: 100%; height: 70vh; border: none; border-radius: 8px; background: #fff; }
      </style>
      <div class="backdrop" id="backdrop">
        <div class="dialog">
          <div class="bar">
            <span id="title">Omni 预览 · ${filePath.split(/[/\\]/).pop() ?? filePath}</span>
            <button type="button" class="close" id="close">关闭 (Esc)</button>
          </div>
          <div class="stage" id="stage">正在签名并加载本地流式资源…</div>
        </div>
      </div>
    `;

    const close = () => this.closeModal();
    shadow.getElementById('close')?.addEventListener('click', close);
    shadow.getElementById('backdrop')?.addEventListener('click', (ev) => {
      if ((ev.target as HTMLElement)?.id === 'backdrop') close();
    });

    root.body.appendChild(host);
    this.modalHost = host;

    const stage = shadow.getElementById('stage')!;
    try {
      const signed = await window.__antigravityOrbit!.invokeRpc<OmniSignResponse>('omni.sign', {
        path: filePath,
      });
      if (!host.isConnected) return;
      stage.textContent = '';
      if (signed.mime.startsWith('video/')) {
        const video = root.createElement('video');
        video.src = signed.url;
        video.controls = true;
        video.autoplay = true;
        stage.appendChild(video);
      } else if (signed.mime.startsWith('audio/')) {
        const audio = root.createElement('audio');
        audio.src = signed.url;
        audio.controls = true;
        stage.appendChild(audio);
      } else if (signed.mime.startsWith('image/')) {
        const img = root.createElement('img');
        img.src = signed.url;
        img.alt = filePath;
        stage.appendChild(img);
      } else {
        const iframe = root.createElement('iframe');
        iframe.sandbox.add('allow-scripts');
        iframe.src = signed.url;
        stage.appendChild(iframe);
      }
    } catch (err) {
      stage.textContent = `无法预览该文件：${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

window.__antigravityOrbit?.registerChannel(new OmniViewerChannel());
