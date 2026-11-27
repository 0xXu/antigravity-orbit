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
  it('writes and removes macOS LaunchAgent plist cleanly in an isolated home directory', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-autostart-test-'));
    try {
      const initial = getAutoStartStatus({ platform: 'darwin', homeDir: tmpHome });
      assert.equal(initial.supported, true);
      assert.equal(initial.enabled, false);

      const enabled = setAutoStartEnabled(true, {
        platform: 'darwin',
        homeDir: tmpHome,
        appPathOverride: '/Applications/Antigravity Orbit.app',
      });
      assert.equal(enabled.enabled, true);
      assert.ok(fs.existsSync(enabled.targetPath));

      const plist = fs.readFileSync(enabled.targetPath, 'utf8');
      assert.ok(plist.includes('dev.antigravityorbit.app'));
      assert.ok(plist.includes('/Applications/Antigravity Orbit.app'));
      assert.ok(plist.includes('<string>--hidden</string>'));
      assert.ok(plist.includes('<key>RunAtLoad</key>'));

      const disabled = setAutoStartEnabled(false, { platform: 'darwin', homeDir: tmpHome });
      assert.equal(disabled.enabled, false);
      assert.ok(!fs.existsSync(enabled.targetPath));
    } finally {
      fs.rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  it('escapes XML special characters in macOS LaunchAgent bundle path', () => {
    const plist = buildMacLaunchAgentPlist('/Applications/A&B <Orbit>.app');
    assert.ok(plist.includes('/Applications/A&amp;B &lt;Orbit&gt;.app'));
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
