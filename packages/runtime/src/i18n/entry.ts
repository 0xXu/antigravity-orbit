import type { VisualChannelContract } from '@antigravity-orbit/shared';
import zhCnDict from './zh-CN.json';

interface PatternRule {
  readonly regex: string;
  readonly replacement: string;
}

interface CompiledRule {
  readonly re: RegExp;
  readonly replacement: string;
}

const EXACT_MAP: Record<string, string> = zhCnDict.exact as Record<string, string>;
const RAW_PATTERNS: readonly PatternRule[] = (zhCnDict.patterns ?? []) as readonly PatternRule[];

const PROTECTED_SELECTOR = [
  'script',
  'style',
  'code',
  'pre',
  'input',
  'textarea',
  'svg',
  'canvas',
  '.monaco-editor',
  '.xterm',
  '.markdown',
  '.prose',
  '[data-markdown-root]',
  '[data-testid="agent-response"]',
  '[data-testid="planner-response-text"]',
  '[data-testid="user-message-content"]',
  '[contenteditable]',
  '[data-antigravity-orbit-owned]',
  '[data-antigravity-orbit-user-content]',
  '[data-no-translate]',
  '[data-testid="conversation-row-sidebar"]',
  '[data-testid="project-header"]',
  '[data-testid="model-selector-item"]',
].join(',');

const BRAND_ALLOWLIST = new Set([
  'Antigravity',
  'Gemini',
  'Claude',
  'GitHub',
  'Dracula',
  'Antigravity Orbit',
  'Markdown',
  'TypeScript',
  'JavaScript',
  'Python',
  'Rust',
  'MCP',
  'SSH',
  'CDP',
  'SQLite',
]);

const CJK_RE = /[\u4e00-\u9fff]/;
const ASCII_LETTER_RE = /[A-Za-z]/;
const MAX_NODES_PER_FRAME = 80;
const MAX_MS_PER_FRAME = 4.5;

/**
 * Ch03: Protected DOM Localization with full zh-CN dictionary (4,700+ exact + 400+ regexes),
 * rAF time-sliced scanning (<= 80 nodes / < 5ms per frame), 4-layer Auto-Yield,
 * and WeakMap-backed 100% lossless teardown.
 * Strictly 0-byte unloaded when language === 'en' or i18n.enabled === false.
 */
class ProtectedI18nChannel implements VisualChannelContract {
  readonly id = 'ch03-i18n' as const;
  private readonly originals = new WeakMap<Text, string>();
  private readonly appliedValues = new WeakMap<Text, string>();
  private readonly translatedNodes = new Set<Text>();
  private readonly pendingRoots = new Set<Element>();
  private compiledPatterns: CompiledRule[] | null = null;
  private observer: MutationObserver | null = null;
  private rafId: number | null = null;
  private yielded = false;
  private conflictCount = 0;
  private conflictWindowStart = 0;

  mount(root: Document): void {
    if (this.shouldAutoYield(root)) {
      this.yielded = true;
      return;
    }

    this.ensurePatternsCompiled();
    const target = root.body ?? root.documentElement;
    if (!target) return;

    this.enqueueRoot(target);
    this.observer = new MutationObserver((records) => {
      if (this.yielded) return;
      for (const rec of records) {
        if (rec.type === 'characterData' && rec.target.nodeType === Node.TEXT_NODE) {
          const textNode = rec.target as Text;
          const val = textNode.nodeValue ?? '';
          const applied = this.appliedValues.get(textNode);
          if (applied !== undefined && val === applied) {
            // Ignore characterData mutations produced by our own translation write
            continue;
          }
          if (this.translatedNodes.has(textNode)) {
            const orig = this.originals.get(textNode);
            if (orig && val !== orig && CJK_RE.test(val) && this.recordConflict()) {
              this.yielded = true;
              this.dispose();
              return;
            }
            if (!CJK_RE.test(val) && textNode.parentElement && !textNode.parentElement.closest(PROTECTED_SELECTOR)) {
              this.originals.set(textNode, val);
              this.appliedValues.delete(textNode);
              this.enqueueRoot(textNode.parentElement);
            }
          } else if (
            ASCII_LETTER_RE.test(val) &&
            !CJK_RE.test(val) &&
            textNode.parentElement &&
            !textNode.parentElement.closest(PROTECTED_SELECTOR)
          ) {
            this.enqueueRoot(textNode.parentElement);
          }
          continue;
        }
        for (const node of rec.addedNodes) {
          if (node instanceof Element && !node.closest(PROTECTED_SELECTOR)) {
            this.enqueueRoot(node);
          } else if (node.nodeType === Node.TEXT_NODE && node.parentElement) {
            if (!node.parentElement.closest(PROTECTED_SELECTOR)) {
              this.enqueueRoot(node.parentElement);
            }
          }
        }
      }
    });
    this.observer.observe(target, { childList: true, subtree: true, characterData: true });
  }

  onVisibilityChange(): void {}
  onWindowBlur(): void {}
  setBudgetMode(): void {}
  reclaimVram(): void {}

