import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  buildMacLaunchAgentPlist,
  getAutoStartStatus,
  hasRemoteDebuggingPortArg,
  setAutoStartEnabled,
} from '../packages/core/dist/main.js';
import { DEFAULT_CONFIG, normalizeConfig } from '../packages/shared/dist/index.js';

describe('core/platform: autostart LaunchAgent & bare-host CDP detection', () => {
  it('writes and removes macOS independent daemon LaunchAgent plist cleanly in an isolated home directory', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-autostart-test-'));
    try {
      const initial = getAutoStartStatus({ platform: 'darwin', homeDir: tmpHome });
      assert.equal(initial.supported, true);
      assert.equal(initial.enabled, false);

      const enabled = setAutoStartEnabled(true, {
        platform: 'darwin',
        homeDir: tmpHome,
        nodeBinOverride: '/usr/local/bin/node',
        daemonScriptOverride: '/Applications/Antigravity Orbit.app/Contents/Resources/resources/core/daemon.mjs',
        channelsDirOverride: '/Applications/Antigravity Orbit.app/Contents/Resources/resources/channels',
        applyService: false,
      });
      assert.equal(enabled.enabled, true);
      assert.ok(fs.existsSync(enabled.targetPath));

      const plist = fs.readFileSync(enabled.targetPath, 'utf8');
      assert.ok(plist.includes('dev.antigravityorbit.daemon'));
      assert.ok(plist.includes('/usr/local/bin/node'));
      assert.ok(plist.includes('daemon.mjs'));
      assert.ok(plist.includes('ANTIGRAVITY_ORBIT_CHANNELS_DIR'));
      assert.ok(plist.includes('<key>KeepAlive</key>'));
      assert.ok(plist.includes('<key>RunAtLoad</key>'));

      const disabled = setAutoStartEnabled(false, {
        platform: 'darwin',
        homeDir: tmpHome,
        applyService: false,
      });
      assert.equal(disabled.enabled, false);
      assert.ok(!fs.existsSync(enabled.targetPath));
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('escapes XML special characters in macOS LaunchAgent paths', () => {
    const plist = buildMacLaunchAgentPlist({
      nodeBin: '/opt/node/bin/node',
      daemonScript: '/Applications/A&B <Orbit>.app/daemon.mjs',
      channelsDir: '/Applications/A&B <Orbit>.app/channels',
    });
    assert.ok(plist.includes('/Applications/A&amp;B &lt;Orbit&gt;.app/daemon.mjs'));
  });

  it('detects --remote-debugging-port in Antigravity process arguments', () => {
    assert.equal(
      hasRemoteDebuggingPortArg('/Applications/Antigravity.app/Contents/MacOS/Electron --remote-debugging-port=0'),
      true,
    );
    assert.equal(
      hasRemoteDebuggingPortArg('/Applications/Antigravity.app/Contents/MacOS/Electron --remote-debugging-port 9222'),
      true,
    );
    assert.equal(
      hasRemoteDebuggingPortArg('/Applications/Antigravity.app/Contents/MacOS/Electron'),
      false,
    );
  });

  it('normalizes autoStartOnLogin and autoAttachBareHost config booleans', () => {
    assert.equal(DEFAULT_CONFIG.autoStartOnLogin, false);
    assert.equal(DEFAULT_CONFIG.autoAttachBareHost, true);
    const next = normalizeConfig({ autoStartOnLogin: true, autoAttachBareHost: false });
    assert.equal(next.autoStartOnLogin, true);
    assert.equal(next.autoAttachBareHost, false);
  });
});
