import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { config } from '../src/config.js';
import { parseRescueCommand, runRescue, EXIT_CODES } from '../src/rescue.js';
import { readJob, createJob, isJobId, ROOT } from '../src/rescueStore.js';
import { startStub } from './fixtures/kronk-stub.js';

// Never the real temp dir, and never the real config file's model.
config.rescueDir = mkdtempSync(join(tmpdir(), 'kronk-rescue-cmd-'));
process.env.KRONK_RESCUE_DIR = config.rescueDir;

// A successful submit here really does spawn a detached worker (that is the
// feature under test), and that child reads KRONK_URL fresh from its own
// environment rather than from anything this process mutates on `config`.
// Point it at a port nothing will ever answer on, so a worker spawned by this
// suite can never reach a real Kronk server — including one already busy
// serving the one model slot the machine running these tests might have
// resident — no matter what the developer's own shell has KRONK_URL set to.
process.env.KRONK_URL = 'http://127.0.0.1:1/v1';

const OTHER = 'stub/Other-Q4/AGENT';
const DEFAULT = 'unsloth/Qwen3.6-35B-A3B-UD-Q4_K_M/AGENT';

const baseArgs = () => ({
  words: [], role: null, model: null, json: false, yes: false, auto: false,
  steps: null, rescueWorker: null,
});

/** Every *.json file rescueStore wrote, freshest last — for "did a job get created at all". */
const jobFiles = () => readdirSync(ROOT()).filter((f) => f.endsWith('.json') && f !== 'lock.json');

const capture = () => {
  const out = []; const err = [];
  const log = console.log; const error = console.error;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => err.push(a.join(' '));
  return { out, err, restore: () => { console.log = log; console.error = error; } };
};

// ---- parseRescueCommand ----------------------------------------------------

test('a quoted prompt, however long, is one word and always submits', () => {
  const r = parseRescueCommand(['rescue', 'trace how the SSE parser handles multi-line data fields']);
  assert.deepEqual(r, { verb: 'submit', prompt: 'trace how the SSE parser handles multi-line data fields' });
});

test('an unquoted prompt of three or more words submits too', () => {
  const r = parseRescueCommand(['rescue', 'find', 'the', 'sse', 'parser']);
  assert.deepEqual(r, { verb: 'submit', prompt: 'find the sse parser' });
});

test('status, wait and result each take exactly one job id', () => {
  assert.deepEqual(parseRescueCommand(['rescue', 'status', 'abc']), { verb: 'status', id: 'abc' });
  assert.deepEqual(parseRescueCommand(['rescue', 'wait', 'abc']), { verb: 'wait', id: 'abc' });
  assert.deepEqual(parseRescueCommand(['rescue', 'result', 'abc']), { verb: 'result', id: 'abc' });
});

test('a verb with no id, or with too many words, is a usage error', () => {
  assert.match(parseRescueCommand(['rescue', 'status']).error, /status takes exactly one job id/);
  assert.match(parseRescueCommand(['rescue', 'status', 'abc', 'extra']).error, /status takes exactly one job id/);
});

test('rescue with no prompt at all is a usage error', () => {
  assert.match(parseRescueCommand(['rescue']).error, /rescue needs a prompt/);
});

test('an unknown two-word verb is a usage error rather than a silently wrong job lookup', () => {
  const r = parseRescueCommand(['rescue', 'cancel', 'abc']);
  assert.match(r.error, /unknown rescue verb: "cancel"/);
});

// ---- role validation --------------------------------------------------------

test('an unknown --role is refused before anything is created', async () => {
  const before = jobFiles().length;
  const cap = capture();
  const code = await runRescue({ ...baseArgs(), words: ['rescue', 'do the thing'], role: 'reviewer' });
  cap.restore();
  assert.equal(code, 2);
  assert.match(cap.err.join('\n'), /unknown role "reviewer"/);
  assert.equal(jobFiles().length, before, 'nothing was submitted');
});

test('an empty prompt is refused', async () => {
  const cap = capture();
  const code = await runRescue({ ...baseArgs(), words: ['rescue', '   '] });
  cap.restore();
  assert.equal(code, 2);
  assert.match(cap.err.join('\n'), /rescue needs a prompt/);
});

// ---- --model resolution, same rule as #84 -----------------------------------

test('--model that matches nothing Kronk is serving is refused at submit time', async () => {
  const stub = await startStub({ ids: [DEFAULT, OTHER] });
  const saved = config.baseUrl;
  config.baseUrl = stub.url;
  const before = jobFiles().length;
  const cap = capture();
  const code = await runRescue({
    ...baseArgs(), words: ['rescue', 'find the parser'], model: 'nothing-like-this-exists',
  });
  cap.restore();
  config.baseUrl = saved;
  stub.close();

  assert.equal(code, 1);
  assert.match(cap.err.join('\n'), /no model matching "nothing-like-this-exists"/);
  assert.equal(jobFiles().length, before, 'a bad model name must not create a job that will only fail later');
});

