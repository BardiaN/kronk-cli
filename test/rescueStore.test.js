import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { config } from '../src/config.js';
import { sweep as tasklogSweep, cleanup as tasklogCleanup, sessionDir } from '../src/tasklog.js';
import {
  ROOT, TERMINAL, createJob, readJob, recordStep, markRunning, markDone, markStopped,
  markFailed, markInterrupted, toJson, collect, sweep, acquireLock, releaseLock,
} from '../src/rescueStore.js';

// Never the real temp dir: this suite creates, ages and sweeps whole trees.
config.rescueDir = mkdtempSync(join(tmpdir(), 'kronk-rescue-'));
config.taskLogDir = mkdtempSync(join(tmpdir(), 'kronk-tasklog-for-rescue-'));
config.taskLog = true;

const make = (over = {}) => createJob({ role: 'explore', prompt: 'p', ...over });

/** Rewrite one field directly on disk — for ages `collect()` itself never produces. */
function patch(id, fields) {
  const path = join(ROOT(), `${id}.json`);
  const record = JSON.parse(readFileSync(path, 'utf8'));
  Object.assign(record, fields);
  writeFileSync(path, JSON.stringify(record));
  return record;
}

// ---- state machine ------------------------------------------------------

test('a job is queued the moment it is created, nothing run yet', () => {
  const job = make();
  assert.equal(job.state, 'queued');
  assert.equal(job.steps, 0);
  assert.equal(job.report, null);
  assert.equal(readJob(job.id).state, 'queued');
});

test('running records the pid and the model it landed on', () => {
  const job = make();
  markRunning(job.id, { pid: 4242, model: 'stub/model' });
  const saved = readJob(job.id);
  assert.equal(saved.state, 'running');
  assert.equal(saved.pid, 4242);
  assert.equal(saved.model, 'stub/model');
  assert.ok(saved.startedAt);
});

test('steps are written as the job goes, so a run that never finishes still has some', () => {
  const job = make();
  markRunning(job.id, { pid: 1, model: 'm' });
  recordStep(job.id, [{ role: 'user', content: 'p' }], 1);
  recordStep(job.id, [{ role: 'user', content: 'p' }, { role: 'assistant', content: 'half way' }], 2);
  const saved = readJob(job.id);
  assert.equal(saved.steps, 2);
  assert.equal(saved.messages.length, 2);
  assert.equal(saved.state, 'running', 'no finish() yet');
});

test('done, stopped, failed and interrupted are the only terminal states, and each writes its own report', () => {
  const done = make(); markRunning(done.id, { pid: 1, model: 'm' });
  markDone(done.id, { report: 'the answer', steps: 3 });
  assert.equal(readJob(done.id).state, 'done');
  assert.equal(readJob(done.id).report, 'the answer');
  assert.ok(readJob(done.id).endedAt);

  const stopped = make(); markRunning(stopped.id, { pid: 1, model: 'm' });
  markStopped(stopped.id, { report: '(stopped: step cap reached)', steps: 40 });
  assert.equal(readJob(stopped.id).state, 'stopped');
  assert.equal(readJob(stopped.id).steps, 40);

  const failed = make(); markRunning(failed.id, { pid: 1, model: 'm' });
  markFailed(failed.id, { error: '500 the model call blew up', steps: 1 });
  assert.equal(readJob(failed.id).state, 'failed');
  assert.match(readJob(failed.id).report, /^error: 500 the model call blew up/);

  const interrupted = make(); markRunning(interrupted.id, { pid: 1, model: 'm' });
  markInterrupted(interrupted.id, { steps: 2 });
  assert.equal(readJob(interrupted.id).state, 'interrupted');
  assert.equal(readJob(interrupted.id).steps, 2);
  assert.match(readJob(interrupted.id).report, /interrupted/);

  for (const s of ['done', 'stopped', 'failed', 'interrupted']) assert.ok(TERMINAL.has(s));
  assert.ok(!TERMINAL.has('queued'));
  assert.ok(!TERMINAL.has('running'));
});

// ---- --json shape ---------------------------------------------------------

test('toJson carries exactly { id, state, role, model, steps, ms, report, transcript }', () => {
  const job = make({ model: 'stub/model' });
  markRunning(job.id, { pid: 1, model: 'stub/model' });
  recordStep(job.id, [{ role: 'user', content: 'p' }], 1);
  markDone(job.id, { report: 'done text', steps: 1 });

  const out = toJson(readJob(job.id));
  assert.deepEqual(Object.keys(out).sort(), ['id', 'ms', 'model', 'report', 'role', 'state', 'steps', 'transcript'].sort());
  assert.equal(out.id, job.id);
  assert.equal(out.state, 'done');
  assert.equal(out.role, 'explore');
  assert.equal(out.model, 'stub/model');
  assert.equal(out.steps, 1);
  assert.equal(out.report, 'done text');
  assert.deepEqual(out.transcript, [{ role: 'user', content: 'p' }]);
  assert.ok(Number.isFinite(out.ms) && out.ms >= 0);
});