  dispose(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.pendingRoots.clear();
    this.observer?.disconnect();
    this.observer = null;
    for (const node of this.translatedNodes) {
      const orig = this.originals.get(node);
      if (orig !== undefined && node.isConnected) {
        node.nodeValue = orig;
      }
    }
    this.translatedNodes.clear();
  }

  private ensurePatternsCompiled(): void {
    if (this.compiledPatterns) return;
    const out: CompiledRule[] = [];
    for (const p of RAW_PATTERNS) {
      try {
        out.push({ re: new RegExp(p.regex), replacement: p.replacement });
      } catch {
        // Ignore invalid pattern rule
      }
    }
    this.compiledPatterns = out;
  }

  private shouldAutoYield(root: Document): boolean {
    if (window.__antigravityOrbit?.getConfig()?.i18n.autoYield === false) return false;

    // Layer 1: Known external i18n extension / script DOM markers
    if (
      root.documentElement.hasAttribute('data-ag-chinese') ||
      root.documentElement.hasAttribute('data-orbit-i18n') ||
      root.getElementById('ag-i18n-style') ||
      Boolean((window as unknown as Record<string, unknown>).__agChineseLoaded)
    ) {
      return true;
    }

    // Layer 2: Sample existing UI chrome labels; yield if host or another plugin already localized >= 60%
    const chromeEls = root.querySelectorAll('button, [role="tab"], [role="menuitem"], h2, label');
    let sampled = 0;
    let cjkHits = 0;
    for (const el of chromeEls) {
      if (sampled >= 30) break;
      if (el.closest(PROTECTED_SELECTOR)) continue;
      const txt = (el.textContent ?? '').trim();
      if (!txt || txt.length > 48) continue;
      sampled += 1;
      if (CJK_RE.test(txt)) cjkHits += 1;
    }
    if (sampled >= 12 && cjkHits / sampled >= 0.6) {
      return true;
    }

    return false;
  }

  private recordConflict(): boolean {
    if (window.__antigravityOrbit?.getConfig()?.i18n.autoYield === false) return false;
    const now = performance.now();
    if (now - this.conflictWindowStart > 2000) {
      this.conflictWindowStart = now;
      this.conflictCount = 1;
      return false;
    }
    this.conflictCount += 1;
    return this.conflictCount >= 6;
  }

  private enqueueRoot(el: Element): void {
    this.pendingRoots.add(el);
    if (this.rafId === null) {
      this.rafId = requestAnimationFrame(() => this.flushQueue());
    }
  }

  private flushQueue(): void {
    this.rafId = null;
    if (this.yielded || this.pendingRoots.size === 0) return;

    const started = performance.now();
    let processed = 0;
    const roots = Array.from(this.pendingRoots);
    this.pendingRoots.clear();

    for (let i = 0; i < roots.length; i += 1) {
      const rootEl = roots[i];
      if (!rootEl || !rootEl.isConnected) continue;

      const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT);
      let node: Node | null = walker.nextNode();
      while (node) {
        if (processed >= MAX_NODES_PER_FRAME || performance.now() - started >= MAX_MS_PER_FRAME) {
          for (let j = i; j < roots.length; j += 1) {
            if (roots[j]?.isConnected) this.pendingRoots.add(roots[j]!);
          }
          this.rafId = requestAnimationFrame(() => this.flushQueue());
          return;
        }
        if (this.translateTextNode(node as Text)) {
          processed += 1;
        }
        node = walker.nextNode();
      }
    }
  }

  private translateTextNode(textNode: Text): boolean {
    const parent = textNode.parentElement;
    if (!parent || parent.closest(PROTECTED_SELECTOR)) return false;

    const full = textNode.nodeValue ?? '';
    const trimmedRaw = full.trim();
    const trimmed = trimmedRaw.replace(/\s+/g, ' ');
    if (!trimmed || trimmed.length > 420 || !ASCII_LETTER_RE.test(trimmed)) return false;
    if (BRAND_ALLOWLIST.has(trimmed)) return false;

    let translated: string | undefined;
    if (trimmed === 'New' && parent.closest('[data-testid="model-selector-panel"], [role="menu"]')) {
      translated = '新';
    } else {
      translated = EXACT_MAP[trimmed];
    }
    if (!translated && this.compiledPatterns) {
      for (const rule of this.compiledPatterns) {
        if (rule.re.test(trimmed)) {
          const candidate = trimmed.replace(rule.re, rule.replacement);
          if (candidate !== trimmed) {
            translated = candidate;
            break;
          }
        }
      }
    }
    if (!translated || translated === trimmed) return false;

    if (!this.originals.has(textNode)) {
      this.originals.set(textNode, full);
    }

    const startIdx = full.indexOf(trimmedRaw);
    const leading = startIdx > 0 ? full.slice(0, startIdx) : '';
    const trailing = startIdx >= 0 ? full.slice(startIdx + trimmedRaw.length) : '';
    const nextValue = `${leading}${translated}${trailing}`;
    this.appliedValues.set(textNode, nextValue);
    textNode.nodeValue = nextValue;
    this.translatedNodes.add(textNode);
    return true;
  }
}

window.__antigravityOrbit?.registerChannel(new ProtectedI18nChannel());
