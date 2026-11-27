import { execFile, spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface HostProcessStatus {
  readonly hostRunning: boolean;
  readonly bareHostDetected: boolean;
}

export function isAntigravityMainProcess(args: string): boolean {
  const trimmed = args.trim();
  if (!trimmed) return false;
  if (
    trimmed.includes('--type=renderer') ||
    trimmed.includes('--type=gpu-process') ||
    trimmed.includes('--type=utility') ||
    trimmed.includes('--type=zygote') ||
    trimmed.includes('chrome_crashpad_handler') ||
    trimmed.includes('language_server')
  ) {
    return false;
  }
  if (process.platform === 'darwin') {
    return trimmed.includes('/Applications/Antigravity.app/Contents/MacOS/');
  }
  if (process.platform === 'win32') {
    return /antigravity\.exe/i.test(trimmed);
  }
  return /(?:^|\/)antigravity(?:\s|$)/i.test(trimmed);
}

export function hasRemoteDebuggingPortArg(args: string): boolean {
  return /(?:^|\s)--remote-debugging-port(?:=|\s|$)/i.test(args);
}

export async function detectAntigravityHostStatus(cdpPort: number | null): Promise<HostProcessStatus> {
  if (cdpPort !== null) {
    return { hostRunning: true, bareHostDetected: false };
  }
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('tasklist', ['/FI', 'IMAGENAME eq Antigravity.exe', '/NH'], {
        timeout: 2500,
      });
      const hostRunning = /antigravity\.exe/i.test(stdout);
      return { hostRunning, bareHostDetected: hostRunning };
    }
    const { stdout } = await execFileAsync('/bin/ps', ['-ax', '-o', 'args='], {
      timeout: 2500,
      maxBuffer: 4 * 1024 * 1024,
    });
    const mainLines = stdout.split(/\r?\n/).filter((line) => isAntigravityMainProcess(line));
    const hostRunning = mainLines.length > 0;
    const anyWithCdpArg = mainLines.some((line) => hasRemoteDebuggingPortArg(line));
    return { hostRunning, bareHostDetected: hostRunning && !anyWithCdpArg };
  } catch {
    return { hostRunning: false, bareHostDetected: false };
  }
}

export function resolveAntigravityStateDbPath(): string {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Antigravity', 'User', 'globalStorage', 'state.vscdb');
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'Antigravity', 'User', 'globalStorage', 'state.vscdb');
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return path.join(xdg, 'Antigravity', 'User', 'globalStorage', 'state.vscdb');
}

export async function findAntigravityMainPids(): Promise<number[]> {
  if (process.platform === 'win32') return [];
  try {
    const { stdout } = await execFileAsync('/bin/ps', ['-ax', '-o', 'pid=,args='], {
      timeout: 2500,
      maxBuffer: 4 * 1024 * 1024,
    });
    const pids: number[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      const m = line.trim().match(/^(\d+)\s+(.*)$/);
      if (!m) continue;
      const pid = Number(m[1]);
      if (Number.isInteger(pid) && pid > 1 && isAntigravityMainProcess(m[2]!)) {
        pids.push(pid);
      }
    }
    return pids;
  } catch {
    return [];
  }
}

export async function gracefulQuitAntigravity(timeoutMs = 5000): Promise<boolean> {
  if (process.platform === 'darwin') {
    // Send SIGTERM directly first — requires ZERO macOS TCC Automation permissions,
    // so it works reliably even when invoked from a headless launchd background daemon.
    const pids = await findAntigravityMainPids();
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Ignore already-exited PID
      }
    }
    if (pids.length === 0) {
      await execFileAsync('osascript', ['-e', 'tell application "Antigravity" to quit'], {
        timeout: 3000,
      }).catch(() => {});
    }
  } else if (process.platform === 'win32') {
    await execFileAsync('taskkill', ['/IM', 'Antigravity.exe'], { timeout: 3000 }).catch(() => {});
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = await detectAntigravityHostStatus(null);
    if (!st.hostRunning) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

export function spawnAntigravityWithCdp(proxy: { mode: string; manualUrl: string }): string {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;

  if (proxy.mode === 'manual' && proxy.manualUrl) {
    env.HTTP_PROXY = proxy.manualUrl;
    env.HTTPS_PROXY = proxy.manualUrl;
    env.NODE_USE_ENV_PROXY = '1';
  }

  if (process.platform === 'darwin') {
    const child = spawn('open', ['-a', '/Applications/Antigravity.app', '--args', '--remote-debugging-port=0'], {
      detached: true,
      stdio: 'ignore',
      env,
    });
    child.unref();
    return 'open -a /Applications/Antigravity.app --args --remote-debugging-port=0';
  }

  const exe = path.join(
    process.env.LOCALAPPDATA || '',
    'Programs',
    'Antigravity',
    'Antigravity.exe',
  );
  const child = spawn(exe, ['--remote-debugging-port=0'], {
    detached: true,
    stdio: 'ignore',
    env,
  });
  child.unref();
  return exe;
}
