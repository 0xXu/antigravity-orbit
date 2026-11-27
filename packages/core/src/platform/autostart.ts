import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AutoStartStatus } from '@antigravity-orbit/shared';
import { atomicWritePrivateFile } from './paths.js';

const MAC_DAEMON_LABEL = 'dev.antigravityorbit.daemon';
const MAC_LEGACY_APP_LABEL = 'dev.antigravityorbit.app';
const WIN_REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const WIN_REG_VALUE = 'AntigravityOrbit';

export interface AutoStartOptions {
  readonly platform?: NodeJS.Platform;
  readonly homeDir?: string;
  readonly appPathOverride?: string;
  readonly nodeBinOverride?: string;
  readonly daemonScriptOverride?: string;
  readonly channelsDirOverride?: string;
  /** Set false in unit tests to skip invoking launchctl / reg. */
  readonly applyService?: boolean;
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
  return path.join(homeDir, 'Library', 'LaunchAgents', `${MAC_DAEMON_LABEL}.plist`);
}

function resolveMacLegacyLaunchAgentPath(homeDir = os.homedir()): string {
  return path.join(homeDir, 'Library', 'LaunchAgents', `${MAC_LEGACY_APP_LABEL}.plist`);
}

export function resolveMacAppBundlePath(homeDir = os.homedir(), override?: string): string {
  if (override) return override;
  const candidates = [
    '/Applications/Antigravity Orbit.app',
    path.join(homeDir, 'Applications', 'Antigravity Orbit.app'),
  ];
  return candidates.find((p) => fs.existsSync(p)) ?? '/Applications/Antigravity Orbit.app';
}

export function resolveMacDaemonLaunchSpec(opts: AutoStartOptions = {}): {
  nodeBin: string;
  daemonScript: string;
  channelsDir: string;
} {
  const homeDir = opts.homeDir ?? os.homedir();
  const appBundle = resolveMacAppBundlePath(homeDir, opts.appPathOverride);
  const bundledDaemon = path.join(appBundle, 'Contents', 'Resources', 'resources', 'core', 'daemon.mjs');
  const bundledChannels = path.join(appBundle, 'Contents', 'Resources', 'resources', 'channels');

  const nodeBin = opts.nodeBinOverride ?? process.execPath;
  const daemonScript =
    opts.daemonScriptOverride ??
    (fs.existsSync(bundledDaemon) ? bundledDaemon : path.resolve(process.argv[1] ?? bundledDaemon));
  const channelsDir =
    opts.channelsDirOverride ??
    (fs.existsSync(bundledChannels)
      ? bundledChannels
      : process.env.ANTIGRAVITY_ORBIT_CHANNELS_DIR || bundledChannels);

  return { nodeBin, daemonScript, channelsDir };
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

/**
 * Generates a macOS launchd LaunchAgent plist that runs the headless Node.js
 * Core daemon independently of the Tauri GUI window (KeepAlive + RunAtLoad),
 * so quitting Antigravity Orbit.app does NOT stop Antigravity enhancements.
 */
export function buildMacLaunchAgentPlist(spec: {
  nodeBin: string;
  daemonScript: string;
  channelsDir: string;
}): string {
  const nodeBin = xmlEscape(spec.nodeBin);
  const daemonScript = xmlEscape(spec.daemonScript);
  const channelsDir = xmlEscape(spec.channelsDir);
  const nodeDir = xmlEscape(path.dirname(spec.nodeBin));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${MAC_DAEMON_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodeBin}</string>
    <string>${daemonScript}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ANTIGRAVITY_ORBIT_CHANNELS_DIR</key>
    <string>${channelsDir}</string>
    <key>ANTIGRAVITY_ORBIT_MANAGED_BY_LAUNCHD</key>
    <string>1</string>
    <key>PATH</key>
    <string>${nodeDir}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
</dict>
</plist>
`;
}

function runLaunchctlQuiet(args: string[]): void {
  try {
    execFileSync('/bin/launchctl', args, { stdio: 'ignore', timeout: 4000 });
  } catch {
    // Best-effort service load/unload
  }
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
  const applyService = opts.applyService ?? !process.env.NODE_TEST_CONTEXT;

  if (platform === 'darwin') {
    const plistPath = resolveMacLaunchAgentPath(homeDir);
    const legacyPath = resolveMacLegacyLaunchAgentPath(homeDir);
    const uid = typeof process.getuid === 'function' ? process.getuid() : 501;

    // Always clean up any legacy GUI-launcher plist
    if (fs.existsSync(legacyPath)) {
      if (applyService) runLaunchctlQuiet(['bootout', `gui/${uid}/${MAC_LEGACY_APP_LABEL}`]);
      fs.rmSync(legacyPath, { force: true });
    }

    if (enabled) {
      const spec = resolveMacDaemonLaunchSpec(opts);
      atomicWritePrivateFile(plistPath, buildMacLaunchAgentPlist(spec));
      fs.chmodSync(plistPath, 0o644);
      if (applyService && process.env.ANTIGRAVITY_ORBIT_MANAGED_BY_LAUNCHD !== '1') {
        runLaunchctlQuiet(['bootout', `gui/${uid}/${MAC_DAEMON_LABEL}`]);
        runLaunchctlQuiet(['bootstrap', `gui/${uid}`, plistPath]);
      }
    } else {
      if (applyService) {
        runLaunchctlQuiet(['bootout', `gui/${uid}/${MAC_DAEMON_LABEL}`]);
      }
      if (fs.existsSync(plistPath)) {
        fs.rmSync(plistPath, { force: true });
      }
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
      if (applyService) {
        execFileSync(
          'reg',
          ['add', WIN_REG_KEY, '/v', WIN_REG_VALUE, '/t', 'REG_SZ', '/d', `"${exePath}" --hidden`, '/f'],
          { windowsHide: true, timeout: 3000 },
        );
      }
    } else if (applyService) {
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
