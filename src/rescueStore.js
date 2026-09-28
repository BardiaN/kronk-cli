import {
  mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { config } from './config.js';

/**
 * The record store behind `kronk-cli rescue` — one JSON file per job, plus a
 * single lock file that stands in for the one resident copy of the model
 * Kronk's pool holds. Nothing here spawns anything; that is `src/rescue.js`'s
 * job, and the split is deliberate — the state machine and the file layout
 * are exactly the part of this feature a test can drive without a process to
 * spawn, and keeping child_process out of this file keeps that true.
 *
 * A rescue record has to outlive the process that wrote it in a way a
 * sub-agent transcript (src/tasklog.js) never had to: the submitter prints an
 * id and exits on purpose, so `cleanup()` removing *its* session directory,
 * or `sweep()` aging a session out after 24h, would delete the very answer a
 * caller was told to come back for. The fix is not a special case in those
 * two functions — it's a directory neither of them has ever heard of.
 * `ROOT()` here is never `src/tasklog.js`'s `ROOT()`, so this store's own
 * lifetime rule (below) is the only one that ever applies to it.
 */

export const ROOT = () => config.rescueDir ?? join(tmpdir(), 'kronk-cli-rescue');
const LOCK = () => join(ROOT(), 'lock.json');

/**
 * Exactly the shape `newId()` produces, and the only shape a job id may have.
 *
 * A job id arrives from outside — `rescue status <id>` takes whatever was
 * typed — and it is used to build a path. Without this it is used to build
 * *any* path: `rescue result ../../something --json` would read that file and
 * print it, and `collect()` would then write the record back over it, both
 * outside the store entirely. That is a local CLI reading files its own
 * operator can already read, so the ceiling on it is low — but a path built
 * from unvalidated input is worth closing on its own terms, and the honest
 * answer to an id that cannot exist is the one the callers already handle:
 * there is no such job.
 */
const ID = /^[0-9a-z]+-[0-9a-z]+-[0-9a-f]{6}$/;

export const isJobId = (id) => typeof id === 'string' && ID.test(id);

const file = (id) => {
  if (!isJobId(id)) throw new Error(`not a job id: ${id}`);
  return join(ROOT(), `${id}.json`);
};

/**
 * Kept until collected, then aged out — the lifetime the issue asks for.
 * Anything still uncollected stays no matter how old, because "uncollected"
 * means the one caller who could read the answer has not yet asked for it;
 * removing it on a clock the caller never agreed to would be losing a job
 * nobody failed to explain to them, and quietly. Once `collect()` has stamped
 * `collectedAt`, the same 24h window `src/tasklog.js` uses applies — chosen
 * for the same reason: the record worth keeping is one from the last session
 * or two, not an accumulating archive.
 */
const KEEP_MS = 24 * 60 * 60 * 1000;

/** How the state machine may end. `queued` and `running` are the only other states. */
export const TERMINAL = new Set(['done', 'stopped', 'interrupted', 'failed']);

/** 0700 / 0600 throughout — a rescue prompt and its transcript are the same material src/tasklog.js guards. */
function ensureDir() {
  mkdirSync(ROOT(), { recursive: true, mode: 0o700 });
}

/** Never throw into the caller: a full disk must not take the job down with it. */
function flush(record) {
  try {
    ensureDir();
    writeFileSync(file(record.id), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  } catch { /* the record is a convenience for whoever collects it, not the work itself */ }
  return record;
}

/**
 * `<timestamp>-<pid>-<random>`, all base36/hex so it reads cleanly on a
 * command line with no quoting. Timestamp and pid alone repeat within the
 * same submitting process inside the same millisecond — unlikely, but a job
 * id colliding with an existing file would silently overwrite someone else's
 * record — so six hex digits of randomness closes that off for the cost of a
 * few extra characters.
 */
export function newId() {
  return `${Date.now().toString(36)}-${process.pid.toString(36)}-${randomBytes(3).toString('hex')}`;
}

/** A job as first written: queued, nothing run yet. */
export function createJob({ role, prompt, model = null, yes = false, auto = false, maxSteps = null }) {
  const id = newId();
  return flush({
    id, role, prompt, model,
    yes: Boolean(yes), auto: Boolean(auto), maxSteps,
    state: 'queued',
    pid: null,
    steps: 0,
    startedAt: null,
    endedAt: null,
    report: null,
    messages: [],
    collectedAt: null,
  });
}

/**
 * One job in full, or null. An id that is not a job id at all, one no file was
 * ever written for, and one already swept away all look the same from here —
 * deliberately: every caller's answer to all three is "there is no such job".
 */
export function readJob(id) {
  if (!isJobId(id)) return null;
  try { return JSON.parse(readFileSync(file(id), 'utf8')); }
  catch { return null; }
}

function updateJob(id, patch) {
  const record = readJob(id);
  if (!record) return null;
  Object.assign(record, patch);
  return flush(record);
}

/** Written as the job goes, same reasoning as `Run.step` in src/tasklog.js. */
export const recordStep = (id, messages, steps) => updateJob(id, { messages, steps });

export const markRunning = (id, { pid, model }) =>
  updateJob(id, { state: 'running', pid, model, startedAt: new Date().toISOString() });

function finish(id, state, extra) {
  return updateJob(id, { state, endedAt: new Date().toISOString(), ...extra });
}

export const markDone = (id, { report, steps }) => finish(id, 'done', { report, steps });
export const markStopped = (id, { report, steps }) => finish(id, 'stopped', { report, steps });
export const markFailed = (id, { error, steps }) =>
  finish(id, 'failed', { report: `error: ${error}`, steps });
export const markInterrupted = (id, { steps } = {}) =>
  finish(id, 'interrupted', {
    report: 'error: the job was interrupted before it finished',
    ...(steps === undefined ? {} : { steps }),
  });

/**
 * The `--json` shape, and exactly it: `{ id, state, role, model, steps, ms,
 * report, transcript }`. `ms` is measured live for a running job (there is no
 * `endedAt` yet) so `status --json` on a job mid-run reports how long it has
 * been going, not zero.
 */
export function toJson(record) {
  const ms = record.startedAt
    ? Date.parse(record.endedAt ?? new Date().toISOString()) - Date.parse(record.startedAt)
    : 0;
  return {
    id: record.id,
    state: record.state,
    role: record.role,
    model: record.model,
    steps: record.steps,
    ms,
    report: record.report,
    transcript: record.messages,
  };
}

/**
 * Stamp the moment a terminal job was actually read back by `wait` or
 * `result` — never by `status`, which is a peek, not a collection. Idempotent:
 * the first caller to ask starts the clock, and asking again does not reset
 * it, so two scripts polling the same id do not keep a finished job alive
 * forever between them.
 */
export function collect(id) {
  const record = readJob(id);
  if (!record) return null;
  if (TERMINAL.has(record.state) && !record.collectedAt) {
    return updateJob(id, { collectedAt: new Date().toISOString() });
  }
  return record;
}

/** Collected records older than `KEEP_MS`; everything else is left alone. */
export function sweep() {
  let names;
  try { names = readdirSync(ROOT()); } catch { return 0; }
  let removed = 0;
  for (const f of names) {
    if (!f.endsWith('.json') || f === 'lock.json') continue;
    const full = join(ROOT(), f);
    try {
      const record = JSON.parse(readFileSync(full, 'utf8'));
      if (!record.collectedAt) continue;
      if (Date.now() - Date.parse(record.collectedAt) < KEEP_MS) continue;
      rmSync(full, { force: true });
      removed += 1;
    } catch { /* a record this cannot parse is not one it should guess about */ }
  }
  return removed;
}

/** Whether `pid` is a live process this machine still knows about. */
function isAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; } // exists, owned by someone else — do not steal it
}

