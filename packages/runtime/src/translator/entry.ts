import type { VisualChannelContract } from '@antigravity-orbit/shared';

interface TranslateRpcResponse {
  readonly translated: string;
  readonly mode: 'machine' | 'llm';
  readonly durationMs: number;
}

const THOUGHT_SELECTOR =
  'button[data-testid="thinking-collapsible-trigger"], [data-testid="thought-block"], .thought-content';
const TITLE_SELECTOR = '[data-testid="conversation-row-sidebar"]';
const FILE_URI_RE = /(file:\/\/[^\s<>"'`)\]]+)/g;
const CJK_RE = /[\u4e00-\u9fff]/g;
const MAX_CACHE_ENTRIES = 200;

function contentSignature(text: string): string {
  const clean = text.trim();
  return `${clean.length}:${clean.slice(0, 64)}:${clean.slice(-64)}`;
}

function isMostlyChinese(text: string): boolean {
  const cjk = text.match(CJK_RE)?.length ?? 0;
  return text.length > 0 && cjk / text.length > 0.35;
}

function renderTextWithFileLinks(doc: Document, container: HTMLElement, text: string): void {
  container.textContent = '';
  const parts = text.split(FILE_URI_RE);
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith('file://')) {
      const a = doc.createElement('a');
      a.href = part;
      a.textContent = part;
      a.style.cssText = 'color:#60a5fa;text-decoration:underline;cursor:pointer;word-break:break-all;';
      a.addEventListener('click', (ev) => {
        ev.preventDefault();
        void navigator.clipboard?.writeText(part.replace(/^file:\/\//, ''));
      });
      container.appendChild(a);
    } else {
      container.appendChild(doc.createTextNode(part));
    }
  }
}

/**
 * Ch05: Dual-mode Thought & Title Translator UI channel.
 * Observes Antigravity thinking blocks and conversation sidebar rows, streams translations
 * through Core's SSRF-protected ThoughtTranslatorService via __antigravityOrbitRpc,
 * renders bilingual or immersive overlays, preserves file:// links, and supports retry.
 */
class ThoughtTranslatorChannel implements VisualChannelContract {
  readonly id = 'ch05-translator' as const;
  private mutationObserver: MutationObserver | null = null;
  private intersectionObserver: IntersectionObserver | null = null;
  private readonly cache = new Map<string, string>();
  private readonly timers = new WeakMap<HTMLElement, number>();
  private readonly overlays = new Set<HTMLElement>();
  private readonly hiddenOriginals = new Set<HTMLElement>();
  private readonly titleOriginals = new Map<HTMLElement, string>();

  mount(root: Document): void {
    const target = root.body ?? root.documentElement;
    if (!target) return;

    if (typeof IntersectionObserver !== 'undefined') {
      this.intersectionObserver = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            this.scheduleElement(root, entry.target as HTMLElement);
          }
        },
        { rootMargin: '120px 0px' },
      );
    }

    this.scan(root, target);

    this.mutationObserver = new MutationObserver((records) => {
      for (const rec of records) {
        for (const node of rec.addedNodes) {
          if (node instanceof HTMLElement && !node.closest('[data-antigravity-orbit-owned]')) {
            this.scan(root, node);
          }
        }
        if (rec.type === 'characterData' && rec.target.parentElement) {
          const thoughtHost = rec.target.parentElement.closest<HTMLElement>(THOUGHT_SELECTOR);
          if (thoughtHost) this.scheduleElement(root, thoughtHost);
        }
      }
    });
    this.mutationObserver.observe(target, { childList: true, subtree: true, characterData: true });
  }

  onVisibilityChange(): void {}
  onWindowBlur(): void {}
  setBudgetMode(): void {}
  reclaimVram(): void {}

  dispose(): void {
    this.mutationObserver?.disconnect();
    this.mutationObserver = null;
    this.intersectionObserver?.disconnect();
    this.intersectionObserver = null;

    for (const overlay of this.overlays) overlay.remove();
    this.overlays.clear();

    for (const orig of this.hiddenOriginals) {
      orig.style.removeProperty('display');
    }
    this.hiddenOriginals.clear();

    for (const [el, origText] of this.titleOriginals) {
      if (el.isConnected) el.textContent = origText;
    }
    this.titleOriginals.clear();

    document.querySelectorAll('[data-antigravity-orbit-thought-sig]').forEach((el) => {
      el.removeAttribute('data-antigravity-orbit-thought-sig');
    });
  }

  private scan(root: Document, container: Element): void {
    const cfg = window.__antigravityOrbit?.getConfig()?.translator;
    if (!cfg || cfg.mode === 'off') return;

    const candidates: HTMLElement[] = [];
    if (container instanceof HTMLElement && container.matches(THOUGHT_SELECTOR)) {
      candidates.push(container);
    }
    container.querySelectorAll<HTMLElement>(THOUGHT_SELECTOR).forEach((el) => candidates.push(el));

    if (cfg.translateTitles) {
      if (container instanceof HTMLElement && container.matches(TITLE_SELECTOR)) {
        candidates.push(container);
      }
      container.querySelectorAll<HTMLElement>(TITLE_SELECTOR).forEach((el) => candidates.push(el));
    }

    for (const el of candidates) {
      if (el.closest('[data-antigravity-orbit-owned]')) continue;
      if (this.intersectionObserver) {
        this.intersectionObserver.observe(el);
      } else {
        this.scheduleElement(root, el);
      }
    }
  }

  private scheduleElement(root: Document, el: HTMLElement): void {
    const prev = this.timers.get(el);
    if (prev !== undefined) window.clearTimeout(prev);
    const id = window.setTimeout(() => {
      this.timers.delete(el);
      void this.processElement(root, el);
    }, 260);
    this.timers.set(el, id);
  }

  private resolveThoughtBody(el: HTMLElement): HTMLElement | null {
    if (el.matches('button[data-testid="thinking-collapsible-trigger"]')) {
      const sibling = el.nextElementSibling;
      if (sibling instanceof HTMLElement && (sibling.textContent ?? '').trim().length >= 24) {
        return sibling;
      }
      const parent = el.parentElement;
      if (parent) {
        const panel = parent.querySelector<HTMLElement>('[role="region"], .prose, .markdown');
        if (panel && (panel.textContent ?? '').trim().length >= 24) return panel;
      }
      return null;
    }
    return el;
  }

  private async processElement(root: Document, el: HTMLElement): Promise<void> {
    if (!el.isConnected) return;
    const cfg = window.__antigravityOrbit?.getConfig()?.translator;
    if (!cfg || cfg.mode === 'off') return;
    const mode: 'machine' | 'llm' = cfg.mode;

    if (el.matches(TITLE_SELECTOR)) {
      await this.translateTitleRow(el, {
        mode,
        endpoint: cfg.endpoint,
        model: cfg.model,
      });
      return;
    }

    const body = this.resolveThoughtBody(el);
    if (!body || !body.isConnected) return;

    const rawText = this.extractOriginalText(body);
    if (rawText.length < 24 || isMostlyChinese(rawText)) return;

    const sig = contentSignature(rawText);
    if (body.getAttribute('data-antigravity-orbit-thought-sig') === sig) return;
    body.setAttribute('data-antigravity-orbit-thought-sig', sig);

    const overlay = this.ensureOverlay(root, body);
    const cached = this.cache.get(sig);
    if (cached) {
      this.renderTranslatedOverlay(root, body, overlay, cached, cfg.bilingual);
      return;
    }

    this.renderPendingOverlay(overlay, cfg.mode);
    try {
      const res = await window.__antigravityOrbit!.invokeRpc<TranslateRpcResponse>('translator.translate', {
        text: rawText.slice(0, 6000),
        mode: cfg.mode,
        endpoint: cfg.endpoint,
        model: cfg.model,
        targetLang: 'zh-CN',
      });
      if (!body.isConnected) return;
      const translated = (res?.translated ?? '').trim();
      if (!translated) throw new Error('翻译结果为空');

      if (this.cache.size >= MAX_CACHE_ENTRIES) {
        const firstKey = this.cache.keys().next().value;
        if (firstKey) this.cache.delete(firstKey);
      }
      this.cache.set(sig, translated);
      this.renderTranslatedOverlay(root, body, overlay, translated, cfg.bilingual);
    } catch (err) {
      if (!body.isConnected) return;
      const msg = err instanceof Error ? err.message : String(err);
      this.renderErrorOverlay(root, body, overlay, msg, sig);
    }
  }

  private async translateTitleRow(
    row: HTMLElement,
    cfg: { readonly mode: 'machine' | 'llm'; readonly endpoint: string; readonly model: string },
  ): Promise<void> {
    const labelEl = row.querySelector<HTMLElement>('span, p, div') ?? row;
    const raw = (labelEl.textContent ?? '').trim();
    if (!raw || raw.length < 4 || raw.length > 140 || isMostlyChinese(raw)) return;
    const sig = contentSignature(raw);
    if (labelEl.getAttribute('data-antigravity-orbit-thought-sig') === sig) return;
    labelEl.setAttribute('data-antigravity-orbit-thought-sig', sig);

    const cached = this.cache.get(sig);
    if (cached) {
      if (!this.titleOriginals.has(labelEl)) this.titleOriginals.set(labelEl, raw);
      labelEl.textContent = cached;
      return;
    }

    try {
      const res = await window.__antigravityOrbit!.invokeRpc<TranslateRpcResponse>('translator.translate', {
        text: raw,
        mode: cfg.mode,
        endpoint: cfg.endpoint,
        model: cfg.model,
        targetLang: 'zh-CN',
      });
      const translated = (res?.translated ?? '').trim();
      if (translated && labelEl.isConnected) {
        if (!this.titleOriginals.has(labelEl)) this.titleOriginals.set(labelEl, raw);
        this.cache.set(sig, translated);
        labelEl.textContent = translated;
      }
    } catch {
      // Non-fatal for sidebar title translation
    }
  }

  private extractOriginalText(body: HTMLElement): string {
    const clone = body.cloneNode(true) as HTMLElement;
    clone.querySelectorAll('[data-antigravity-orbit-owned]').forEach((n) => n.remove());
    return (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
  }

  private ensureOverlay(root: Document, body: HTMLElement): HTMLElement {
    let overlay = body.querySelector<HTMLElement>(':scope > .ag-orbit-thought-overlay');
    if (!overlay) {
      overlay = root.createElement('div');
      overlay.className = 'ag-orbit-thought-overlay';
      overlay.setAttribute('data-antigravity-orbit-owned', 'true');
      overlay.style.cssText =
        'margin-top:8px;padding:8px 10px;border-left:2px solid var(--ag-accent,#3b82f6);border-radius:6px;background:rgba(59,130,246,0.08);font-size:12px;line-height:1.55;color:var(--foreground,#e4e4e7);font-family:-apple-system,BlinkMacSystemFont,sans-serif;';
      body.appendChild(overlay);
      this.overlays.add(overlay);
    }
    return overlay;
  }

  private renderPendingOverlay(overlay: HTMLElement, mode: 'machine' | 'llm'): void {
    overlay.textContent = mode === 'llm' ? 'Orbit LLM 思考转译中…' : 'Orbit 思考转译中…';
    overlay.style.opacity = '0.78';
  }

  private renderTranslatedOverlay(
    root: Document,
    body: HTMLElement,
    overlay: HTMLElement,
    translated: string,
    bilingual: boolean,
  ): void {
    overlay.style.opacity = '1';
    overlay.textContent = '';

    const header = root.createElement('div');
    header.style.cssText =
      'display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:4px;font-size:10px;color:#93c5fd;opacity:0.9;';
    const badge = root.createElement('span');
    badge.textContent = bilingual ? 'Orbit 双语思考转译' : 'Orbit 沉浸式思考转译';
    header.appendChild(badge);

    if (!bilingual) {
      const origChildren = Array.from(body.children).filter((c) => c !== overlay) as HTMLElement[];
      let showingOriginal = false;
      for (const child of origChildren) {
        child.style.display = 'none';
        this.hiddenOriginals.add(child);
      }
      const toggleBtn = root.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.textContent = '查看原文';
      toggleBtn.style.cssText =
        'background:transparent;border:1px solid rgba(147,197,253,0.35);color:#93c5fd;border-radius:4px;padding:1px 6px;font-size:10px;cursor:pointer;';
      toggleBtn.addEventListener('click', () => {
        showingOriginal = !showingOriginal;
        toggleBtn.textContent = showingOriginal ? '隐藏原文' : '查看原文';
        for (const child of origChildren) {
          child.style.display = showingOriginal ? '' : 'none';
        }
      });
      header.appendChild(toggleBtn);
    }

    const content = root.createElement('div');
    content.style.whiteSpace = 'pre-wrap';
    renderTextWithFileLinks(root, content, translated);

    overlay.appendChild(header);
    overlay.appendChild(content);
  }

  private renderErrorOverlay(
    root: Document,
    body: HTMLElement,
    overlay: HTMLElement,
    message: string,
    sig: string,
  ): void {
    overlay.style.opacity = '0.9';
    overlay.textContent = '';

    const row = root.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;color:#fca5a5;';

    const span = root.createElement('span');
    span.textContent = `转译失败：${message}`;

    const retry = root.createElement('button');
    retry.type = 'button';
    retry.textContent = '重试';
    retry.style.cssText =
      'background:rgba(248,113,113,0.16);border:1px solid rgba(248,113,113,0.4);color:#fecaca;border-radius:4px;padding:2px 8px;font-size:11px;cursor:pointer;';
    retry.addEventListener('click', () => {
      if (body.getAttribute('data-antigravity-orbit-thought-sig') === sig) {
        body.removeAttribute('data-antigravity-orbit-thought-sig');
      }
      void this.processElement(root, body);
    });

    row.appendChild(span);
    row.appendChild(retry);
    overlay.appendChild(row);
  }
}

window.__antigravityOrbit?.registerChannel(new ThoughtTranslatorChannel());
