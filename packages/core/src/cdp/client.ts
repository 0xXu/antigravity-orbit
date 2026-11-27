import { EventEmitter } from 'node:events';
import { assertLoopbackWsUrl } from './discovery.js';

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export interface CdpClientLike {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  on(event: 'event', listener: (method: string, params: Record<string, unknown>) => void): this;
  on(event: 'close', listener: () => void): this;
  close(): void;
}

export class CdpClient
  extends EventEmitter<{
    event: [method: string, params: Record<string, unknown>];
    close: [];
  }>
  implements CdpClientLike
{
  private readonly wsUrl: string;
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingCall>();

  constructor(wsUrl: string) {
    super();
    assertLoopbackWsUrl(wsUrl);
    this.wsUrl = wsUrl;
  }

  async connect(timeoutMs = 5000): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`CDP connect timed out (${timeoutMs}ms)`));
      }, timeoutMs);

      ws.addEventListener('open', () => {
        clearTimeout(timer);
        this.ws = ws;
        resolve();
      });

      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error(`CDP WebSocket error on ${this.wsUrl}`));
      });

      ws.addEventListener('close', () => {
        for (const [id, entry] of this.pending) {
          clearTimeout(entry.timer);
          entry.reject(new Error('CDP connection closed'));
          this.pending.delete(id);
        }
        this.ws = null;
        this.emit('close');
      });

      ws.addEventListener('message', (ev) => {
        const text = typeof ev.data === 'string' ? ev.data : String(ev.data);
        let msg: {
          id?: number;
          result?: unknown;
          error?: { message?: string };
          method?: string;
          params?: Record<string, unknown>;
        };
        try {
          msg = JSON.parse(text);
        } catch {
          return;
        }

        if (typeof msg.id === 'number') {
          const entry = this.pending.get(msg.id);
          if (!entry) return;
          this.pending.delete(msg.id);
          clearTimeout(entry.timer);
          if (msg.error) {
            entry.reject(new Error(msg.error.message || 'CDP error'));
          } else {
            entry.resolve(msg.result);
          }
        } else if (typeof msg.method === 'string') {
          this.emit('event', msg.method, msg.params ?? {});
        }
      });
    });
  }

  send<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 10_000,
  ): Promise<T> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('CDP socket is not open'));
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP call timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }
}
