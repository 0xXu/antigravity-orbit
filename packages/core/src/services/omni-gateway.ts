import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const OMNI_MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.csv': 'text/csv; charset=utf-8',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff2': 'font/woff2',
};

const SENSITIVE_DIRS = ['/.ssh/', '/.aws/', '/.gnupg/', '/keychains/', '/antigravity-orbit/'];

/**
 * Loopback-only HTTP 206 Range streaming gateway for Omni Viewer.
 * Uses per-directory HMAC-SHA256 scoped tokens + strict sandbox CSP for HTML previews.
 */
export class OmniStreamingGateway {
  private readonly masterSecret = crypto.randomBytes(32);
  private server: http.Server | null = null;
  private port: number | null = null;

  async start(): Promise<number> {
    if (this.port !== null) return this.port;
    const server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        const addr = server.address();
        if (addr && typeof addr === 'object') this.port = addr.port;
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

  signFileUrl(filePath: string, ttlMs = 30 * 60_000): { url: string; mime: string } {
    if (this.port === null) throw new Error('Omni gateway not started');
    const realPath = fs.realpathSync(filePath);
    const normalized = realPath.replaceAll('\\', '/').toLowerCase();
    if (path.basename(normalized).startsWith('.env') || SENSITIVE_DIRS.some((s) => normalized.includes(s))) {
      throw new Error('Blocked sensitive path');
    }
    const ext = path.extname(realPath).toLowerCase();
    const mime = OMNI_MIME[ext];
    if (!mime) throw new Error(`Unsupported Omni media type: ${ext}`);

    const dir = path.dirname(realPath);
    const exp = Date.now() + ttlMs;
    const sig = this.computeHmac(dir, exp);
    const qs = new URLSearchParams({
      file: realPath,
      dir,
      exp: String(exp),
      sig,
    });
    return {
      url: `http://127.0.0.1:${this.port}/omni?${qs.toString()}`,
      mime,
    };
  }

  private computeHmac(dir: string, exp: number): string {
    return crypto
      .createHmac('sha256', this.masterSecret)
      .update(`${dir}\0${exp}`)
      .digest('hex');
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const expectedHost = `127.0.0.1:${this.port}`;
    if (req.headers.host !== expectedHost) {
      res.writeHead(403).end('Forbidden host');
      return;
    }

    const url = new URL(req.url ?? '/', `http://${expectedHost}`);
    if (url.pathname !== '/omni') {
      res.writeHead(404).end('Not found');
      return;
    }

    const file = url.searchParams.get('file') ?? '';
    const dir = url.searchParams.get('dir') ?? '';
    const exp = Number.parseInt(url.searchParams.get('exp') ?? '0', 10);
    const sig = url.searchParams.get('sig') ?? '';

    if (!file || !dir || !Number.isFinite(exp) || Date.now() > exp) {
      res.writeHead(401).end('Expired or missing token');
      return;
    }

    const expectedSig = this.computeHmac(dir, exp);
    if (
      sig.length !== expectedSig.length ||
      !crypto.timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(expectedSig, 'utf8'))
    ) {
      res.writeHead(401).end('Invalid HMAC signature');
      return;
    }

    let realFile: string;
    let realDir: string;
    try {
      realFile = fs.realpathSync(file);
      realDir = fs.realpathSync(dir);
    } catch {
      res.writeHead(404).end('Not found');
      return;
    }

    // Strict single-directory scope enforcement
    if (path.dirname(realFile) !== realDir) {
      res.writeHead(403).end('Path escapes scoped directory');
      return;
    }

    const ext = path.extname(realFile).toLowerCase();
    const mime = OMNI_MIME[ext];
    if (!mime) {
      res.writeHead(403).end('Unsupported type');
      return;
    }

    const stat = fs.statSync(realFile);
    const headers: Record<string, string | number> = {
      'Content-Type': mime,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox allow-scripts; default-src 'self' 'unsafe-inline'; connect-src 'none'",
    };

    const range = req.headers.range;
    if (range && range.startsWith('bytes=')) {
      const [s, e] = range.slice(6).split('-');
      const start = s ? Number.parseInt(s, 10) : 0;
      const end = e ? Math.min(stat.size - 1, Number.parseInt(e, 10)) : stat.size - 1;
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end || start >= stat.size) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }).end();
        return;
      }
      res.writeHead(206, {
        ...headers,
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Content-Length': end - start + 1,
      });
      fs.createReadStream(realFile, { start, end }).pipe(res);
      return;
    }

    res.writeHead(200, { ...headers, 'Content-Length': stat.size });
    fs.createReadStream(realFile).pipe(res);
  }
}