test('--model resolves through resolveModel against chatModels(listModels()), substring included', async () => {
  const stub = await startStub({ ids: [DEFAULT, OTHER] });
  const saved = config.baseUrl;
  config.baseUrl = stub.url;
  const cap = capture();
  const code = await runRescue({
    ...baseArgs(), words: ['rescue', 'find the parser'], model: 'Other-Q4', json: true,
  });
  cap.restore();
  config.baseUrl = saved;
  stub.close();

  assert.equal(code, 0);
  const printed = JSON.parse(cap.out.join(''));
  assert.equal(printed.model, OTHER, 'resolved to the full served id, not the substring typed');
  const onDisk = readJob(printed.id);
  assert.equal(onDisk.model, OTHER);
  assert.equal(onDisk.state, 'queued');
});

// ---- submit prints an id and returns immediately ----------------------------

test('submit without --model prints a bare id, and the record starts queued', async () => {
  const cap = capture();
  const t0 = Date.now();
  const code = await runRescue({ ...baseArgs(), words: ['rescue', 'look around the repo'] });
  const elapsed = Date.now() - t0;
  cap.restore();

  assert.equal(code, 0);
  const id = cap.out.join('').trim();
  assert.match(id, /^[0-9a-z]+-[0-9a-z]+-[0-9a-f]{6}$/, 'the id shape rescueStore.newId() produces');
  assert.equal(readJob(id).state, 'queued');
  // No network call is needed when --model is not given, so this really is
  // "print an id and get out of the way" rather than a disguised wait.
  assert.ok(elapsed < 2000, `submit must return promptly, took ${elapsed}ms`);
});

test('--json on submit prints the full record shape, not just the id', async () => {
  const cap = capture();
  const code = await runRescue({ ...baseArgs(), words: ['rescue', 'look around'], json: true });
  cap.restore();
  assert.equal(code, 0);
  const printed = JSON.parse(cap.out.join(''));
  assert.deepEqual(Object.keys(printed).sort(),
    ['id', 'ms', 'model', 'report', 'role', 'state', 'steps', 'transcript'].sort());
  assert.equal(printed.state, 'queued');
  assert.equal(printed.role, 'explore');
});

// ---- status / wait / result on an id that does not exist --------------------

test('status, wait and result on an unknown id all fail rather than hang', async () => {
  for (const verb of ['status', 'wait', 'result']) {
    const cap = capture();
    const code = await runRescue({ ...baseArgs(), words: ['rescue', verb, 'no-such-job'] });
    cap.restore();
    assert.equal(code, 1, verb);
    assert.match(cap.err.join('\n'), /no rescue job no-such-job/, verb);
  }
});

test('result on a job that has not finished yet refuses rather than printing nothing', async () => {
  const cap1 = capture();
  await runRescue({ ...baseArgs(), words: ['rescue', 'a queued job'] });
  const id = cap1.out.join('').trim();
  cap1.restore();

  const cap2 = capture();
  const code = await runRescue({ ...baseArgs(), words: ['rescue', 'result', id] });
  cap2.restore();
  assert.equal(code, 4, 'a distinct "ask again" code, none of wait\'s four state codes');
  assert.match(cap2.err.join('\n'), /not finished yet/);
});

// ---- exit codes --------------------------------------------------------------

test('a job id that could escape the store is not a job id at all', async () => {
  // `rescue result ../x --json` used to read that file and print it, and the
  // collect() that follows would write the record back over it — both outside
  // the store. The ceiling was low (a local CLI, an operator reading their own
  // files) but a path built from unvalidated input closes on its own terms.
  for (const bad of ['../secret', '../../etc/passwd', 'a/b', '', '.', 'nope']) {
    assert.equal(readJob(bad), null, `${JSON.stringify(bad)} must not resolve to a record`);
    assert.equal(isJobId(bad), false);
  }

  // And a real one still works, so the guard is not simply refusing everything.
  const store = mkdtempSync(join(tmpdir(), 'kronk-rescue-id-'));
  config.rescueDir = store;
  const job = createJob({ role: 'explore', prompt: 'p' });
  assert.equal(isJobId(job.id), true, `newId() must produce an id its own guard accepts: ${job.id}`);
  assert.equal(readJob(job.id).id, job.id);
});

test('EXIT_CODES names exactly the four terminal states', () => {
  assert.deepEqual(EXIT_CODES, { done: 0, stopped: 1, interrupted: 2, failed: 3 });
});
