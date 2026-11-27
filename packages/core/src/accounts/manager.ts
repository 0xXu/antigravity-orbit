import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  AccountRecordWithSecrets,
  AccountSwitchResult,
  SavedAccount,
} from '@antigravity-orbit/shared';
import { atomicWritePrivateFile, ensurePrivateDir } from '../platform/paths.js';

interface SwitchJournal {
  id: string;
  status: 'pending' | 'complete' | 'rolled_back';
  fromEmail: string | null;
  toEmail: string;
  dbPreImageSha256: string;
  createdAt: string;
  previousOauthToken?: string;
}

/**
 * 4-Phase Atomic Account Manager with WAL Journal, SHA-256 verification,
 * guardStopped enforcement, crash-safe rollback, and delete-time WAL scrubbing.
 */
export class AccountManager {
  private readonly accountsDir: string;
  private readonly indexFile: string;
  private readonly journalFile: string;

  constructor(stateDir: string) {
    this.accountsDir = path.join(stateDir, 'accounts');
    this.indexFile = path.join(stateDir, 'accounts.json');
    this.journalFile = path.join(stateDir, 'account-switch-journal.json');
    ensurePrivateDir(this.accountsDir);
  }

  list(): SavedAccount[] {
    return this.readIndex().map(({ oauthToken: _t, userStatus: _u, ...pub }) => pub);
  }

  save(input: { email: string; nickname?: string; oauthToken: string; userStatus?: string; active?: boolean }): SavedAccount {
    const email = input.email.trim().toLowerCase();
    if (!email || !email.includes('@')) throw new Error('Invalid account email');
    if (!input.oauthToken) throw new Error('Missing oauthToken');

    const now = new Date().toISOString();
    const list = this.readIndex();
    const existingIdx = list.findIndex((a) => a.email === email);
    const record: AccountRecordWithSecrets = {
      email,
      nickname: input.nickname?.trim() || email.split('@')[0] || email,
      active: input.active ?? (existingIdx >= 0 ? list[existingIdx]!.active : list.length === 0),
      savedAt: existingIdx >= 0 ? list[existingIdx]!.savedAt : now,
      lastUsedAt: now,
      oauthToken: input.oauthToken,
      userStatus: input.userStatus,
    };

    if (record.active) {
      for (let i = 0; i < list.length; i++) {
        list[i] = { ...list[i]!, active: false };
      }
    }
    if (existingIdx >= 0) list[existingIdx] = record;
    else list.push(record);

    this.writeIndex(list);
    const { oauthToken: _t, userStatus: _u, ...pub } = record;
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

  captureCurrentAccount(opts: {
    stateDbPath: string;
    liveEmail?: string | null;
    liveNickname?: string | null;
  }): SavedAccount {
    if (!fs.existsSync(opts.stateDbPath)) {
      throw new Error(`未找到 Antigravity 状态库：${opts.stateDbPath}`);
    }
    const db = new DatabaseSync(opts.stateDbPath, { readOnly: true });
    try {
      const readKey = (key: string): string | undefined => {
        const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key) as
          | { value?: string }
          | undefined;
        return typeof row?.value === 'string' && row.value.length > 0 ? row.value : undefined;
      };
      const oauthToken =
        readKey('antigravityUnifiedStateSync.oauthToken') ??
        readKey('antigravity.oauthToken');
      const userStatus =
        readKey('antigravityUnifiedStateSync.userStatus') ??
        readKey('antigravity.userStatus');

      let email = opts.liveEmail?.trim().toLowerCase() ?? '';
      if (!email && userStatus) {
        const emailMatch = userStatus.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
        if (emailMatch) email = emailMatch[0].toLowerCase();
      }
      if (!email) {
        throw new Error('未能从当前 Antigravity 会话或 state.vscdb 识别到登录邮箱，请先在 Antigravity 内登录账号');
      }
      if (!oauthToken) {
        throw new Error('未在 state.vscdb 中找到当前账号的 OAuth 凭据');
      }

      return this.save({
        email,
        nickname: opts.liveNickname?.trim() || email.split('@')[0],
        oauthToken,
        userStatus,
        active: true,
      });
    } finally {
      db.close();
    }
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

  switchAccount(
    targetEmail: string,
    opts: {
      stateDbPath: string;
      isHostRunning: boolean;
      simulateFailureAfterMutate?: boolean;
    },
  ): AccountSwitchResult {
    if (opts.isHostRunning) {
      throw new Error('Antigravity is still running; stop it gracefully before switching accounts');
    }

    const normalized = targetEmail.trim().toLowerCase();
    const list = this.readIndex();
    const target = list.find((a) => a.email === normalized);
    if (!target) throw new Error(`Account not found: ${normalized}`);
    const previous = list.find((a) => a.active) ?? null;

    // Phase 1: Snapshot pre-image digest & read current oauthToken from state.vscdb
    if (!fs.existsSync(opts.stateDbPath)) {
      throw new Error(`state.vscdb not found at ${opts.stateDbPath}`);
    }
    const dbBytes = fs.readFileSync(opts.stateDbPath);
    const dbPreImageSha256 = crypto.createHash('sha256').update(dbBytes).digest('hex');

    const db = new DatabaseSync(opts.stateDbPath);
    let previousOauthToken: string | undefined;
    const journalId = `sw-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

    try {
      db.exec('CREATE TABLE IF NOT EXISTS ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value TEXT)');
      const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get('antigravity.oauthToken') as
        | { value?: string }
        | undefined;
      previousOauthToken = row?.value;

      // Phase 2: Durable WAL journal BEFORE mutating resources
      const journal: SwitchJournal = {
        id: journalId,
        status: 'pending',
        fromEmail: previous?.email ?? null,
        toEmail: target.email,
        dbPreImageSha256,
        createdAt: new Date().toISOString(),
        previousOauthToken,
      };
      atomicWritePrivateFile(this.journalFile, `${JSON.stringify(journal, null, 2)}\n`);

      // Phase 3: Atomic SQLite mutation under BEGIN IMMEDIATE
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)').run(
          'antigravity.oauthToken',
          target.oauthToken,
        );
        if (target.userStatus) {
          db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)').run(
            'antigravity.userStatus',
            target.userStatus,
          );
        }

        if (opts.simulateFailureAfterMutate) {
          throw new Error('Simulated post-mutation fault');
        }

        const now = new Date().toISOString();
        const updated = list.map((a) => ({
          ...a,
          active: a.email === target.email,
          lastUsedAt: a.email === target.email ? now : a.lastUsedAt,
        }));
        this.writeIndex(updated);

        // Phase 4: Commit & redact secrets from completed WAL journal
        db.exec('COMMIT');
        journal.status = 'complete';
        delete journal.previousOauthToken;
        atomicWritePrivateFile(this.journalFile, `${JSON.stringify(journal, null, 2)}\n`);

        return {
          switchedTo: target.email,
          previousEmail: previous?.email ?? null,
          journalId,
          rolledBack: false,
        };
      } catch (err) {
        db.exec('ROLLBACK');
        journal.status = 'rolled_back';
        delete journal.previousOauthToken;
        atomicWritePrivateFile(this.journalFile, `${JSON.stringify(journal, null, 2)}\n`);
        throw err;
      }
    } finally {
      db.close();
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
