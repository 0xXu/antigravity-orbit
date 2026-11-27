import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  AccountRecordWithSecrets,
  AccountSwitchResult,
  SavedAccount,
} from '@antigravity-orbit/shared';
import { atomicWritePrivateFile, ensurePrivateDir } from '../platform/paths.js';
import {
  buildGoOAuthPayload,
  decodeEnterpriseProjectId,
  decodeKeychainOAuthToken,
  decodeOAuthTokenFromTopicRow,
  decodeUserStatusFromTopicRow,
  encodeEnterpriseTopicRow,
  encodeKeychainOAuthPayload,
  encodeOAuthTokenToTopicRow,
  encodeUserStatusTopicRow,
  parseOAuthJson,
  shouldPreferTokenCandidate,
  type OAuthTokenData,
} from './codec.js';
import {
  ANTIGRAVITY_KEYCHAIN_ACCOUNT,
  ANTIGRAVITY_KEYCHAIN_SERVICE,
  MacKeychainStore,
  type KeychainStore,
} from './keychain.js';

const KEY_UNIFIED_OAUTH = 'antigravityUnifiedStateSync.oauthToken';
const KEY_UNIFIED_USER_STATUS = 'antigravityUnifiedStateSync.userStatus';
const KEY_UNIFIED_ENTERPRISE = 'antigravityUnifiedStateSync.enterprisePreferences';
const KEY_JETSKI_INIT = 'jetskiStateSync.agentManagerInitState';
const KEY_ONBOARDING = 'antigravityOnboarding';
const KEY_LEGACY_OAUTH = 'antigravity.oauthToken';
const KEY_LEGACY_USER_STATUS = 'antigravity.userStatus';

interface SwitchJournal {
  id: string;
  status: 'pending' | 'complete' | 'rolled_back';
  fromEmail: string | null;
  toEmail: string;
  dbPreImageSha256: string;
  createdAt: string;
  previousOauthToken?: string;
  previousKeychainPayload?: string | null;
}

function extractEmailFromBlob(raw?: string): string {
  if (!raw) return '';
  const fromKeychain = decodeKeychainOAuthToken(raw);
  if (fromKeychain?.email) return fromKeychain.email;
  const fromStatus = decodeUserStatusFromTopicRow(raw);
  if (fromStatus.email) return fromStatus.email;
  const direct = raw.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  if (direct) return direct[0].toLowerCase();
  try {
    const decoded = Buffer.from(raw.trim(), 'base64').toString('utf8');
    const nested = decoded.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    if (nested) return nested[0].toLowerCase();
    for (const chunk of decoded.match(/[A-Za-z0-9+/]{16,}={0,2}/g) ?? []) {
      const inner = Buffer.from(chunk, 'base64').toString('utf8');
      const m = inner.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
      if (m) return m[0].toLowerCase();
    }
  } catch {
    // Ignore non-base64 content
  }
  return '';
}

