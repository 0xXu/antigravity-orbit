import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Inspects `.git/config` for unsafe `[filter ...]` or `fsmonitor` hooks before running git diff.
 */
export function assertSafeGitRepo(repoRoot: string): string {
  if (!repoRoot || repoRoot.startsWith('\\\\')) {
    throw new Error('UNC repository paths are forbidden');
  }
  const realRoot = fs.realpathSync(repoRoot);
  const gitEntry = path.join(realRoot, '.git');
  if (!fs.existsSync(gitEntry)) {
    throw new Error('Not a git repository');
  }
  const stat = fs.lstatSync(gitEntry);
  if (!stat.isDirectory()) {
    throw new Error('Fail-closed: gitfile / symlink .git is blocked for inline diff');
  }

  const configPath = path.join(gitEntry, 'config');
  if (fs.existsSync(configPath)) {
    const cfgText = fs.readFileSync(configPath, 'utf8');
    if (/^\s*\[filter\b/im.test(cfgText) || /\bfsmonitor\s*=/im.test(cfgText)) {
      throw new Error('Unsafe .git/config containing filter or fsmonitor hook');
    }
  }
  return realRoot;
}

export async function getSafeInlineDiff(repoRoot: string, relFilePath: string): Promise<string> {
  if (
    !relFilePath ||
    relFilePath.startsWith('\\\\') ||
    path.isAbsolute(relFilePath) ||
    relFilePath.includes('..') ||
    path.basename(relFilePath).toLowerCase().startsWith('.env')
  ) {
    throw new Error('Invalid or sensitive relative file path');
  }

  const realRoot = assertSafeGitRepo(repoRoot);
  const targetAbs = path.resolve(realRoot, relFilePath);
  const relCheck = path.relative(realRoot, targetAbs);
  if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
    throw new Error('File path escapes repository root');
  }
  if (fs.existsSync(targetAbs)) {
    const realTarget = fs.realpathSync(targetAbs);
    const realRel = path.relative(realRoot, realTarget);
    if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
      throw new Error('Symlink escapes repository root');
    }
  }

  const { stdout } = await execFileAsync(
    'git',
    ['--no-optional-locks', '--literal-pathspecs', '-c', 'core.fsmonitor=false', 'diff', '--no-ext-diff', '--', relFilePath],
    { cwd: realRoot, timeout: 5000, maxBuffer: 512 * 1024 },
  );
  return stdout;
}
