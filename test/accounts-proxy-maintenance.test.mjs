import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import {
  AccountManager,
  ReversibleMaintenanceService,
  decodeKeychainOAuthToken,
  decodeOAuthTokenFromTopicRow,
  decodeUserStatusFromTopicRow,
  diagnoseProxy,
  encodeKeychainOAuthPayload,
  encodeOAuthTokenToTopicRow,
  encodeUserStatusTopicRow,
  isAntigravityDetachedDaemon,
  isMaintenanceTargetSafe,
  validateHttpProxyUrl,
} from '../packages/core/dist/main.js';

describe('core/accounts: AccountManager', () => {
  it('manages accounts, enforces guardStopped, rolls back on fault, commits atomically, and scrubs WAL on delete', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-orbit-acct-'));
    try {
      const dbPath = path.join(tmpDir, 'state.vscdb');
      const db = new DatabaseSync(dbPath);
      db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value TEXT)');
      db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run('antigravity.oauthToken', 'tok-alice');
      db.close();

      const mgr = new AccountManager(tmpDir);
      assert.throws(() => mgr.save({ email: 'invalid', oauthToken: 'tok' }), /Invalid account email/);
      assert.throws(() => mgr.save({ email: 'a@b.com', oauthToken: '' }), /Missing oauthToken/);

      mgr.save({ email: 'Alice@Example.com', nickname: 'Alice', oauthToken: 'tok-alice', active: true });
      mgr.save({
        email: 'bob@example.com',
        nickname: 'Bob',
        oauthToken: 'tok-bob',
        userStatus: 'pro',
        active: false,
      });

      // list() omits secrets
      const listed = mgr.list();
      assert.equal(listed.length, 2);
      assert.equal('oauthToken' in listed[0], false);
      assert.equal(listed[0].email, 'alice@example.com');

      // importBatch & exportBackup
      const imported = mgr.importBatch([
        { email: 'carol@example.com', oauthToken: 'tok-carol' },
        { email: '', oauthToken: 'skip' },
      ]);
      assert.equal(imported, 1);
      const backupFile = path.join(tmpDir, 'backup.json');
      assert.equal(mgr.exportBackup(backupFile), 3);
      assert.equal(JSON.parse(fs.readFileSync(backupFile, 'utf8')).accounts.length, 3);

      // Refuses switch while host is running
      assert.throws(
        () => mgr.switchAccount('bob@example.com', { stateDbPath: dbPath, isHostRunning: true }),
        /still running/,
      );

      // Simulated fault after SQLite mutation rolls back cleanly
      assert.throws(() =>
        mgr.switchAccount('bob@example.com', {
          stateDbPath: dbPath,
          isHostRunning: false,
          simulateFailureAfterMutate: true,
        }),
      );
      const afterFaultDb = new DatabaseSync(dbPath);
      const afterFault = afterFaultDb.prepare('SELECT value FROM ItemTable WHERE key = ?').get('antigravity.oauthToken');
      afterFaultDb.close();
      assert.equal(afterFault.value, 'tok-alice');

      // Clean 4-phase switch commits unified & legacy oauthToken/userStatus, clears jetski init, and redacts WAL secrets
      const res = mgr.switchAccount('bob@example.com', { stateDbPath: dbPath, isHostRunning: false });
      assert.equal(res.switchedTo, 'bob@example.com');
      assert.equal(res.previousEmail, 'alice@example.com');
      assert.equal(res.rolledBack, false);

      const afterCommitDb = new DatabaseSync(dbPath);
      const unifiedTok = afterCommitDb
        .prepare('SELECT value FROM ItemTable WHERE key = ?')
        .get('antigravityUnifiedStateSync.oauthToken');
      const unifiedStatus = afterCommitDb
        .prepare('SELECT value FROM ItemTable WHERE key = ?')
        .get('antigravityUnifiedStateSync.userStatus');
      const onboarding = afterCommitDb
        .prepare('SELECT value FROM ItemTable WHERE key = ?')
        .get('antigravityOnboarding');
      assert.equal(unifiedTok.value, 'tok-bob');
      assert.equal(unifiedStatus.value, 'pro');
      assert.equal(onboarding.value, 'true');
      const afterCommitToken = afterCommitDb
        .prepare('SELECT value FROM ItemTable WHERE key = ?')
        .get('antigravity.oauthToken');
      const afterCommitStatus = afterCommitDb
        .prepare('SELECT value FROM ItemTable WHERE key = ?')
        .get('antigravity.userStatus');
      afterCommitDb.close();
      assert.equal(afterCommitToken.value, 'tok-bob');
      assert.equal(afterCommitStatus.value, 'pro');

      // Deleting bob scrubs matching email & secrets from completed WAL journal
      assert.equal(mgr.deleteAccount('bob@example.com'), true);
      assert.equal(mgr.deleteAccount('nobody@example.com'), false);
      const journalText = fs.readFileSync(path.join(tmpDir, 'account-switch-journal.json'), 'utf8');
      assert.ok(!journalText.includes('bob@example.com'));
      assert.ok(!journalText.includes('tok-bob'));
      assert.ok(!journalText.includes('tok-alice'));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('syncs Keychain payload, deletes jetski init state, and restores Keychain on SQLite rollback', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-orbit-kc-'));
    const store = new Map([['gemini:antigravity', 'go-keyring-base64:ALICE_KC']]);
    const mockKeychain = {
      async readPassword(s, a) {
        return store.get(`${s}:${a}`) ?? null;
      },
      async writePassword(s, a, v) {
        store.set(`${s}:${a}`, v);
      },
      async deletePassword(s, a) {
        store.delete(`${s}:${a}`);
      },
    };
    try {
      const dbPath = path.join(tmpDir, 'state.vscdb');
      const db = new DatabaseSync(dbPath);
      db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value TEXT)');
      db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
        'antigravityUnifiedStateSync.oauthToken',
        'unified-alice',
      );
      db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
        'jetskiStateSync.agentManagerInitState',
        'stale-init',
      );
      db.close();

      const mgr = new AccountManager(tmpDir, mockKeychain);
      mgr.save({
        email: 'alice@example.com',
        oauthToken: 'unified-alice',
        keychainPayload: 'go-keyring-base64:ALICE_KC',
        active: true,
      });
      mgr.save({
        email: 'bob@example.com',
        oauthToken: 'unified-bob',
        userStatus: 'unified-bob-status',
        keychainPayload: 'go-keyring-base64:BOB_KC',
        active: false,
      });

      // Simulated SQLite fault restores Keychain back to ALICE_KC
      await assert.rejects(() =>
        mgr.switchAccountAsync('bob@example.com', {
          stateDbPath: dbPath,
          isHostRunning: false,
          simulateFailureAfterMutate: true,
        }),
      );
      assert.equal(store.get('gemini:antigravity'), 'go-keyring-base64:ALICE_KC');

      // Clean async switch updates Keychain to BOB_KC and deletes jetski init state
      const res = await mgr.switchAccountAsync('bob@example.com', {
        stateDbPath: dbPath,
        isHostRunning: false,
      });
      assert.equal(res.keychainSynced, true);
      assert.equal(store.get('gemini:antigravity'), 'go-keyring-base64:BOB_KC');

      const verifyDb = new DatabaseSync(dbPath);
      const jetski = verifyDb
        .prepare('SELECT value FROM ItemTable WHERE key = ?')
        .get('jetskiStateSync.agentManagerInitState');
      verifyDb.close();
      assert.equal(jetski, undefined);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('synthesizes go-keyring-base64 Keychain payload from legacy Protobuf oauthToken and prevents cross-account contamination', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-orbit-codec-'));
    const nowSec = Math.floor(Date.now() / 1000);
    const aliceToken = {
      access_token: 'ya29.alice-fresh',
      token_type: 'Bearer',
      refresh_token: '1//alice-refresh',
      expiry_timestamp: nowSec + 3600,
      expires_in: 3600,
      email: 'alice@gmail.com',
    };
    const bobToken = {
      access_token: 'ya29.bob-older',
      token_type: 'Bearer',
      refresh_token: '1//bob-refresh',
      expiry_timestamp: nowSec - 7200,
      expires_in: 0,
      email: 'bob@gmail.com',
    };

    const aliceKeychain = encodeKeychainOAuthPayload('alice@gmail.com', aliceToken, 'go-keyring-base64');
    const bobOauthTopic = encodeOAuthTokenToTopicRow(undefined, bobToken, 'bob@gmail.com');
    const bobStatusTopic = encodeUserStatusTopicRow('Bob', 'bob@gmail.com');

    const store = new Map([['gemini:antigravity', aliceKeychain]]);
    const mockKeychain = {
      async readPassword(s, a) {
        return store.get(`${s}:${a}`) ?? null;
      },
      async writePassword(s, a, v) {
        store.set(`${s}:${a}`, v);
      },
      async deletePassword(s, a) {
        store.delete(`${s}:${a}`);
      },
    };

    try {
      const dbPath = path.join(tmpDir, 'state.vscdb');
      const db = new DatabaseSync(dbPath);
      db.exec('CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value TEXT)');
      // Simulate real-world macOS Antigravity 2.0 state: Keychain has Alice (fresh),
      // while state.vscdb still holds Bob's stale Protobuf rows!
      db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
        'antigravityUnifiedStateSync.oauthToken',
        bobOauthTopic,
      );
      db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)').run(
        'antigravityUnifiedStateSync.userStatus',
        bobStatusTopic,
      );
      db.close();

      const mgr = new AccountManager(tmpDir, mockKeychain, { homeDir: tmpDir });

      // 1. Capturing current account reads Alice from Keychain without mixing Bob's state.vscdb!
      const capturedAlice = await mgr.captureCurrentAccountAsync({ stateDbPath: dbPath });
      assert.equal(capturedAlice.email, 'alice@gmail.com');

      // 2. Save legacy Bob record WITHOUT keychainPayload (only Protobuf oauthToken)
      mgr.save({
        email: 'bob@gmail.com',
        nickname: 'Bob',
        oauthToken: bobOauthTopic,
        userStatus: bobStatusTopic,
        active: false,
      });

      // 3. listAsync reflects true live Keychain account (alice)
      const listedBefore = await mgr.listAsync();
      assert.equal(listedBefore.find((a) => a.email === 'alice@gmail.com')?.active, true);
      assert.equal(listedBefore.find((a) => a.email === 'bob@gmail.com')?.active, false);

      // 4. Switching to legacy Bob ALWAYS synthesizes and writes go-keyring-base64 Keychain payload!
      const res = await mgr.switchAccountAsync('bob@gmail.com', {
        stateDbPath: dbPath,
        isHostRunning: false,
      });
      assert.equal(res.keychainSynced, true);
      const writtenKc = store.get('gemini:antigravity');
      assert.ok(writtenKc?.startsWith('go-keyring-base64:'));
      const decodedKc = decodeKeychainOAuthToken(writtenKc);
      assert.equal(decodedKc?.email, 'bob@gmail.com');
      assert.equal(decodedKc?.token.refresh_token, '1//bob-refresh');
      assert.equal(decodedKc?.token.token_type, 'Bearer');

      // 5. state.vscdb has Bob's canonical oauthToken + userStatus
      const verifyDb = new DatabaseSync(dbPath);
      const rowOauth = verifyDb
        .prepare('SELECT value FROM ItemTable WHERE key = ?')
        .get('antigravityUnifiedStateSync.oauthToken');
      const rowStatus = verifyDb
        .prepare('SELECT value FROM ItemTable WHERE key = ?')
        .get('antigravityUnifiedStateSync.userStatus');
      verifyDb.close();
      assert.equal(decodeOAuthTokenFromTopicRow(rowOauth.value)?.refresh_token, '1//bob-refresh');
      assert.equal(decodeUserStatusFromTopicRow(rowStatus.value).email, 'bob@gmail.com');

      // 6. Switching back to Alice writes Alice's fresh token into BOTH Keychain and state.vscdb
      const backRes = await mgr.switchAccountAsync('alice@gmail.com', {
        stateDbPath: dbPath,
        isHostRunning: false,
      });
      assert.equal(backRes.keychainSynced, true);
      const aliceKcAfter = decodeKeychainOAuthToken(store.get('gemini:antigravity'));
      assert.equal(aliceKcAfter?.email, 'alice@gmail.com');
      assert.equal(aliceKcAfter?.token.refresh_token, '1//alice-refresh');

      // 7. Detached language_server & sidecar process detection
      if (process.platform === 'darwin') {
        assert.equal(
          isAntigravityDetachedDaemon(
            '/Applications/Antigravity.app/Contents/Resources/bin/language_server_macos_arm --workspace_id x',
          ),
          true,
        );
        assert.equal(
          isAntigravityDetachedDaemon(
            '/Applications/Antigravity.app/Contents/Frameworks/Antigravity Helper.app/Contents/MacOS/Antigravity Helper --type=renderer',
          ),
          false,
        );
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('core/services: proxy validation and diagnostics', () => {
  it('validates http(s) URLs and rejects empty, malformed, or socks5 URLs', () => {
    assert.deepEqual(validateHttpProxyUrl('http://127.0.0.1:7890/'), {
      ok: true,
      url: 'http://127.0.0.1:7890',
    });
    assert.equal(validateHttpProxyUrl('').ok, false);
    assert.equal(validateHttpProxyUrl('not a url').ok, false);
    const socks = validateHttpProxyUrl('socks5://127.0.0.1:1080');
    assert.equal(socks.ok, false);
    assert.match(socks.reason, /Unsupported proxy protocol/);
  });

  it('diagnoses off, manual, and system modes including shell override conflicts', () => {
    const offConflict = diagnoseProxy({ mode: 'off', manualUrl: '' }, { HTTP_PROXY: 'http://127.0.0.1:8080' });
    assert.equal(offConflict.effectiveUrl, null);
    assert.equal(offConflict.shellConflict, true);

    const badManual = diagnoseProxy({ mode: 'manual', manualUrl: 'socks5://127.0.0.1:1080' }, {});
    assert.equal(badManual.effectiveUrl, null);
    assert.match(badManual.warning ?? '', /Unsupported proxy protocol/);

    const manualConflict = diagnoseProxy(
      { mode: 'manual', manualUrl: 'http://127.0.0.1:7890' },
      { HTTPS_PROXY: 'http://127.0.0.1:9999' },
    );
    assert.equal(manualConflict.effectiveUrl, 'http://127.0.0.1:7890');
    assert.equal(manualConflict.shellConflict, true);

    const manualMatching = diagnoseProxy(
      { mode: 'manual', manualUrl: 'http://127.0.0.1:7890/' },
      { HTTPS_PROXY: 'http://127.0.0.1:7890' },
    );
    assert.equal(manualMatching.shellConflict, false);

    const sys = diagnoseProxy({ mode: 'system', manualUrl: '' }, { https_proxy: 'http://127.0.0.1:7890' });
    assert.equal(sys.effectiveUrl, 'http://127.0.0.1:7890');
    assert.equal(sys.shellConflict, false);
  });
});

describe('core/maintenance: ReversibleMaintenanceService', () => {
  it('blocks protected paths & symlinks, restores by (dev, ino), skips regenerated files, and archives SQLite triplets', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-orbit-maint-'));
    try {
      assert.equal(isMaintenanceTargetSafe('/Users/test/Antigravity/User/state.vscdb'), false);
      assert.equal(isMaintenanceTargetSafe('/Users/test/Antigravity/Cookies'), false);
      assert.equal(isMaintenanceTargetSafe('C:\\Users\\test\\Local Storage\\leveldb'), false);
      assert.equal(isMaintenanceTargetSafe('/Users/test/Antigravity/GPUCache/data_0'), true);

      const svc = new ReversibleMaintenanceService(tmpDir);
      const cacheFile = path.join(tmpDir, 'cache-blob.bin');
      fs.writeFileSync(cacheFile, 'cached-data');

      // Blocks while host is running
      assert.throws(() => svc.moveToReversibleTrash([cacheFile], true), /while Antigravity is running/);

      // Blocks symlink targets
      const symlinkTarget = path.join(tmpDir, 'link-blob.bin');
      fs.symlinkSync(cacheFile, symlinkTarget);
      assert.throws(() => svc.moveToReversibleTrash([symlinkTarget], false), /Refusing symlink target/);
      fs.unlinkSync(symlinkTarget);

      // Moves safe file to reversible trash and restores it
      const manifest = svc.moveToReversibleTrash([cacheFile], false);
      assert.equal(manifest.entries.length, 1);
      assert.equal(fs.existsSync(cacheFile), false);

      const restored = svc.restoreFromTrash(manifest.id);
      assert.deepEqual(restored, { restored: 1, skipped: 0 });
      assert.equal(fs.readFileSync(cacheFile, 'utf8'), 'cached-data');

      // Does not overwrite regenerated file on restore
      const manifest2 = svc.moveToReversibleTrash([cacheFile], false);
      fs.writeFileSync(cacheFile, 'regenerated-data');
      const skippedRestore = svc.restoreFromTrash(manifest2.id);
      assert.deepEqual(skippedRestore, { restored: 0, skipped: 1 });
      assert.equal(fs.readFileSync(cacheFile, 'utf8'), 'regenerated-data');

      assert.throws(() => svc.restoreFromTrash('nonexistent-id'), /not found/);

      // Subagent SQLite triplet archival (.db + -wal + -shm)
      const subDb = path.join(tmpDir, 'subagent-01.db');
      fs.writeFileSync(subDb, 'sqlite-main');
      fs.writeFileSync(`${subDb}-wal`, 'sqlite-wal');
      fs.writeFileSync(`${subDb}-shm`, 'sqlite-shm');

      const arc = svc.archiveSubagentDbs([subDb]);
      assert.equal(arc.archivedFiles.length, 3);
      assert.equal(fs.existsSync(subDb), false);
      assert.equal(fs.existsSync(`${subDb}-wal`), false);
      assert.equal(fs.existsSync(`${subDb}-shm`), false);

      // listTrashManifests returns previously created manifests in reverse chronological order
      const manifests = svc.listTrashManifests();
      assert.equal(manifests.length, 2);
      assert.ok(manifests.some((m) => m.id === manifest.id && Boolean(m.restoredAt)));

      // scanAntigravityStorage scans cache dirs without touching protected state.vscdb
      const fakeHostDir = path.join(tmpDir, 'fake-antigravity');
      const gpuCache = path.join(fakeHostDir, 'GPUCache');
      fs.mkdirSync(gpuCache, { recursive: true });
      fs.writeFileSync(path.join(gpuCache, 'data_0'), 'x'.repeat(2048));
      fs.writeFileSync(path.join(fakeHostDir, 'state.vscdb'), 'protected');

      const candidates = svc.scanAntigravityStorage({
        appDataDir: fakeHostDir,
        conversationsDir: path.join(tmpDir, 'no-conv'),
      });
      assert.ok(candidates.some((c) => c.path === gpuCache && c.kind === 'cache' && c.sizeBytes >= 2048));
      assert.ok(!candidates.some((c) => c.path.includes('state.vscdb')));
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
