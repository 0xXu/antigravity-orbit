/**
 * Clean-room 512K Liquid Context Vial renderer.
 * 24-node damped shallow-water wave simulation + rising bubble pool.
 * Strictly settles to 0fps after 1100ms of inactivity and resizes to 0x0 on VRAM reclaim.
 */
const NODES = 24;
const SETTLE_MS = 1100;

interface Bubble {
  x: number;
  y: number;
  r: number;
  vy: number;
}

export class LiquidVialCanvas {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null = null;
  private targetFill = 0.08;
  private currentFill = 0.08;
  private heights = new Float32Array(NODES);
  private velocities = new Float32Array(NODES);
  private bubbles: Bubble[] = [];
  private rafId: number | null = null;
  private lastExciteAt = 0;
  private hidden = false;
  private width = 22;
  private height = 30;

  constructor(width = 22, height = 30) {
    this.width = width;
    this.height = height;
    this.canvas = document.createElement('canvas');
    this.canvas.width = width * 2;
    this.canvas.height = height * 2;
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.ctx = this.canvas.getContext('2d');
    for (let i = 0; i < 4; i++) {
      this.bubbles.push({
        x: Math.random() * width,
        y: height * (0.4 + Math.random() * 0.5),
        r: 0.9 + Math.random() * 1.1,
        vy: 8 + Math.random() * 10,
      });
    }
    this.drawFrame();
  }

  setFillRatio(ratio: number, excite = true): void {
    const clamped = Math.min(1, Math.max(0.02, ratio));
    const delta = Math.abs(clamped - this.targetFill);
    this.targetFill = clamped;
    if (excite && delta > 0.002) {
      this.velocities[Math.floor(NODES / 2)] = (clamped > this.currentFill ? -1 : 1) * 1.8;
      this.excite();
    } else {
      this.drawFrame();
    }
  }

  excite(): void {
    if (this.hidden) return;
    this.lastExciteAt = performance.now();
    if (this.rafId === null) {
      this.rafId = requestAnimationFrame((now) => this.tick(now));
    }
  }

  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    if (hidden) {
      this.reclaimVram();
    } else {
      this.canvas.width = this.width * 2;
      this.canvas.height = this.height * 2;
      this.ctx = this.canvas.getContext('2d');
      this.drawFrame();
    }
  }

  reclaimVram(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.canvas.width = 0;
    this.canvas.height = 0;
  }

  private tick(now: number): void {
    this.rafId = null;
    const dt = 1 / 60;

    // Ease fill level
    this.currentFill += (this.targetFill - this.currentFill) * 0.14;

    // Shallow-water damped spring wave
    const k = 120;
    const damp = 6.5;
    for (let i = 0; i < NODES; i++) {
      const h = this.heights[i]!;
      const left = this.heights[Math.max(0, i - 1)]!;
      const right = this.heights[Math.min(NODES - 1, i + 1)]!;
      const force = -k * h + 45 * (left + right - 2 * h) - damp * this.velocities[i]!;
      this.velocities[i] = this.velocities[i]! + force * dt;
    }
    for (let i = 0; i < NODES; i++) {
      this.heights[i] = this.heights[i]! + this.velocities[i]! * dt;
    }

    // Bubbles
    const surfaceY = this.height * (1 - this.currentFill);
    for (const b of this.bubbles) {
      b.y -= b.vy * dt;
      if (b.y < surfaceY + 2) {
        b.y = this.height - 2;
        b.x = 3 + Math.random() * (this.width - 6);
      }
    }

    this.drawFrame();

    if (!this.hidden && now - this.lastExciteAt < SETTLE_MS) {
      this.rafId = requestAnimationFrame((t) => this.tick(t));
    }
  }

  private drawFrame(): void {
    const ctx = this.ctx;
    if (!ctx || this.canvas.width === 0) return;

    ctx.save();
    ctx.scale(2, 2);
    ctx.clearRect(0, 0, this.width, this.height);

    // Glass vial outline
    const pad = 2;
    const w = this.width - pad * 2;
    const h = this.height - pad * 2;
    ctx.beginPath();
    ctx.roundRect(pad, pad, w, h, 6);
    ctx.save();
    ctx.clip();

    // Liquid color by fill ratio
    const color =
      this.currentFill > 0.85 ? '#ef4444' : this.currentFill > 0.65 ? '#f59e0b' : '#3b82f6';
    const baseY = pad + h * (1 - this.currentFill);

    ctx.beginPath();
    ctx.moveTo(pad, pad + h);
    for (let i = 0; i < NODES; i++) {
      const x = pad + (i / (NODES - 1)) * w;
      const y = baseY + this.heights[i]! * 1.4;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(pad + w, pad + h);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.82;
    ctx.fill();

    // Bubbles
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    for (const b of this.bubbles) {
      if (b.y > baseY + 1) {
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();

    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }
}
