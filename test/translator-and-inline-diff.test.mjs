import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import {
  ThoughtTranslatorService,
  assertSafeGitRepo,
  getSafeInlineDiff,
  validateTranslatorEndpoint,
} from '../packages/core/dist/main.js';

describe('core/services: ThoughtTranslatorService', () => {
  it('blocks cloud metadata hosts, high-risk internal ports, and non-HTTP protocols', () => {
    assert.throws(() => validateTranslatorEndpoint('http://169.254.169.254/latest/meta-data/'), /Blocked metadata host/);
    assert.throws(
      () => validateTranslatorEndpoint('http://metadata.google.internal/computeMetadata/v1/'),
      /Blocked metadata host/,
    );
    assert.throws(() => validateTranslatorEndpoint('http://100.100.100.200/latest/'), /Blocked metadata host/);
    assert.throws(() => validateTranslatorEndpoint('http://127.0.0.1:6379/'), /Blocked high-risk port/);
    assert.throws(() => validateTranslatorEndpoint('http://127.0.0.1:5432/'), /Blocked high-risk port/);
    assert.throws(() => validateTranslatorEndpoint('file:///etc/passwd'), /Unsupported translator protocol/);

    const okLocal = validateTranslatorEndpoint('http://127.0.0.1:11434/v1/chat/completions');
    assert.equal(okLocal.port, '11434');
  });

  it('short-circuits blank input, validates LLM endpoint, calls upstream LLM, and enforces concurrency limit', async () => {
    const svc = new ThoughtTranslatorService();

    const empty = await svc.translate({ text: '   ', mode: 'llm' });
    assert.deepEqual(empty, { translated: '', mode: 'llm', durationMs: 0 });

    await assert.rejects(
      () => svc.translate({ text: 'hello', mode: 'llm' }),
      /requires an endpoint URL/,
    );

    let releasePending;
    const server = http.createServer((req, res) => {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (chunk) => {
        body += chunk;
      });
      req.on('end', () => {
        if (req.url === '/hold') {
          releasePending = () => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ choices: [{ message: { content: 'done' } }] }));
          };
          return;
        }
        const parsed = JSON.parse(body);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: `[${parsed.model}] 翻译结果` } }],
          }),
        );
      });
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
      const result = await svc.translate({
        text: 'Inspecting auth flow',
        mode: 'llm',
        endpoint: `http://127.0.0.1:${port}/v1/chat/completions`,
        model: 'test-model',
        apiKey: 'secret-key',
      });
      assert.equal(result.mode, 'llm');
      assert.equal(result.translated, '[test-model] 翻译结果');

      // Concurrency cap of 3
      const resolvers = [];
      const holdServer = http.createServer((_req, res) => {
        resolvers.push(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
        });
      });
      await new Promise((resolve) => holdServer.listen(0, '127.0.0.1', resolve));
      const holdPort = holdServer.address().port;
      try {
        const reqs = [1, 2, 3].map((n) =>
          svc.translate({
            text: `msg-${n}`,
            mode: 'llm',
            endpoint: `http://127.0.0.1:${holdPort}/v1`,
          }),
        );
        await assert.rejects(
          () =>
            svc.translate({
              text: 'msg-4',
              mode: 'llm',
              endpoint: `http://127.0.0.1:${holdPort}/v1`,
            }),
          /concurrency limit \(3\)/,
        );
        // Wait briefly for the 3 requests to reach server then release them
        while (resolvers.length < 3) {
          await new Promise((r) => setTimeout(r, 5));
        }
        for (const finish of resolvers) finish();
        await Promise.all(reqs);
      } finally {
        await new Promise((resolve) => holdServer.close(resolve));
      }
    } finally {
      if (releasePending) releasePending();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('core/services: inline-diff security and git diff reading', () => {
  it('reads clean git diffs and blocks traversal, .env, outside symlinks, and unsafe .git/config hooks', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-orbit-git-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-orbit-outside-'));
    try {
      execFileSync('git', ['init'], { cwd: repo, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repo });
      execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repo });
      fs.writeFileSync(path.join(repo, 'app.ts'), 'export const x = 1;\n');
      execFileSync('git', ['add', 'app.ts'], { cwd: repo });
      execFileSync('git', ['commit', '-m', 'init'], { cwd: repo, stdio: 'ignore' });

      fs.writeFileSync(path.join(repo, 'app.ts'), 'export const x = 2;\n');
      const diff = await getSafeInlineDiff(repo, 'app.ts');
      assert.ok(diff.includes('-export const x = 1;'));
      assert.ok(diff.includes('+export const x = 2;'));

      // Blocked relative paths
      await assert.rejects(() => getSafeInlineDiff(repo, '../secret.txt'));
      await assert.rejects(() => getSafeInlineDiff(repo, '.env.local'));
      await assert.rejects(() => getSafeInlineDiff(repo, '/etc/passwd'));

      // Symlink escaping repo root is blocked
      const outsideFile = path.join(outside, 'leak.txt');
      fs.writeFileSync(outsideFile, 'secret');
      fs.symlinkSync(outsideFile, path.join(repo, 'escape-link.txt'));
      await assert.rejects(() => getSafeInlineDiff(repo, 'escape-link.txt'), /Symlink escapes/);

      // Non-git directory and UNC paths blocked
      assert.throws(() => assertSafeGitRepo(outside), /Not a git repository/);
      assert.throws(() => assertSafeGitRepo('\\\\evil\\share'), /UNC repository paths/);

      // Malicious [filter] in .git/config blocked fail-closed
      fs.appendFileSync(path.join(repo, '.git', 'config'), '\n[filter "evil"]\n\tclean = echo pwned\n');
      assert.throws(() => assertSafeGitRepo(repo), /Unsafe \.git\/config/);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