function getExistingCliCredentialPaths(homeDir?: string): string[] {
  const base = homeDir ?? os.homedir();
  const candidates = [
    path.join(base, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'),
    path.join(base, '.gemini', 'jetski-standalone-oauth-token'),
  ];
  const existing: string[] = [];
  for (const p of candidates) {
    try {
      const st = fs.lstatSync(p);
      if (st.isFile() && !st.isSymbolicLink()) existing.push(p);
    } catch {
      // Missing CLI file is normal; never create it
    }
  }
  return existing;
}

interface ResolvedLiveSession {
  email: string;
  nickname: string;
  token: OAuthTokenData | null;
  oauthToken: string;
  userStatus?: string;
  enterprisePreferences?: string;
  keychainPayload?: string;
}

/**
 * 4-Phase Atomic Account Manager with WAL Journal, SHA-256 verification,
 * guardStopped enforcement, unified state.vscdb + macOS Keychain (`gemini/antigravity`)
 * bidirectional Protobuf/Go-keyring synthesis, crash-safe rollback, and delete-time WAL scrubbing.
 */
export class AccountManager {
  private readonly accountsDir: string;
  private readonly indexFile: string;
  private readonly journalFile: string;
  private readonly keychain: KeychainStore;
  private readonly homeDir?: string;

  constructor(
    stateDir: string,
    keychain: KeychainStore = new MacKeychainStore(),
    opts?: { homeDir?: string },
  ) {
    this.accountsDir = path.join(stateDir, 'accounts');
    this.indexFile = path.join(stateDir, 'accounts.json');
    this.journalFile = path.join(stateDir, 'account-switch-journal.json');
    this.keychain = keychain;
    this.homeDir = opts?.homeDir;
    ensurePrivateDir(this.accountsDir);
  }

  list(liveEmail?: string | null): SavedAccount[] {
    const normalizedLive = liveEmail?.trim().toLowerCase() || null;
    const raw = this.readIndex();
    const liveMatched = normalizedLive !== null && raw.some((a) => a.email === normalizedLive);
    return raw.map(
      ({ oauthToken: _t, userStatus: _u, enterprisePreferences: _e, keychainPayload: _k, ...pub }) => ({
        ...pub,
        active: liveMatched ? pub.email === normalizedLive : pub.active,
      }),
    );
  }

  async listAsync(liveEmail?: string | null): Promise<SavedAccount[]> {
    const kcRaw = await this.keychain
      .readPassword(ANTIGRAVITY_KEYCHAIN_SERVICE, ANTIGRAVITY_KEYCHAIN_ACCOUNT)
      .catch(() => null);
    const kcEmail = decodeKeychainOAuthToken(kcRaw)?.email ?? null;
    return this.list(kcEmail ?? liveEmail ?? null);
  }

  save(input: {
    email: string;
    nickname?: string;
    oauthToken: string;
    userStatus?: string;
    enterprisePreferences?: string;
    keychainPayload?: string;
    active?: boolean;
  }): SavedAccount {
    const email = input.email.trim().toLowerCase();
    if (!email || !email.includes('@')) throw new Error('Invalid account email');
    if (!input.oauthToken) throw new Error('Missing oauthToken');

    const now = new Date().toISOString();
    const list = this.readIndex();
    const existingIdx = list.findIndex((a) => a.email === email);
    const existing = existingIdx >= 0 ? list[existingIdx]! : null;
    const record: AccountRecordWithSecrets = {
      email,
      nickname: input.nickname?.trim() || existing?.nickname || email.split('@')[0] || email,
      active: input.active ?? (existing ? existing.active : list.length === 0),
      savedAt: existing ? existing.savedAt : now,
      lastUsedAt: now,
      oauthToken: input.oauthToken,
      userStatus: input.userStatus ?? existing?.userStatus,
      enterprisePreferences: input.enterprisePreferences ?? existing?.enterprisePreferences,
      keychainPayload: input.keychainPayload ?? existing?.keychainPayload,
    };

    if (record.active) {
      for (let i = 0; i < list.length; i++) {
        list[i] = { ...list[i]!, active: false };
      }
    }
    if (existingIdx >= 0) list[existingIdx] = record;
    else list.push(record);

    this.writeIndex(list);
    const { oauthToken: _t, userStatus: _u, enterprisePreferences: _e, keychainPayload: _k, ...pub } = record;
    return pub;
  }

  importBatch(records: Array<{ email: string; nickname?: string; oauthToken: string }>): number {
    let imported = 0;
    for (const r of records) {
      if (!r.email || !r.oauthToken) continue;
      this.save({ email: r.email, nickname: r.nickname, oauthToken: r.oauthToken, active: false });
      imported += 1;
    }
    return imported;
  }

  exportBackup(destFile: string): number {
    const list = this.readIndex();
    atomicWritePrivateFile(destFile, `${JSON.stringify({ version: 1, accounts: list }, null, 2)}\n`);
    return list.length;
  }

  /**
   * Read the live Antigravity session from macOS Keychain (`gemini/antigravity`),
   * existing CLI credential files, and `state.vscdb`, strictly matching email
   * provenance so a stale `state.vscdb` row from a previous account can NEVER
   * contaminate the currently logged-in account.
   */
  private readLiveSession(opts: {
    stateDbPath: string;
    liveEmail?: string | null;
    liveNickname?: string | null;
    keychainPayload?: string | null;
  }): ResolvedLiveSession {
    // 1. Decode Keychain (primary live auth store on modern macOS Antigravity)
    const kcDecoded = decodeKeychainOAuthToken(opts.keychainPayload);

    // 2. Decode existing CLI standalone session files if present
    let cliDecoded: { token: OAuthTokenData; email: string | null } | null = null;
    if (!process.env.NODE_TEST_CONTEXT || this.homeDir) {
      for (const p of getExistingCliCredentialPaths(this.homeDir)) {
        try {
          const parsed = parseOAuthJson(fs.readFileSync(p, 'utf8'));
          if (parsed?.token.refresh_token) {
            cliDecoded = parsed;
            break;
          }
        } catch {
          // Ignore unreadable CLI file
        }
      }
    }

    // 3. Read state.vscdb rows (optional if Keychain already has full live session)
    let rawDbOauth: string | undefined;
    let rawDbStatus: string | undefined;
    let rawDbEnterprise: string | undefined;
    let dbEmail: string | null = null;
    let dbName: string | null = null;
    let dbProjectId: string | null = null;
    let dbDecodedToken: OAuthTokenData | null = null;

    if (fs.existsSync(opts.stateDbPath)) {
      const db = new DatabaseSync(opts.stateDbPath, { readOnly: true });
      try {
        const readKey = (key: string): string | undefined => {
          const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key) as
            | { value?: string }
            | undefined;
          return typeof row?.value === 'string' && row.value.length > 0 ? row.value : undefined;
        };
        rawDbOauth = readKey(KEY_UNIFIED_OAUTH) ?? readKey(KEY_LEGACY_OAUTH);
        rawDbStatus = readKey(KEY_UNIFIED_USER_STATUS) ?? readKey(KEY_LEGACY_USER_STATUS);
        rawDbEnterprise = readKey(KEY_UNIFIED_ENTERPRISE);
        const statusInfo = decodeUserStatusFromTopicRow(rawDbStatus);
        dbEmail = statusInfo.email ?? (extractEmailFromBlob(rawDbStatus) || null);
        dbName = statusInfo.name;
        dbProjectId = decodeEnterpriseProjectId(rawDbEnterprise);
        dbDecodedToken = decodeOAuthTokenFromTopicRow(rawDbOauth, {
          email: dbEmail,
          projectId: dbProjectId,
        });
      } finally {
        db.close();
      }
    } else if (!kcDecoded && !cliDecoded) {
      throw new Error(`未找到 Antigravity 状态库：${opts.stateDbPath}`);
    }

    // 4. Determine true live account email (Keychain > live CDP telemetry > CLI > state.vscdb)
    const liveHintEmail = opts.liveEmail?.trim().toLowerCase() || null;
    const email = (
      kcDecoded?.email ??
      liveHintEmail ??
      cliDecoded?.email ??
      dbEmail ??
      ''
    )
      .trim()
      .toLowerCase();

    if (!email) {
      throw new Error('未能从当前 Antigravity 会话、系统钥匙串或 state.vscdb 识别到登录邮箱，请先在 Antigravity 内登录账号');
    }

    // 5. Select the best structured token STRICTLY matching `email`
    const candidates: OAuthTokenData[] = [];
    if (kcDecoded && (!kcDecoded.email || kcDecoded.email === email)) {
      candidates.push({ ...kcDecoded.token, email });
    }
    if (cliDecoded && (!cliDecoded.email || cliDecoded.email === email)) {
      candidates.push({ ...cliDecoded.token, email });
    }
    if (dbDecodedToken && (!dbEmail || dbEmail === email)) {
      candidates.push({ ...dbDecodedToken, email });
    }

    let bestToken: OAuthTokenData | null = null;
    const nowSec = Math.floor(Date.now() / 1000);
    for (const cand of candidates) {
      if (!bestToken || shouldPreferTokenCandidate(bestToken, cand, nowSec)) {
        bestToken = cand;
      }
    }

    // Preserve enterprise project_id if db matches email and winning token lacked it
    if (bestToken && !bestToken.project_id && dbProjectId && (!dbEmail || dbEmail === email)) {
      bestToken = { ...bestToken, project_id: dbProjectId };
    }

    const nickname =
      opts.liveNickname?.trim() ||
      (dbEmail === email && dbName ? dbName : '') ||
      email.split('@')[0] ||
      email;

    if (bestToken) {
      // Synthesize canonical, mutually consistent representations for BOTH state.vscdb and Keychain
      const oauthToken = encodeOAuthTokenToTopicRow(
        dbEmail === email ? rawDbOauth : undefined,
        bestToken,
        email,
      );
      const userStatus =
        dbEmail === email && rawDbStatus ? rawDbStatus : encodeUserStatusTopicRow(nickname, email);
      const enterprisePreferences =
        encodeEnterpriseTopicRow(
          dbEmail === email ? rawDbEnterprise : undefined,
          bestToken.project_id,
        ) ?? undefined;
      const keychainPayload = encodeKeychainOAuthPayload(email, bestToken);
      return {
        email,
        nickname,
        token: bestToken,
        oauthToken,
        userStatus,
        enterprisePreferences,
        keychainPayload,
      };
    }

    // Fallback for non-protobuf test fixtures / legacy raw tokens
    if (!rawDbOauth) {
      throw new Error('未在系统钥匙串或 state.vscdb 中找到当前账号的 OAuth 凭据');
    }
    return {
      email,
      nickname,
      token: null,
      oauthToken: rawDbOauth,
      userStatus: dbEmail === email ? rawDbStatus : undefined,
      enterprisePreferences: dbEmail === email ? rawDbEnterprise : undefined,
      keychainPayload: opts.keychainPayload ?? undefined,
    };
  }

  captureCurrentAccount(opts: {
    stateDbPath: string;
    liveEmail?: string | null;
    liveNickname?: string | null;
    keychainPayload?: string | null;
  }): SavedAccount {
    const live = this.readLiveSession(opts);
    return this.save({
      email: live.email,
      nickname: live.nickname,
      oauthToken: live.oauthToken,
      userStatus: live.userStatus,
      enterprisePreferences: live.enterprisePreferences,
      keychainPayload: live.keychainPayload,
      active: true,
    });
  }

  async captureCurrentAccountAsync(opts: {
    stateDbPath: string;
    liveEmail?: string | null;
    liveNickname?: string | null;
  }): Promise<SavedAccount> {
    const keychainPayload = await this.keychain
      .readPassword(ANTIGRAVITY_KEYCHAIN_SERVICE, ANTIGRAVITY_KEYCHAIN_ACCOUNT)
      .catch(() => null);
    return this.captureCurrentAccount({ ...opts, keychainPayload });
  }

  /**
   * Safe pre-switch harvest: refreshes the currently logged-in outgoing account's
   * saved credentials ONLY if its verified email != targetEmail and its live token
   * is valid and fresher (or repairs missing keychainPayload). Never cross-contaminates.
   */
  async harvestOutgoingAccountAsync(opts: {
    stateDbPath: string;
    targetEmail: string;
    liveEmail?: string | null;
    liveNickname?: string | null;
  }): Promise<boolean> {
    const targetNorm = opts.targetEmail.trim().toLowerCase();
    const keychainPayload = await this.keychain
      .readPassword(ANTIGRAVITY_KEYCHAIN_SERVICE, ANTIGRAVITY_KEYCHAIN_ACCOUNT)
      .catch(() => null);
    let live: ResolvedLiveSession;
    try {
      live = this.readLiveSession({ ...opts, keychainPayload });
    } catch {
      return false;
    }
    if (!live.email || live.email === targetNorm) {
      return false;
    }
    const existing = this.readIndex().find((a) => a.email === live.email);
    if (!existing) {
      // Save unseen outgoing account so user doesn't lose it when switching away
      this.save({
        email: live.email,
        nickname: live.nickname,
        oauthToken: live.oauthToken,
        userStatus: live.userStatus,
        enterprisePreferences: live.enterprisePreferences,
        keychainPayload: live.keychainPayload,
        active: true,
      });
      return true;
    }

    const existingToken = this.extractBestStructuredToken(existing);
    const shouldUpdate =
      !existing.keychainPayload ||
      !existingToken ||
      (live.token !== null &&
        (live.token.expiry_timestamp > existingToken.expiry_timestamp + 60 ||
          live.token.refresh_token !== existingToken.refresh_token));

    if (!shouldUpdate) return false;
    this.save({
      email: live.email,
      nickname: live.nickname,
      oauthToken: live.oauthToken,
      userStatus: live.userStatus,
      enterprisePreferences: live.enterprisePreferences,
      keychainPayload: live.keychainPayload,
      active: existing.active,
    });
    return true;
  }

  /**
   * Extract the best structured OAuthTokenData for a saved account, preferring
   * whichever of `keychainPayload` or `oauthToken` matches `account.email` and
   * has the fresher valid token. This also self-heals legacy accounts saved before
   * Keychain support or previously mixed records.
   */
  private extractBestStructuredToken(account: AccountRecordWithSecrets): OAuthTokenData | null {
    const targetEmail = account.email.trim().toLowerCase();
    const kc = decodeKeychainOAuthToken(account.keychainPayload);
    const dbProjectId = decodeEnterpriseProjectId(account.enterprisePreferences);
    const dbStatus = decodeUserStatusFromTopicRow(account.userStatus);
    const dbTok = decodeOAuthTokenFromTopicRow(account.oauthToken, {
      email: dbStatus.email ?? targetEmail,
      projectId: dbProjectId,
    });

    const kcMatches = kc && (!kc.email || kc.email === targetEmail) ? kc.token : null;
    const dbMatches =
      dbTok && (!dbStatus.email || dbStatus.email === targetEmail || !kcMatches) ? dbTok : null;

    if (kcMatches && dbMatches) {
      // If dbStatus explicitly belongs to a DIFFERENT email, trust kcMatches unconditionally!
      if (dbStatus.email && dbStatus.email !== targetEmail) {
        return { ...kcMatches, email: targetEmail };
      }
      const best = shouldPreferTokenCandidate(dbMatches, kcMatches) ? kcMatches : dbMatches;
      return {
        ...best,
        email: targetEmail,
        project_id: best.project_id ?? dbProjectId ?? null,
      };
    }
    const chosen = kcMatches ?? dbMatches;
    return chosen ? { ...chosen, email: targetEmail, project_id: chosen.project_id ?? dbProjectId ?? null } : null;
  }

  deleteAccount(email: string): boolean {
    const normalized = email.trim().toLowerCase();
    const list = this.readIndex();
    const next = list.filter((a) => a.email !== normalized);
    if (next.length === list.length) return false;
    this.writeIndex(next);

    // Scrub matching recovery credentials from WAL journal (skip pending interrupted tx)
    if (fs.existsSync(this.journalFile)) {
      try {
        const journal = JSON.parse(fs.readFileSync(this.journalFile, 'utf8')) as SwitchJournal;
        if (
          journal.status !== 'pending' &&
          (journal.fromEmail === normalized || journal.toEmail === normalized)
        ) {
          delete journal.previousOauthToken;
          delete journal.previousKeychainPayload;
          journal.fromEmail = journal.fromEmail === normalized ? '[deleted]' : journal.fromEmail;
          journal.toEmail = journal.toEmail === normalized ? '[deleted]' : journal.toEmail;
          atomicWritePrivateFile(this.journalFile, `${JSON.stringify(journal, null, 2)}\n`);
        }
      } catch {
        // Ignore corrupt journal
      }
    }
    return true;
  }

  private mutateStateDb(
    target: AccountRecordWithSecrets,
    resolvedToken: OAuthTokenData | null,
    synthesizedKeychainPayload: string | undefined,
    list: AccountRecordWithSecrets[],
    previous: AccountRecordWithSecrets | null,
    opts: {
      stateDbPath: string;
      isHostRunning: boolean;
      simulateFailureAfterMutate?: boolean;
      previousKeychainPayload?: string | null;
    },
  ): { journalId: string; journal: SwitchJournal; previousEmail: string | null } {
    if (opts.isHostRunning) {
      throw new Error('Antigravity is still running; stop it gracefully before switching accounts');
    }

    if (!fs.existsSync(opts.stateDbPath)) {
      throw new Error(`state.vscdb not found at ${opts.stateDbPath}`);
    }
    const dbBytes = fs.readFileSync(opts.stateDbPath);
    const dbPreImageSha256 = crypto.createHash('sha256').update(dbBytes).digest('hex');

    const db = new DatabaseSync(opts.stateDbPath);
    const journalId = `sw-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

    try {
      db.exec('PRAGMA busy_timeout = 3000;');
      db.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value TEXT)');
      const readRow = (key: string): string | undefined => {
        const r = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key) as
          | { value?: string }
          | undefined;
        return typeof r?.value === 'string' ? r.value : undefined;
      };
      const previousOauthToken = readRow(KEY_UNIFIED_OAUTH) ?? readRow(KEY_LEGACY_OAUTH);
      const existingEnterprise = readRow(KEY_UNIFIED_ENTERPRISE);

      // Compute canonical rows to write
      const nextOauthRow = resolvedToken
        ? encodeOAuthTokenToTopicRow(readRow(KEY_UNIFIED_OAUTH), resolvedToken, target.email)
        : target.oauthToken;
      const nextUserStatusRow = resolvedToken
        ? encodeUserStatusTopicRow(target.nickname || target.email, target.email)
        : target.userStatus;
      const nextEnterpriseRow = resolvedToken
        ? encodeEnterpriseTopicRow(existingEnterprise, resolvedToken.project_id)
        : target.enterprisePreferences ?? null;

      // Phase 2: Durable WAL journal BEFORE mutating resources
      const journal: SwitchJournal = {
        id: journalId,
        status: 'pending',
        fromEmail: previous?.email ?? null,
        toEmail: target.email,
        dbPreImageSha256,
        createdAt: new Date().toISOString(),
        previousOauthToken,
        previousKeychainPayload: opts.previousKeychainPayload,
      };
      atomicWritePrivateFile(this.journalFile, `${JSON.stringify(journal, null, 2)}\n`);

      // Phase 3: Atomic SQLite mutation under BEGIN IMMEDIATE
      db.exec('BEGIN IMMEDIATE');
      try {
        const upsert = db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)');
        const del = db.prepare('DELETE FROM ItemTable WHERE key = ?');

        upsert.run(KEY_UNIFIED_OAUTH, nextOauthRow);
        upsert.run(KEY_LEGACY_OAUTH, nextOauthRow);
        upsert.run(KEY_ONBOARDING, 'true');

        if (nextUserStatusRow) {
          upsert.run(KEY_UNIFIED_USER_STATUS, nextUserStatusRow);
          upsert.run(KEY_LEGACY_USER_STATUS, nextUserStatusRow);
        } else {
          del.run(KEY_UNIFIED_USER_STATUS);
          del.run(KEY_LEGACY_USER_STATUS);
        }

        if (nextEnterpriseRow) {
          upsert.run(KEY_UNIFIED_ENTERPRISE, nextEnterpriseRow);
        } else {
          del.run(KEY_UNIFIED_ENTERPRISE);
        }

        // Clear stale agent manager init state so Antigravity boots cleanly into target account
        del.run(KEY_JETSKI_INIT);

        if (opts.simulateFailureAfterMutate) {
          throw new Error('Simulated post-mutation fault');
        }

        const now = new Date().toISOString();
        const updated = list.map((a) => {
          if (a.email !== target.email) {
            return { ...a, active: false };
          }
          // Self-heal stored record with canonical oauthToken/userStatus/keychainPayload
          return {
            ...a,
            active: true,
            lastUsedAt: now,
            oauthToken: nextOauthRow,
            userStatus: nextUserStatusRow ?? a.userStatus,
            enterprisePreferences: nextEnterpriseRow ?? undefined,
            keychainPayload: synthesizedKeychainPayload ?? a.keychainPayload,
          };
        });
        this.writeIndex(updated);

        // Phase 4: Commit & redact secrets from completed WAL journal
        db.exec('COMMIT');
        try {
          db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
        } catch {
          // Ignore if DB is in DELETE journal mode
        }

        journal.status = 'complete';
        delete journal.previousOauthToken;
        delete journal.previousKeychainPayload;
        atomicWritePrivateFile(this.journalFile, `${JSON.stringify(journal, null, 2)}\n`);

        return { journalId, journal, previousEmail: previous?.email ?? null };
      } catch (err) {
        db.exec('ROLLBACK');
        journal.status = 'rolled_back';
        delete journal.previousOauthToken;
        delete journal.previousKeychainPayload;
        atomicWritePrivateFile(this.journalFile, `${JSON.stringify(journal, null, 2)}\n`);
        throw err;
      }
    } finally {
      db.close();
    }
  }

  switchAccount(
    targetEmail: string,
    opts: {
      stateDbPath: string;
      isHostRunning: boolean;
      simulateFailureAfterMutate?: boolean;
    },
  ): AccountSwitchResult {
    const normalized = targetEmail.trim().toLowerCase();
    const list = this.readIndex();
    const target = list.find((a) => a.email === normalized);
    if (!target) throw new Error(`Account not found: ${normalized}`);
    const previous = list.find((a) => a.active) ?? null;
    const resolvedToken = this.extractBestStructuredToken(target);

    const { journalId, previousEmail } = this.mutateStateDb(
      target,
      resolvedToken,
      target.keychainPayload,
      list,
      previous,
      opts,
    );
    return {
      switchedTo: target.email,
      previousEmail,
      journalId,
      rolledBack: false,
      keychainSynced: false,
    };
  }

  async switchAccountAsync(
    targetEmail: string,
    opts: {
      stateDbPath: string;
      isHostRunning: boolean;
      simulateFailureAfterMutate?: boolean;
    },
  ): Promise<AccountSwitchResult> {
    if (opts.isHostRunning) {
      throw new Error('Antigravity is still running; stop it gracefully before switching accounts');
    }

    const normalized = targetEmail.trim().toLowerCase();
    const list = this.readIndex();
    const target = list.find((a) => a.email === normalized);
    if (!target) throw new Error(`Account not found: ${normalized}`);
    const previous = list.find((a) => a.active) ?? null;

    const resolvedToken = this.extractBestStructuredToken(target);
    // ALWAYS synthesize a canonical go-keyring-base64 / raw Keychain payload when we have
    // a refresh_token — even if the account was saved before Keychain support!
    const nextKeychainPayload = resolvedToken
      ? encodeKeychainOAuthPayload(target.email, resolvedToken)
      : target.keychainPayload;

    const previousKeychainPayload = await this.keychain
      .readPassword(ANTIGRAVITY_KEYCHAIN_SERVICE, ANTIGRAVITY_KEYCHAIN_ACCOUNT)
      .catch(() => null);

    // Snapshot any existing standalone CLI credential files before mutating
    const cliPaths =
      !process.env.NODE_TEST_CONTEXT || this.homeDir
        ? getExistingCliCredentialPaths(this.homeDir)
        : [];
    const cliBefore = new Map<string, string>();
    for (const p of cliPaths) {
      try {
        cliBefore.set(p, fs.readFileSync(p, 'utf8'));
      } catch {
        // Ignore unreadable file
      }
    }

    let keychainSynced = false;
    if (nextKeychainPayload) {
      await this.keychain.writePassword(
        ANTIGRAVITY_KEYCHAIN_SERVICE,
        ANTIGRAVITY_KEYCHAIN_ACCOUNT,
        nextKeychainPayload,
      );
      keychainSynced = true;
    }

    try {
      const { journalId, previousEmail } = this.mutateStateDb(
        target,
        resolvedToken,
        nextKeychainPayload,
        list,
        previous,
        {
          ...opts,
          previousKeychainPayload,
        },
      );

      // Best-effort sync of already-existing agy CLI credential files (never creates new files)
      if (resolvedToken && cliPaths.length > 0) {
        const cliJson = `${buildGoOAuthPayload(target.email, resolvedToken)}\n`;
        for (const p of cliPaths) {
          try {
            atomicWritePrivateFile(p, cliJson);
          } catch {
            // Non-fatal CLI sync
          }
        }
      }

      return {
        switchedTo: target.email,
        previousEmail,
        journalId,
        rolledBack: false,
        keychainSynced,
      };
    } catch (err) {
      // Restore Keychain & CLI files if SQLite transaction rolled back
      if (keychainSynced) {
        try {
          if (previousKeychainPayload !== null) {
            await this.keychain.writePassword(
              ANTIGRAVITY_KEYCHAIN_SERVICE,
              ANTIGRAVITY_KEYCHAIN_ACCOUNT,
              previousKeychainPayload,
            );
          } else {
            await this.keychain.deletePassword(
              ANTIGRAVITY_KEYCHAIN_SERVICE,
              ANTIGRAVITY_KEYCHAIN_ACCOUNT,
            );
          }
        } catch {
          // Best-effort keychain restore
        }
      }
      for (const [p, before] of cliBefore.entries()) {
        try {
          atomicWritePrivateFile(p, before);
        } catch {
          // Best-effort CLI restore
        }
      }
      throw err;
    }
  }

  private readIndex(): AccountRecordWithSecrets[] {
    if (!fs.existsSync(this.indexFile)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(this.indexFile, 'utf8')) as AccountRecordWithSecrets[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private writeIndex(list: AccountRecordWithSecrets[]): void {
    atomicWritePrivateFile(this.indexFile, `${JSON.stringify(list, null, 2)}\n`);
  }
}
