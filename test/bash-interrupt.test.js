import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { session, runBash, runTool, killAllJobs, backgroundJobs } from '../src/tools.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'kronk-intr-')));
session.root = root;
session.cwd = root;

/** Whether any process still has `needle` in its command line. */
function alive(needle) {
  try { execFileSync('pgrep', ['-f', needle], { stdio: 'pipe' }); return true; }
  catch { return false; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('aborting the turn stops a running foreground command', async () => {
  const ac = new AbortController();
  const started = Date.now();
  const p = runBash('echo begun; sleep 31.11', { signal: ac.signal });
  await sleep(400);
  assert.ok(alive('sleep 31.11'), 'running before the abort');
  ac.abort();
  const out = await p;
  assert.match(out, /^error: interrupted by the user/);
  assert.match(out, /begun/);
  assert.ok(Date.now() - started < 3000, 'did not wait for the command');
  await sleep(100);
  assert.equal(alive('sleep 31.11'), false, 'the process group is gone');
});

test('a command that ignores SIGTERM is killed after the grace period', async () => {
  const ac = new AbortController();
  const p = runBash("trap '' TERM; sleep 31.22", { signal: ac.signal });
  await sleep(400);
  ac.abort();
  const out = await p;
  assert.match(out, /interrupted/);
  await sleep(100);
  assert.equal(alive('sleep 31.22'), false);
});

test('an already-aborted signal runs nothing', async () => {
  const ac = new AbortController();
  ac.abort();
  assert.match(await runBash('sleep 31.33', { signal: ac.signal }), /interrupted/);
  assert.equal(alive('sleep 31.33'), false);
});

test('Ctrl-C does not touch a background job', async () => {
  const ac = new AbortController();
  const out = await runTool('bash', { cmd: 'sleep 31.44' }, { signal: ac.signal, timeoutMs: 200 });
  assert.match(out, /still running/);
  ac.abort();
  await sleep(300);
  assert.ok(alive('sleep 31.44'), 'the job survives the abort');
  assert.equal(backgroundJobs(), 1);
  killAllJobs();
});