function readLock() {
  try { return JSON.parse(readFileSync(LOCK(), 'utf8')); }
  catch { return null; }
}

/**
 * Claim the single slot the pool allows — see src/subagent.js's module
 * comment for why there is only one. A plain exclusive create (`wx`) is the
 * whole mechanism for the race: two runners asking for the same path can only
 * ever have one winner, with no window in which both believe they hold it.
 *
 * The failure this still has to survive is not the race, it's the crash. A
 * runner that dies holding the lock — killed, OOM, the machine rebooting —
 * leaves the file behind with nobody left to remove it, and every caller
 * after that would otherwise queue forever behind a process that no longer
 * exists. So a lock file whose pid is not running is not treated as held: the
 * job it belonged to never reached a terminal state on its own and never
 * will, so that is recorded — `interrupted`, not left at `running` forever —
 * before the file is cleared and the next claimant gets a turn.
 *
 * A lock that cannot be *parsed* is the same case, and it has to be handled
 * as one rather than retried. A process killed between creating the file and
 * finishing the write leaves a zero-byte `lock.json`: there is no pid in it to
 * ask about, so treating "unreadable" as "try again" is an unyielding busy
 * loop — the exclusive create keeps failing because the file is still there,
 * and nothing in the loop ever removes it. In a detached worker nobody is
 * watching, that is one core at 100% for as long as the machine is up, with
 * every job after it queued behind a holder that was never alive. Unreadable
 * means stale, for the same reason a dead pid does: there is no holder to
 * respect.
 *
 * And the loop is bounded regardless. Every branch below either returns or
 * removes the file it just failed to create, so the bound should be
 * unreachable — which is exactly why it is cheap to have, and why a bug here
 * costs a delayed job rather than a pinned CPU.
 */
const LOCK_TRIES = 50;

export function acquireLock(id) {
  ensureDir();
  for (let attempt = 0; attempt < LOCK_TRIES; attempt += 1) {
    try {
      writeFileSync(LOCK(), JSON.stringify({ pid: process.pid, id }), { flag: 'wx', mode: 0o600 });
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    const holder = readLock();
    if (holder && isAlive(holder.pid)) return false;   // genuinely running someone else's job
    if (holder && holder.id !== id) {
      const stuck = readJob(holder.id);
      if (stuck && !TERMINAL.has(stuck.state)) markInterrupted(holder.id, { steps: stuck.steps });
    }
    try { unlinkSync(LOCK()); } catch { /* someone else already cleared it */ }
  }
  // Contended past all patience: not held by us, so the caller waits and asks
  // again rather than proceeding as though it had the slot.
  return false;
}

/** Release the lock, but only the copy this process actually holds. */
export function releaseLock(id) {
  const holder = readLock();
  if (holder && holder.pid === process.pid && holder.id === id) {
    try { unlinkSync(LOCK()); } catch { /* already gone */ }
  }
}
