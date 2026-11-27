import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AutoStartStatus } from '@antigravity-orbit/shared';
import { atomicWritePrivateFile } from './paths.js';

const MAC_LAUNCH_AGENT_LABEL = 'dev.antigravityorbit.app';
const WIN_REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const WIN_REG_VALUE = 'AntigravityOrbit';

export interface AutoStartOptions {
  readonly platform?: NodeJS.Platform;
  readonly homeDir?: string;
  readonly appPathOverride?: string;
}

function xmlEscape(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function resolveMacLaunchAgentPath(homeDir = os.homedir()): string {
  return path.join(homeDir, 'Library', 'LaunchAgents', `${MAC_LAUNCH_AGENT_LABEL}.plist`);
}

export function resolveMacAppBundlePath(homeDir = os.homedir(), override?: string): string {
  if (override) return override;
  const candidates = [
    '/Applications/Antigravity Orbit.app',
    path.join(homeDir, 'Applications', 'Antigravity Orbit.app'),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? '/Applications/Antigravity Orbit.app';
}

export function resolveWindowsDesktopExePath(override?: string): string {
  if (override) return override;
  const localAppData = process.env.LOCALAPPDATA ?? '';
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
  const candidates = [
    path.join(localAppData, 'Antigravity Orbit', 'Antigravity Orbit.exe'),
    path.join(programFiles, 'Antigravity Orbit', 'Antigravity Orbit.exe'),
  ];
  return candidates.find((p) => p && fs.existsSync(p)) ?? candidates[0]!;
}

export function buildMacLaunchAgentPlist(appBundlePath: string): string {
  const escapedBundle = xmlEscape(appBundlePath);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${MAC_LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/open</string>
    <string>-g</string>
    <string>-a</string>
    <string>${escapedBundle}</string>
    <string>--args</string>
    <string>--hidden</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
</dict>
</plist>
`;
}

export function getAutoStartStatus(opts: AutoStartOptions = {}): AutoStartStatus {
  const platform = opts.platform ?? process.platform;
  const homeDir = opts.homeDir ?? os.homedir();

  if (platform === 'darwin') {
    const plistPath = resolveMacLaunchAgentPath(homeDir);
    return {
      enabled: fs.existsSync(plistPath),
      supported: true,
      targetPath: plistPath,
    };
  }

  if (platform === 'win32') {
    try {
      const out = execFileSync('reg', ['query', WIN_REG_KEY, '/v', WIN_REG_VALUE], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 3000,
      });
      return {
        enabled: out.includes(WIN_REG_VALUE),
        supported: true,
        targetPath: `${WIN_REG_KEY}\\${WIN_REG_VALUE}`,
      };
    } catch {
      return {
        enabled: false,
        supported: true,
        targetPath: `${WIN_REG_KEY}\\${WIN_REG_VALUE}`,
      };
    }
  }

  return {
    enabled: false,
    supported: false,
    targetPath: '',
  };
}

export function setAutoStartEnabled(enabled: boolean, opts: AutoStartOptions = {}): AutoStartStatus {
  const platform = opts.platform ?? process.platform;
  const homeDir = opts.homeDir ?? os.homedir();

  if (platform === 'darwin') {
    const plistPath = resolveMacLaunchAgentPath(homeDir);
    if (enabled) {
      const appPath = resolveMacAppBundlePath(homeDir, opts.appPathOverride);
      atomicWritePrivateFile(plistPath, buildMacLaunchAgentPlist(appPath));
      fs.chmodSync(plistPath, 0o644);
    } else if (fs.existsSync(plistPath)) {
      fs.rmSync(plistPath, { force: true });
    }
    return {
      enabled: fs.existsSync(plistPath),
      supported: true,
      targetPath: plistPath,
    };
  }

  if (platform === 'win32') {
    if (enabled) {
      const exePath = resolveWindowsDesktopExePath(opts.appPathOverride);
      execFileSync(
        'reg',
        ['add', WIN_REG_KEY, '/v', WIN_REG_VALUE, '/t', 'REG_SZ', '/d', `"${exePath}" --hidden`, '/f'],
        { windowsHide: true, timeout: 3000 },
      );
    } else {
      try {
        execFileSync('reg', ['delete', WIN_REG_KEY, '/v', WIN_REG_VALUE, '/f'], {
          windowsHide: true,
          timeout: 3000,
        });
      } catch {
        // Ignore if value was already absent
      }
    }
    return getAutoStartStatus(opts);
  }

  return {
    enabled: false,
    supported: false,
    targetPath: '',
  };
}
