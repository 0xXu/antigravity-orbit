import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const ANTIGRAVITY_KEYCHAIN_SERVICE = 'gemini';
export const ANTIGRAVITY_KEYCHAIN_ACCOUNT = 'antigravity';

export interface KeychainStore {
  readPassword(service: string, account: string): Promise<string | null>;
  writePassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<void>;
}

/**
 * macOS Keychain adapter using `/usr/bin/security`.
 * Writes via `security -i` stdin so credentials NEVER appear in argv / process lists.
 */
export class MacKeychainStore implements KeychainStore {
  async readPassword(service: string, account: string): Promise<string | null> {
    if (process.platform !== 'darwin') return null;
    try {
      const { stdout } = await execFileAsync(
        '/usr/bin/security',
        ['find-generic-password', '-s', service, '-a', account, '-w'],
        { timeout: 5000 },
      );
      const trimmed = stdout.trim();
      return trimmed.length > 0 ? trimmed : null;
    } catch {
      return null;
    }
  }

  async writePassword(service: string, account: string, password: string): Promise<void> {
    if (process.platform !== 'darwin') return;
    await new Promise<void>((resolve, reject) => {
      const q = (val: string) =>
        `"${String(val).replace(/[\\"\r\n]/g, (m) => (m === '\r' || m === '\n' ? '' : `\\${m}`))}"`;
      const child = spawn('/usr/bin/security', ['-i'], { stdio: ['pipe', 'ignore', 'pipe'] });
      let settled = false;
      const done = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };
      const timer = setTimeout(() => {
        try {
          child.kill();
        } catch {
          // Ignore kill error
        }
        done(new Error('Keychain write timed out'));
      }, 5000);

      child.stdin.on('error', () => {});
      child.stdin.end(`add-generic-password -U -s ${q(service)} -a ${q(account)} -w ${q(password)}\n`);
      child.stderr.on('data', () => {});
      child.on('close', (code) => {
        if (code === 0) done();
        else done(new Error(`Keychain write failed (exit ${code ?? -1})`));
      });
      child.on('error', (err) => done(err));
    });
  }

  async deletePassword(service: string, account: string): Promise<void> {
    if (process.platform !== 'darwin') return;
    try {
      await execFileAsync('/usr/bin/security', ['delete-generic-password', '-s', service, '-a', account], {
        timeout: 5000,
      });
    } catch {
      // Ignore missing entry
    }
  }
}
