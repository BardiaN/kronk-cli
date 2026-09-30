import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { config } from '../src/config.js';
import { readJob, TERMINAL } from '../src/rescueStore.js';
import { startStub } from './fixtures/kronk-stub.js';

/**
 * `kronk-cli rescue` end to end: the real CLI, spawned as a real (if
 * detached) child process, against a stubbed Kronk. A state machine is only
 * proven by a job that actually goes through its states — every property
 * asserted here is one no unit test of rescueStore.js or rescue.js in
 * isolation could see, because it depends on the submit command really
 * returning while a separate process really keeps working.
 */

const run = promisify(execFile);
const CLI = new URL('../src/index.js', import.meta.url).pathname;

/** A fresh HOME and a fresh rescue store for one test, so nothing bleeds between them. */
function newEnv(stubUrl) {
  const home = mkdtempSync(join(tmpdir(), 'kronk-rescue-e2e-home-'));
  const rescueDir = mkdtempSync(join(tmpdir(), 'kronk-rescue-e2e-store-'));
  const env = {
    ...process.env, KRONK_URL: stubUrl, KRONK_RESCUE_DIR: rescueDir, HOME: home, NO_COLOR: '1',
  };
  delete env.KRONK_MODEL;
  delete env.KRONK_WARM;
  delete env.KRONK_NO_THINK;
  delete env.KRONK_PRESERVE_THINKING;
  return { env, rescueDir };
}

/** Run the CLI, never throwing on a non-zero exit — `wait`'s whole point is that exit code. */
async function cli(env, args) {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { env, timeout: 30_000 });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

const submit = async (env, args) => {
  const r = await cli(env, ['rescue', ...args]);
  assert.equal(r.code, 0, `submit failed: ${r.stderr}`);
  return r.stdout.trim();
};

/**
 * Start a stub that is closed when the test ends, pass or fail. A failed
 * assertion before an inline `stub.close()` would otherwise leave the server
 * holding the event loop open, and `node --test` would hang until CI kills it.
 */
async function stubFor(t, opts) {
  const stub = await startStub(opts);
  t.after(() => stub.close());
  return stub;
}

/** Poll until the job reaches `state`, or give up and return what it last was. */
async function pollUntilState(rescueDir, id, state, timeoutMs = 5_000) {
  config.rescueDir = rescueDir;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const record = readJob(id);
    if (record?.state === state || Date.now() > deadline) return record;
    await new Promise((r) => { setTimeout(r, 10); });
  }
}

/** Poll the record directly — faster and less noisy than shelling out for every tick. */
async function pollUntilTerminal(rescueDir, id, timeoutMs = 15_000) {
  config.rescueDir = rescueDir;
  const seen = new Set();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const record = readJob(id);
    if (record) seen.add(record.state);
    if (record && TERMINAL.has(record.state)) return { record, seen };
    if (Date.now() > deadline) return { record, seen };
    await new Promise((r) => { setTimeout(r, 10); });
  }
}

// ---- the happy path: queued → running → done ------------------------------

test('a job goes through queued → running → done, and status/wait/result agree at each point', async (t) => {
  const stub = await stubFor(t, {
    ids: ['stub/small'],
    delayMs: 250,
    turns: [
      { tool: ['list_dir', { path: '.' }] },
      { text: 'the parser is at src/sse.js:41' },
    ],
  });
  const { env, rescueDir } = newEnv(stub.url);

  const t0 = Date.now();
  const id = await submit(env, ['find the parser', '--role', 'explore']);
  const submitMs = Date.now() - t0;
  assert.ok(submitMs < 3000, `submit must return promptly, took ${submitMs}ms`);
  assert.match(id, /^[0-9a-z]+-[0-9a-z]+-[0-9a-f]{6}$/);

  const { record, seen } = await pollUntilTerminal(rescueDir, id);
  stub.close();

  assert.ok(seen.has('running'), `expected to observe "running" at some point, saw: ${[...seen]}`);
  assert.equal(record.state, 'done');
  assert.equal(record.report, 'the parser is at src/sse.js:41');
  // Steps count tool-call rounds, the same convention src/tasklog.js and
  // src/subagent.js already use — the round that only produces the final
  // answer is not one of them.
  assert.equal(record.steps, 1);

  // status --json, mid-store, matches the same record.
  const status = await cli(env, ['rescue', 'status', id, '--json']);
  assert.equal(status.code, 0);
  const statusJson = JSON.parse(status.stdout);
  assert.equal(statusJson.state, 'done');
  assert.equal(statusJson.model, 'stub/small');

  // wait: prints the report, exits 0.
  const waited = await cli(env, ['rescue', 'wait', id]);
  assert.equal(waited.code, 0, 'done ⇒ exit 0');
  assert.equal(waited.stdout.trim(), 'the parser is at src/sse.js:41');

  // result --json: the full record shape, the same report.
  const result = await cli(env, ['rescue', 'result', id, '--json']);
  assert.equal(result.code, 0);
  const resultJson = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(resultJson).sort(),
    ['id', 'ms', 'model', 'report', 'role', 'state', 'steps', 'transcript'].sort());
  assert.equal(resultJson.report, 'the parser is at src/sse.js:41');
  assert.ok(Array.isArray(resultJson.transcript) && resultJson.transcript.length > 0);
});

