/**
 * Zero-DOM-mutation 5-tier ink stream fade-in using W3C CSS Custom Highlight API.
 * Strictly cancels requestAnimationFrame when no active ranges remain (0fps idle).
 */
interface FadeEntry {
  range: Range;
  startedAt: number;
}

const BUCKET_NAMES = ['pb-ink-f0', 'pb-ink-f1', 'pb-ink-f2', 'pb-ink-f3', 'pb-ink-f4'] as const;
const DURATION_MS = 220;
const MAX_RANGES = 48;

export class InkStreamEngine {
  private enabled = false;
  private rafId: number | null = null;
  private entries: FadeEntry[] = [];

  setEnabled(next: boolean): void {
    this.enabled = next;
    if (!next) this.clear();
  }

  enqueueTextNode(node: Text): void {
    if (!this.enabled || typeof CSS === 'undefined' || !('highlights' in CSS)) return;
    if (!node.isConnected || node.length === 0) return;

    const range = document.createRange();
    range.selectNodeContents(node);
    this.entries.push({ range, startedAt: performance.now() });
    if (this.entries.length > MAX_RANGES) {
      this.entries.splice(0, this.entries.length - MAX_RANGES);
    }
    this.scheduleTick();
  }

  clear(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.entries = [];
    if (typeof CSS !== 'undefined' && 'highlights' in CSS) {
      for (const name of BUCKET_NAMES) {
        CSS.highlights.delete(name);
      }
    }
  }

  private scheduleTick(): void {
    if (this.rafId !== null) return;
    this.rafId = requestAnimationFrame((now) => {
      this.rafId = null;
      this.tick(now);
    });
  }

  private tick(now: number): void {
    if (typeof CSS === 'undefined' || !('highlights' in CSS)) return;
    const buckets: Range[][] = [[], [], [], [], []];
    const remaining: FadeEntry[] = [];

    for (const entry of this.entries) {
      if (!entry.range.startContainer.isConnected) continue;
      const elapsed = now - entry.startedAt;
      if (elapsed >= DURATION_MS) continue;
      const idx = Math.min(4, Math.floor((elapsed / DURATION_MS) * 5));
      buckets[idx]?.push(entry.range);
      remaining.push(entry);
    }

    this.entries = remaining;
    for (let i = 0; i < BUCKET_NAMES.length; i++) {
      const name = BUCKET_NAMES[i]!;
      const list = buckets[i]!;
      if (list.length > 0) {
        CSS.highlights.set(name, new Highlight(...list));
      } else {
        CSS.highlights.delete(name);
      }
    }

    if (this.entries.length > 0) {
      this.scheduleTick();
    }
  }
}
