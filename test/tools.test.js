import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clip, safe, session, runBash, TOOLS, NEEDS_APPROVAL, mcpNeedsApproval } from '../src/tools.js';

// realpath, because macOS maps /var onto /private/var and the shell reports the latter
const root = realpathSync(mkdtempSync(join(tmpdir(), 'kronk-tools-')));
session.root = root;
session.cwd = root;

test('clip leaves short text alone', () => {
  assert.equal(clip('hello'), 'hello');
});

test('clip trims the middle, never the tail', () => {
  const body = `HEAD${'x'.repeat(60_000)}TAIL_ERROR_HERE`;
  const out = clip(body);
  assert.ok(out.startsWith('HEAD'), 'keeps the head');
  assert.ok(out.endsWith('TAIL_ERROR_HERE'), 'keeps the tail — errors live there');
  assert.match(out, /elided from the middle/);
  assert.ok(out.length < body.length);
});

test('safe resolves inside the root', () => {
  assert.equal(safe('a/b.txt'), join(root, 'a/b.txt'));
});

test('safe refuses to escape the root', () => {
  assert.throws(() => safe('../outside.txt'), /refusing to touch path outside/);
  assert.throws(() => safe('/etc/passwd'), /refusing to touch path outside/);
});

test('bash reports a real exit code, not the marker’s', async () => {
  const out = await runBash('exit 7');
  assert.match(out, /^error: exit code 7/);
});

test('bash surfaces stderr on failure', async () => {
  const out = await runBash('echo boom >&2; exit 1');
  assert.match(out, /exit code 1/);
  assert.match(out, /boom/);
});

test('bash returns plain output on success', async () => {
  assert.equal((await runBash('echo fine')).trim(), 'fine');
});

test('cd persists to the next call', async () => {
  writeFileSync(join(root, 'marker.txt'), 'x');
  await runBash('mkdir -p nested && cd nested');
  const pwd = (await runBash('pwd')).trim();
  assert.ok(pwd.endsWith('/nested'), `expected to still be in nested, got ${pwd}`);
  session.cwd = root;
});

test('cd cannot escape the root', async () => {
  await runBash('cd /tmp');
  assert.equal(session.cwd, root, 'session cwd must stay inside the launch root');
});

test('a timeout is reported as such, with partial output', async () => {
  const out = await runBash('echo started; sleep 10', { timeoutMs: 400 });
  assert.match(out, /killed after/);
  assert.match(out, /timeout 0s|timeout 1s/);
  assert.match(out, /started/, 'output printed before the kill survives');
});

test('built-in approval gating covers exactly the mutating tools', () => {
  assert.ok(NEEDS_APPROVAL.has('write_file'));
  assert.ok(NEEDS_APPROVAL.has('bash'));
  assert.ok(!NEEDS_APPROVAL.has('read_file'));
});

test('every tool declares a JSON schema', () => {
  for (const t of TOOLS) {
    assert.equal(t.type, 'function');
    assert.equal(typeof t.function.name, 'string');
    assert.equal(t.function.parameters.type, 'object');
  }
});

test('MCP approval keys off write-ish verbs', () => {
  assert.ok(mcpNeedsApproval('argocd__delete_application'));
  assert.ok(mcpNeedsApproval('eks__apply_yaml'));
  assert.ok(mcpNeedsApproval('github__create_issue'));
  assert.ok(!mcpNeedsApproval('nx__nx_docs'));
  assert.ok(!mcpNeedsApproval('argocd__list_applications'));
  assert.ok(!mcpNeedsApproval('eks__get_pod_logs'));
});
