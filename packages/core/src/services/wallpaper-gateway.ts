import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

const BLOCKED_SEGMENTS = [
  '/.ssh/',
  '/.aws/',
  '/.gnupg/',
  '/keychains/',
  '/library/application support/antigravity/',
  '/library/application support/antigravity orbit/',
  '/appdata/roaming/antigravity/',
  '/appdata/roaming/antigravity orbit/',
];

export function isWallpaperPathAllowed(rawPath: string): { ok: true; realPath: string; mime: string } | { ok: false; reason: string } {
  if (!rawPath || rawPath.startsWith('\\\\') || rawPath.includes('\0')) {
    return { ok: false, reason: 'Invalid or UNC path' };
  }
  const ext = path.extname(rawPath).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) {
    return { ok: false, reason: `Unsupported media extension: ${ext || '(none)'}` };
  }
  let realPath: string;
  try {
    realPath = fs.realpathSync(rawPath);
  } catch {
    return { ok: false, reason: 'File does not exist' };
  }

  const normalized = realPath.replaceAll('\\', '/').toLowerCase();
  if (path.basename(normalized).startsWith('.env')) {
    return { ok: false, reason: 'Sensitive file blocked' };
  }
  for (const seg of BLOCKED_SEGMENTS) {
    if (normalized.includes(seg)) {
      return { ok: false, reason: 'Sensitive directory blocked' };
    }
  }
  return { ok: true, realPath, mime };
}

/**
 * Loopback-only HTTP 206 Range streaming gateway for local static/video wallpapers.
 */
export class WallpaperGateway {
  private readonly token = crypto.randomBytes(32).toString('hex');
  private server: http.Server | null = null;
  private port: number | null = null;
  private activeFile: { realPath: string; mime: string } | null = null;

  async start(): Promise<number> {
    if (this.port !== null) return this.port;
    const server = http.createServer((req, res) => this.handleRequest(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        const addr = server.address();
        if (addr && typeof addr === 'object') {
          this.port = addr.port;
        }
        this.server = server;
        resolve();
      });
    });
    return this.port!;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const srv = this.server;
    this.server = null;
    this.port = null;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }

  setActivePath(rawPath: string): { url: string; mime: string } | null {
    if (!rawPath) {
      this.activeFile = null;
      return null;
    }
    const check = isWallpaperPathAllowed(rawPath);
    if (!check.ok) {
      this.activeFile = null;
      throw new Error(check.reason);
    }
    this.activeFile = { realPath: check.realPath, mime: check.mime };
    if (this.port === null) return null;
    return {
      url: `http://127.0.0.1:${this.port}/wallpaper?token=${this.token}`,
      mime: check.mime,
    };
  }

  getActiveUrl(): { url: string; mime: string } | null {
    if (!this.activeFile || this.port === null) return null;
    return {
      url: `http://127.0.0.1:${this.port}/wallpaper?token=${this.token}`,
      mime: this.activeFile.mime,
    };
  }

  private verifyToken(candidate: string | null): boolean {
    if (!candidate || candidate.length !== this.token.length) return false;
    return crypto.timingSafeEqual(Buffer.from(candidate, 'utf8'), Buffer.from(this.token, 'utf8'));
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const expectedHost = `127.0.0.1:${this.port}`;
    if (req.headers.host !== expectedHost) {
      res.writeHead(403).end('Forbidden host');
      return;
    }

    const url = new URL(req.url ?? '/', `http://${expectedHost}`);
    if (url.pathname !== '/wallpaper' || !this.verifyToken(url.searchParams.get('token'))) {
      res.writeHead(401).end('Unauthorized');
      return;
    }

    if (!this.activeFile) {
      res.writeHead(404).end('No active wallpaper');
      return;
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.activeFile.realPath);
    } catch {
      res.writeHead(404).end('Not found');
      return;
    }

    const total = stat.size;
    const rangeHeader = req.headers.range;
    const commonHeaders = {
      'Content-Type': this.activeFile.mime,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    };

    if (rangeHeader && rangeHeader.startsWith('bytes=')) {
      const [startStr, endStr] = rangeHeader.slice(6).split('-');
      const start = startStr ? Number.parseInt(startStr, 10) : 0;
      const end = endStr ? Math.min(total - 1, Number.parseInt(endStr, 10)) : total - 1;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end || start >= total) {
        res.writeHead(416, { 'Content-Range': `bytes */${total}` }).end();
        return;
      }
      res.writeHead(206, {
        ...commonHeaders,
        'Content-Range': `bytes ${start}-${end}/${total}`,
        'Content-Length': end - start + 1,
      });
      fs.createReadStream(this.activeFile.realPath, { start, end }).pipe(res);
      return;
    }

    res.writeHead(200, { ...commonHeaders, 'Content-Length': total });
    fs.createReadStream(this.activeFile.realPath).pipe(res);
  }
}
