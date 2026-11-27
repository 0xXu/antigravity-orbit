import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export interface AntigravityOrbitPaths {
  readonly stateDir: string;
  readonly cacheDir: string;
  readonly configFile: string;
  readonly sessionFile: string;
  readonly ipcEndpoint: string;
}

export function resolveStateDir(overrideDir?: string): string {
  if (overrideDir) return path.resolve(overrideDir);
  const envDir = process.env.ANTIGRAVITY_ORBIT_STATE_DIR;
  if (envDir) return path.resolve(envDir);

  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Antigravity Orbit');
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'Antigravity Orbit');
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(xdg, 'antigravity-orbit');
}

export function resolveCacheDir(stateDir: string): string {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Caches', 'Antigravity Orbit');
  }
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(localAppData, 'Antigravity Orbit', 'Cache');
  }
  return path.join(stateDir, 'cache');
}

export function resolvePaths(overrideStateDir?: string): AntigravityOrbitPaths {
  const stateDir = resolveStateDir(overrideStateDir);
  const cacheDir = resolveCacheDir(stateDir);
  const stateHash = crypto.createHash('sha256').update(stateDir).digest('hex').slice(0, 12);

  const ipcEndpoint =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\antigravity-orbit-${stateHash}-${crypto.randomBytes(8).toString('hex')}`
      : path.join(stateDir, 'daemon.sock');

  return {
    stateDir,
    cacheDir,
    configFile: path.join(stateDir, 'config.json'),
    sessionFile: path.join(stateDir, 'ipc-session.json'),
    ipcEndpoint,
  };
}

export function ensurePrivateDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    fs.chmodSync(dirPath, 0o700);
  }
}

export function atomicWritePrivateFile(filePath: string, content: string): void {
  ensurePrivateDir(path.dirname(filePath));
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmpPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  fs.renameSync(tmpPath, filePath);
  if (process.platform !== 'win32') {
    fs.chmodSync(filePath, 0o600);
  }
}