// ---- failure states ---------------------------------------------------------

test('a job whose model call errors ends failed, and wait exits 3', async (t) => {
  const stub = await stubFor(t, {
    ids: ['stub/small'],
    turns: [{ status: 500, message: 'the model blew up' }],
  });
  const { env, rescueDir } = newEnv(stub.url);
  const id = await submit(env, ['this will error out']);

  const { record } = await pollUntilTerminal(rescueDir, id);
  stub.close();

  assert.equal(record.state, 'failed');
  assert.match(record.report, /^error: /);

  const waited = await cli(env, ['rescue', 'wait', id]);
  assert.equal(waited.code, 3);
});

test('a job that hits its step cap ends stopped, and wait exits 1', async (t) => {
  const stub = await stubFor(t, {
    ids: ['stub/small'],
    turns: [{ tool: ['list_dir', { path: '.' }] }],
  });
  const { env, rescueDir } = newEnv(stub.url);
  const id = await submit(env, ['loop forever if you can', '--steps', '1']);

  const { record } = await pollUntilTerminal(rescueDir, id);
  stub.close();

  assert.equal(record.state, 'stopped');
  // Said in terms of the job the caller submitted, not in `runTurn`'s own
  // words — those are written for a sub-agent with somebody at a terminal
  // above it, which is not who reads a rescue record.
  assert.match(record.report, /^error: the job reached its step cap of 1 before finishing$/);

  const waited = await cli(env, ['rescue', 'wait', id]);
  assert.equal(waited.code, 1);
});

test('a job is never handed the tool that starts more jobs', async (t) => {
  const stub = await stubFor(t, { ids: ['stub/small'] });
  const { env, rescueDir } = newEnv(stub.url);
  const id = await submit(env, ['have a look around', '--role', 'code']);

  await pollUntilTerminal(rescueDir, id);
  const [request] = stub.chat;
  stub.close();

  // `runTurn` adds `taskTools(depth)` on top of the list it is given, and at
  // depth 0 that is the `task` tool. A rescue job runs at depth 1 precisely so
  // this cannot happen: the issue promises the role's own tool list, and a
  // detached job nobody is watching must not be able to start further runs,
  // each able to pull a different model into a pool that holds one.
  const offered = request.tools.map((t) => t.function.name);
  assert.ok(!offered.includes('task'),
    `a rescue job was offered the delegation tool: ${offered.join(', ')}`);
  // `code` is the widest role there is, so if any role would have carried it,
  // this one would — and it still gets everything it is supposed to have.
  assert.ok(offered.includes('bash') && offered.includes('write_file'),
    'while still getting the tools its own role does list');
});

// ---- one at a time ------------------------------------------------------------

test('a second submit while one job is running reports queued, not running', async (t) => {
  const stub = await stubFor(t, {
    ids: ['stub/small'],
    delayMs: 2000,
    turns: [{ text: 'first job done' }, { text: 'second job done' }],
  });
  const { env, rescueDir } = newEnv(stub.url);

  const first = await submit(env, ['the first job']);
  // Wait for the first job's worker to win the lock and start its request.
  // A fixed sleep was too short on a loaded CI runner; the stub's delay keeps
  // the job running long enough for the second submit to land behind it.
  const firstRecord = await pollUntilState(rescueDir, first, 'running');
  assert.equal(firstRecord?.state, 'running', 'sanity: the first job really is under way');

  const second = await submit(env, ['the second job']);
  const secondStatus = await cli(env, ['rescue', 'status', second]);
  assert.equal(secondStatus.code, 0);
  assert.equal(secondStatus.stdout.trim(), 'queued', 'must not pretend to run alongside the first');

  const [firstDone, secondDone] = await Promise.all([
    pollUntilTerminal(rescueDir, first),
    pollUntilTerminal(rescueDir, second),
  ]);
  stub.close();

  assert.equal(firstDone.record.state, 'done');
  assert.equal(secondDone.record.state, 'done');
  assert.ok(Date.parse(secondDone.record.startedAt) >= Date.parse(firstDone.record.endedAt) - 5,
    'the second job must not have started before the first one ended');
});

// ---- approval, unattended ------------------------------------------------------

test('without --yes, a role that could write is still refused when it tries to — never auto-allowed', async (t) => {
  const stub = await stubFor(t, {
    ids: ['stub/small'],
    turns: [
      { tool: ['write_file', { path: 'x.txt', content: 'hi' }] },
      { text: 'could not write it' },
    ],
  });
  const { env, rescueDir } = newEnv(stub.url);
  const id = await submit(env, ['write a file', '--role', 'code']); // no --yes, no --auto

  const { record } = await pollUntilTerminal(rescueDir, id);
  stub.close();

  assert.equal(record.state, 'done');
  const toolResult = record.messages.find((m) => m.role === 'tool');
  assert.match(toolResult.content, /denied/, 'a write with nobody to ask must be refused, not silently run');
});