test('toJson on a job still running measures elapsed time live, not zero', async () => {
  const job = make();
  markRunning(job.id, { pid: 1, model: 'm' });
  await new Promise((r) => { setTimeout(r, 5); });
  const out = toJson(readJob(job.id));
  assert.equal(out.state, 'running');
  assert.ok(out.ms > 0);
  assert.equal(out.report, null);
});

// ---- collection and lifetime ---------------------------------------------

test('collect() stamps collectedAt only once, and only on a terminal job', () => {
  const running = make();
  markRunning(running.id, { pid: 1, model: 'm' });
  assert.equal(collect(running.id).collectedAt, null, 'not terminal yet — nothing to collect');

  markDone(running.id, { report: 'r', steps: 1 });
  const first = collect(running.id);
  assert.ok(first.collectedAt);
  const stampedAt = first.collectedAt;
  const second = collect(running.id);
  assert.equal(second.collectedAt, stampedAt, 'asking again does not reset the clock');
});

test('an uncollected record survives sweep() no matter how old it is', () => {
  const job = make();
  markRunning(job.id, { pid: 1, model: 'm' });
  markDone(job.id, { report: 'r', steps: 1 });
  // Never collected: back-date everything about it and sweep hard.
  patch(job.id, { endedAt: new Date(0).toISOString() });
  sweep();
  assert.ok(readJob(job.id), 'uncollected, so still here');
});

test('a collected record is aged out only after its own 24h window, not tasklog\'s', () => {
  const recent = make();
  markRunning(recent.id, { pid: 1, model: 'm' });
  markDone(recent.id, { report: 'r', steps: 1 });
  collect(recent.id);

  const old = make();
  markRunning(old.id, { pid: 1, model: 'm' });
  markDone(old.id, { report: 'r', steps: 1 });
  collect(old.id);
  patch(old.id, { collectedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() });

  sweep();
  assert.ok(readJob(recent.id), 'collected less than 24h ago — still here');
  assert.equal(readJob(old.id), null, 'collected more than 24h ago — aged out');
});

test('tasklog\'s cleanup() and sweep() never touch a rescue record — separate directories entirely', () => {
  const job = make();
  markRunning(job.id, { pid: 1, model: 'm' });
  markDone(job.id, { report: 'r', steps: 1 });
  // Make the rescue record look exactly like what tasklog's own sweep() would
  // otherwise remove, to prove it is the directory, not the age, doing the work.
  patch(job.id, { endedAt: new Date(0).toISOString() });

  sessionDir(); // ensure tasklog's own directory exists to clean
  tasklogSweep({ all: true });
  tasklogCleanup();

  assert.ok(readJob(job.id), 'rescue keeps its own directory tasklog has never heard of');
  assert.notEqual(ROOT(), sessionDir());
});

// ---- locking ---------------------------------------------------------------

test('acquire, then release, then acquire again — the ordinary cycle', () => {
  const a = make();
  assert.equal(acquireLock(a.id), true);
  const b = make();
  assert.equal(acquireLock(b.id), false, 'held by a — b must wait');
  releaseLock(a.id);
  assert.equal(acquireLock(b.id), true, 'free now');
  releaseLock(b.id);
});

test('release only removes the lock this caller actually holds', () => {
  const a = make();
  assert.equal(acquireLock(a.id), true);
  releaseLock('not-the-holder');
  const b = make();
  assert.equal(acquireLock(b.id), false, 'still held by a — an unrelated release id did nothing');
  releaseLock(a.id);
});

test('a lock whose holder process is gone does not wedge the queue forever', () => {
  const stuck = make();
  markRunning(stuck.id, { pid: 1, model: 'm' });
  // A pid nothing on this machine is using — the crash-without-cleanup case.
  writeFileSync(join(ROOT(), 'lock.json'), JSON.stringify({ pid: 2147483647, id: stuck.id }));

  const next = make();
  assert.equal(acquireLock(next.id), true, 'the stale lock must not block a live claimant');
  assert.equal(readJob(stuck.id).state, 'interrupted',
    'the job the dead runner never finished is reported, not left at "running" forever');
  releaseLock(next.id);
});

test('a lock file too broken to read is stale, not a reason to spin', () => {
  // A process killed between creating the lock and finishing the write leaves
  // a zero-byte file. There is no pid in it to ask about, so "unreadable" has
  // to mean "stale" — treating it as "try again" is an unyielding busy loop,
  // because the exclusive create keeps failing while nothing removes the file.
  // In a detached worker that is one core pinned for as long as the machine is
  // up, with every job after it queued behind a holder that never existed.
  for (const broken of ['', 'not json at all', '{"pid":']) {
    writeFileSync(join(ROOT(), 'lock.json'), broken);
    const job = make();
    assert.equal(acquireLock(job.id), true,
      `a lock containing ${JSON.stringify(broken)} must not block a live claimant`);
    releaseLock(job.id);
  }
});

test('a lock genuinely held by a live process is respected, not stolen', () => {
  const holder = make();
  // Our own pid is unquestionably alive — stands in for "someone else's run".
  writeFileSync(join(ROOT(), 'lock.json'), JSON.stringify({ pid: process.pid, id: holder.id }));
  const waiting = make();
  assert.equal(acquireLock(waiting.id), false);
  releaseLock(holder.id);
});
