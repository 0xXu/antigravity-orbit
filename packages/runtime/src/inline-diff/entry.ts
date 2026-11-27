import type { VisualChannelContract } from '@antigravity-orbit/shared';

interface DiffRpcResponse {
  readonly diff: string;
}

const TARGET_SELECTOR =
  '[data-testid="diff-line-count"], [data-testid="file-change-pill"], [data-testid="changed-files-card"] [data-file-path]';

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function inferRepoAndFile(el: HTMLElement): { repoRoot: string; file: string } | null {
  const row =
    el.closest<HTMLElement>('[data-file-path], [data-testid="file-change-pill"], [data-testid="changed-files-card"] li, [data-testid="changed-files-card"] button, [data-testid="changed-files-card"] a') ??
    el.parentElement ??
    el;

  const explicitRoot =
    row.getAttribute('data-repo-root') ??
    row.closest<HTMLElement>('[data-workspace-root]')?.getAttribute('data-workspace-root') ??
    document.querySelector<HTMLElement>('[data-workspace-root]')?.getAttribute('data-workspace-root') ??
    '';

  const explicitFile =
    row.getAttribute('data-file-path') ??
    row.getAttribute('title') ??
    row.querySelector<HTMLElement>('[data-file-path]')?.getAttribute('data-file-path') ??
    row.querySelector<HTMLElement>('[title*="/"]')?.getAttribute('title') ??
    '';

  let rawPath = explicitFile.trim();
  if (!rawPath) {
    const link = row.querySelector<HTMLAnchorElement>('a[href^="file://"]');
    if (link?.href) {
      rawPath = decodeURIComponent(link.href.replace(/^file:\/\//, ''));
    }
  }
  if (!rawPath) {
    const candidateText = (row.textContent ?? '')
      .replace(/[+\-]\d+/g, ' ')
      .replace(/\bDiff\b/g, ' ')
      .trim()
      .split(/\s+/)
      .find((tok) => tok.includes('/') || /\.[a-z0-9]{1,8}$/i.test(tok));
    if (candidateText) rawPath = candidateText;
  }

  if (!rawPath) return null;

  // If rawPath is absolute and explicitRoot is known, derive relative path
  if (explicitRoot && rawPath.startsWith(explicitRoot)) {
    const rel = rawPath.slice(explicitRoot.length).replace(/^[/\\]+/, '');
    if (rel) return { repoRoot: explicitRoot, file: rel };
  }

  // If explicitRoot is missing, inspect document for any absolute workspace path hint
  if (!explicitRoot) {
    const anyFileLink = document.querySelector<HTMLAnchorElement>('a[href^="file:///"]');
    const absHint = anyFileLink ? decodeURIComponent(anyFileLink.href.replace(/^file:\/\//, '')) : '';
    if (rawPath.startsWith('/')) {
      const idx = rawPath.lastIndexOf('/');
      if (idx > 1) {
        return { repoRoot: rawPath.slice(0, idx), file: rawPath.slice(idx + 1) };
      }
    }
    if (absHint) {
      const parts = absHint.split('/');
      if (parts.length > 3) {
        return { repoRoot: parts.slice(0, 4).join('/'), file: rawPath };
      }
    }
    return null;
  }

  return { repoRoot: explicitRoot, file: rawPath };
}

function formatDiffLines(diffText: string): string {
  if (!diffText.trim()) {
    return '<div class="empty">当前文件无未提交的 Git 差异。</div>';
  }
  return diffText
    .split('\n')
    .slice(0, 400)
    .map((line) => {
      const safe = escapeHtml(line);
      if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff --git')) {
        return `<div class="line meta">${safe}</div>`;
      }
      if (line.startsWith('@@')) {
        return `<div class="line hunk">${safe}</div>`;
      }
      if (line.startsWith('+')) {
        return `<div class="line add">${safe}</div>`;
      }
      if (line.startsWith('-')) {
        return `<div class="line del">${safe}</div>`;
      }
      return `<div class="line ctx">${safe}</div>`;
    })
    .join('');
}

/**
 * Ch07: Safe Inline Diff Channel.
 * Observes changed-file counters/pills via MutationObserver and renders collapsible
 * Shadow DOM unified diff cards backed by Core's fail-closed `diff.file` RPC.
 */
class InlineDiffChannel implements VisualChannelContract {
  readonly id = 'ch07-inline-diff' as const;
  private observer: MutationObserver | null = null;
  private readonly hosts = new Set<HTMLElement>();

  mount(root: Document): void {
    const target = root.body ?? root.documentElement;
    if (!target) return;

    this.scan(root, target);
    this.observer = new MutationObserver((records) => {
      for (const rec of records) {
        for (const node of rec.addedNodes) {
          if (node instanceof HTMLElement && !node.closest('[data-antigravity-orbit-owned]')) {
            this.scan(root, node);
          }
        }
      }
    });
    this.observer.observe(target, { childList: true, subtree: true });
  }

  onVisibilityChange(): void {}
  onWindowBlur(): void {}
  setBudgetMode(): void {}
  reclaimVram(): void {}

  dispose(): void {
    this.observer?.disconnect();
    this.observer = null;
    for (const h of this.hosts) h.remove();
    this.hosts.clear();
    document.querySelectorAll('[data-antigravity-orbit-diff-ready]').forEach((el) => {
      el.removeAttribute('data-antigravity-orbit-diff-ready');
    });
  }

  private scan(root: Document, container: Element): void {
    const targets: HTMLElement[] = [];
    if (container instanceof HTMLElement && container.matches(TARGET_SELECTOR)) {
      targets.push(container);
    }
    container.querySelectorAll<HTMLElement>(TARGET_SELECTOR).forEach((el) => targets.push(el));

    for (const pill of targets) {
      if (pill.closest('[data-antigravity-orbit-owned]')) continue;
      if (pill.hasAttribute('data-antigravity-orbit-diff-ready')) continue;
      pill.setAttribute('data-antigravity-orbit-diff-ready', 'true');
      this.attachDiffWidget(root, pill);
    }
  }

  private attachDiffWidget(root: Document, pill: HTMLElement): void {
    const host = root.createElement('span');
    host.setAttribute('data-antigravity-orbit-owned', 'true');
    const shadow = host.attachShadow({ mode: 'open' });

    shadow.innerHTML = `
      <style>
        :host { display: inline-block; vertical-align: middle; }
        .btn {
          margin-left: 6px; font-size: 10px; font-weight: 600; padding: 1px 7px;
          border-radius: 5px; border: 1px solid rgba(147,197,253,0.3);
          background: rgba(59,130,246,0.12); color: #93c5fd; cursor: pointer;
          font-family: -apple-system, BlinkMacSystemFont, sans-serif;
        }
        .btn:hover { background: rgba(59,130,246,0.22); }
        .panel {
          display: none; margin-top: 6px; border-radius: 8px; overflow: hidden;
          border: 1px solid rgba(255,255,255,0.12); background: #0d1017;
          box-shadow: 0 10px 28px rgba(0,0,0,0.45); max-width: 720px; text-align: left;
        }
        .panel.open { display: block; }
        .head {
          display: flex; align-items: center; justify-content: space-between; gap: 8px;
          padding: 6px 10px; background: rgba(255,255,255,0.04); border-bottom: 1px solid rgba(255,255,255,0.08);
          font-size: 11px; color: #d4d4d8; font-family: ui-monospace, SFMono-Regular, monospace;
        }
        .body {
          max-height: 280px; overflow: auto; padding: 6px 0;
          font-size: 11px; line-height: 1.45; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        }
        .line { padding: 0 10px; white-space: pre; }
        .line.add { background: rgba(34,197,94,0.14); color: #86efac; }
        .line.del { background: rgba(239,68,68,0.14); color: #fca5a5; }
        .line.hunk { background: rgba(59,130,246,0.14); color: #93c5fd; }
        .line.meta { color: #a1a1aa; font-weight: 600; }
        .line.ctx { color: #d4d4d8; }
        .empty { padding: 10px; color: #a1a1aa; font-family: system-ui, sans-serif; }
        .close {
          background: transparent; border: none; color: #a1a1aa; cursor: pointer; font-size: 12px;
        }
      </style>
      <button type="button" class="btn" id="toggle">Diff</button>
      <div class="panel" id="panel">
        <div class="head">
          <span id="title">Git Diff</span>
          <button type="button" class="close" id="close">✕</button>
        </div>
        <div class="body" id="body"><div class="empty">点击加载差异…</div></div>
      </div>
    `;

    const toggleBtn = shadow.getElementById('toggle') as HTMLButtonElement;
    const closeBtn = shadow.getElementById('close') as HTMLButtonElement;
    const panel = shadow.getElementById('panel') as HTMLDivElement;
    const titleEl = shadow.getElementById('title') as HTMLSpanElement;
    const bodyEl = shadow.getElementById('body') as HTMLDivElement;
    let loaded = false;

    closeBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      panel.classList.remove('open');
    });

    toggleBtn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      const willOpen = !panel.classList.contains('open');
      panel.classList.toggle('open', willOpen);
      if (!willOpen || loaded) return;

      const info = inferRepoAndFile(pill);
      if (!info) {
        bodyEl.innerHTML = '<div class="empty">未能从当前节点解析出仓库路径与相对文件名。</div>';
        return;
      }

      titleEl.textContent = info.file;
      bodyEl.innerHTML = '<div class="empty">正在安全拉取 Git Diff…</div>';
      try {
        const res = await window.__antigravityOrbit!.invokeRpc<DiffRpcResponse>('diff.file', {
          repoRoot: info.repoRoot,
          file: info.file,
        });
        bodyEl.innerHTML = formatDiffLines(res?.diff ?? '');
        loaded = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        bodyEl.innerHTML = `<div class="empty">无法读取差异：${escapeHtml(msg)}</div>`;
      }
    });

    pill.appendChild(host);
    this.hosts.add(host);
  }
}

window.__antigravityOrbit?.registerChannel(new InlineDiffChannel());
