import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import type { IpcEvent, IpcMethod, IpcRequest, IpcResponse } from '@antigravity-orbit/shared';
import { atomicWritePrivateFile, ensurePrivateDir, type AntigravityOrbitPaths } from '../platform/paths.js';

export type IpcHandler = (
  method: IpcMethod,
  params: Record<string, unknown> | undefined,
) => Promise<unknown> | unknown;

const MAX_LINE_BYTES = 2 * 1024 * 1024;

export class LocalIpcServer {
  private readonly paths: AntigravityOrbitPaths;
  private readonly handler: IpcHandler;
  private readonly authToken: string;
  private readonly clients = new Set<net.Socket>();
  private server: net.Server | null = null;

  constructor(paths: AntigravityOrbitPaths, handler: IpcHandler) {
    this.paths = paths;
    this.handler = handler;
    this.authToken = crypto.randomBytes(32).toString('hex');
  }

  getAuthToken(): string {
    return this.authToken;
  }

  getEndpoint(): string {
    return this.paths.ipcEndpoint;
  }

  async start(): Promise<void> {
    ensurePrivateDir(this.paths.stateDir);
    if (process.platform !== 'win32' && fs.existsSync(this.paths.ipcEndpoint)) {
      fs.unlinkSync(this.paths.ipcEndpoint);
    }

    await new Promise<void>((resolve, reject) => {
      const server = net.createServer((socket) => this.handleConnection(socket));
      server.once('error', reject);
      server.listen(this.paths.ipcEndpoint, () => {
        server.off('error', reject);
        this.server = server;
        if (process.platform !== 'win32') {
          fs.chmodSync(this.paths.ipcEndpoint, 0o600);
        }
        resolve();
      });
    });

    atomicWritePrivateFile(
      this.paths.sessionFile,
      `${JSON.stringify(
        {
          endpoint: this.paths.ipcEndpoint,
          authToken: this.authToken,
          pid: process.pid,
          startedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
    );
  }

  broadcast(event: IpcEvent): void {
    const frame = `${JSON.stringify(event)}\n`;
    setImmediate(() => {
      for (const socket of this.clients) {
        if (!socket.destroyed && socket.writable) {
          socket.write(frame);
        }
      }
    });
  }

  async stop(): Promise<void> {
    for (const socket of this.clients) {
      socket.destroy();
    }
    this.clients.clear();

    if (this.server) {
      const srv = this.server;
      this.server = null;
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }

    if (process.platform !== 'win32' && fs.existsSync(this.paths.ipcEndpoint)) {
      try {
        fs.unlinkSync(this.paths.ipcEndpoint);
      } catch {
        // Ignore cleanup errors on shutdown
      }
    }
  }

  private verifyToken(candidate: string | undefined): boolean {
    if (typeof candidate !== 'string' || candidate.length !== this.authToken.length) {
      return false;
    }
    return crypto.timingSafeEqual(Buffer.from(candidate, 'utf8'), Buffer.from(this.authToken, 'utf8'));
  }

  private handleConnection(socket: net.Socket): void {
    this.clients.add(socket);
    let buffer = '';

    socket.setEncoding('utf8');
    socket.on('close', () => this.clients.delete(socket));
    socket.on('error', () => this.clients.delete(socket));

    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_LINE_BYTES) {
        socket.destroy();
        return;
      }

      let newlineIdx = buffer.indexOf('\n');
      while (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (line.length > 0) {
          void this.dispatchLine(socket, line);
        }
        newlineIdx = buffer.indexOf('\n');
      }
    });
  }

  private async dispatchLine(socket: net.Socket, line: string): Promise<void> {
    let req: IpcRequest;
    try {
      req = JSON.parse(line) as IpcRequest;
    } catch {
      this.sendResponse(socket, {
        id: 'unknown',
        ok: false,
        error: { code: 'BAD_JSON', message: 'Invalid JSON frame' },
      });
      return;
    }

    if (!this.verifyToken(req.authToken)) {
      this.sendResponse(socket, {
        id: req.id ?? 'unknown',
        ok: false,
        error: { code: 'UNAUTHORIZED', message: 'Invalid IPC auth token' },
      });
      return;
    }

    try {
      const result = await this.handler(req.method, req.params);
      this.sendResponse(socket, { id: req.id, ok: true, result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.sendResponse(socket, {
        id: req.id,
        ok: false,
        error: { code: 'HANDLER_ERROR', message },
      });
    }
  }

  private sendResponse(socket: net.Socket, res: IpcResponse): void {
    if (!socket.destroyed && socket.writable) {
      socket.write(`${JSON.stringify(res)}\n`);
    }
  }
}
