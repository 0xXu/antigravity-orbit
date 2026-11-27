import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface DiscoveredCdpEndpoint {
  readonly port: number;
  readonly browserWsUrl: string;
  readonly sourceFile: string;
}

export interface CdpPageTarget {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly url: string;
  readonly webSocketDebuggerUrl?: string;
}

export function assertLoopbackWsUrl(wsUrl: string): void {
  const parsed = new URL(wsUrl);
  if (parsed.protocol !== 'ws:') {
    throw new Error(`Refusing non-ws CDP URL: ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('Refusing CDP URL containing credentials');
  }
  const host = parsed.hostname;
  if (host !== '127.0.0.1' && host !== '::1' && host !== '[::1]' && host !== 'localhost') {
    throw new Error(`Refusing non-loopback CDP host: ${host}`);
  }
}

export function candidateDevToolsPortFiles(): string[] {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    const appSupport = path.join(home, 'Library', 'Application Support');
    return [
      path.join(appSupport, 'Antigravity', 'DevToolsActivePort'),
      path.join(appSupport, 'Google', 'Antigravity', 'DevToolsActivePort'),
    ];
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return [
      path.join(appData, 'Antigravity', 'DevToolsActivePort'),
      path.join(localAppData, 'Antigravity', 'DevToolsActivePort'),
    ];
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return [path.join(xdg, 'Antigravity', 'DevToolsActivePort')];
}

export function discoverCdpEndpoint(overrideFiles?: string[]): DiscoveredCdpEndpoint | null {
  if (!overrideFiles && process.env.ANTIGRAVITY_ORBIT_DISABLE_CDP === '1') {
    return null;
  }
  const files = overrideFiles ?? candidateDevToolsPortFiles();
  for (const file of files) {
    try {
      if (!fs.existsSync(file)) continue;
      const lines = fs
        .readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const port = Number.parseInt(lines[0] ?? '', 10);
      const wsPath = lines[1] ?? '';
      if (!Number.isInteger(port) || port < 1024 || port > 65535 || !wsPath.startsWith('/')) {
        continue;
      }
      const browserWsUrl = `ws://127.0.0.1:${port}${wsPath}`;
      assertLoopbackWsUrl(browserWsUrl);
      return { port, browserWsUrl, sourceFile: file };
    } catch {
      continue;
    }
  }
  return null;
}

export async function listCdpPageTargets(port: number): Promise<CdpPageTarget[]> {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
    signal: AbortSignal.timeout(2000),
  });
  if (!res.ok) {
    throw new Error(`CDP /json/list failed with HTTP ${res.status}`);
  }
  const targets = (await res.json()) as CdpPageTarget[];
  return targets.filter(
    (t) =>
      t.type === 'page' &&
      typeof t.webSocketDebuggerUrl === 'string' &&
      (t.url.startsWith('http://') || t.url.startsWith('https://')),
  );
}
