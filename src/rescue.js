import { spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { config, DEFAULT_MODEL, applyLimits } from './config.js';
import { listModels, modelLimits } from './client.js';
import { chatModels, pickDefault } from './boot.js';
import { resolveModel } from './resolve.js';
import { AGENTS, subagentTools, systemFor } from './subagent.js';
import { runTurn } from './agent.js';
import { projectContext } from './context.js';
import {
  ROOT, TERMINAL, createJob, readJob, recordStep, markRunning, markDone, markStopped,
  markFailed, markInterrupted, toJson, collect, sweep, acquireLock, releaseLock,
} from './rescueStore.js';

/**
 * `kronk-cli rescue` — the door the issue describes: a job an external
 * agentic tool can submit to, follow up on, and collect from, without
 * speaking a protocol or keeping a server up. `oneShot` in src/index.js is
 * the same idea with the caller inside the process, blocking on the terminal;
 * this is that same run, detached, reporting through a file instead of a
 * screen.
 *
 * The one thing this file has that src/rescueStore.js deliberately does not:
 * the ability to spawn a process. Submitting a job means starting a detached
 * one and walking away from it — that is the whole point, the submitter must
 * not wait — so it belongs in its own module, added once, deliberately, to
 * the egress allowlist test/egress.test.js enforces.
 */

/** `done` 0 · `stopped` 1 · `interrupted` 2 · `failed` 3 — `wait`'s exit code. */
export const EXIT_CODES = { done: 0, stopped: 1, interrupted: 2, failed: 3 };

/** How often a waiting caller, or a queued worker, checks the record again. */
const POLL_MS = 300;

const CLI = new URL('./index.js', import.meta.url).pathname;

const verbs = ['status', 'wait', 'result'];

/**
 * `rescue`'s own argv, one level below src/argv.js: which of the four shapes
 * — submit, status, wait, result — the words after `rescue` describe.
 *
 * Bare words, exactly like `setup` reserves its own name in src/index.js: a
 * caller who quotes the prompt (the form the README recommends, and the only
 * form the `--role` example in the issue itself uses) always lands here as
 * one word, so the common case never collides with a verb. What does collide
 * is a two-word invocation whose first word is not one of the three verbs —
 * read as an attempted `<verb> <id>` rather than a short prompt, because
 * silently running the wrong job's status check is worse than refusing. A
 * genuine two-word prompt still works; it just has to be quoted, or written
 * as three words.
 */
export function parseRescueCommand(words) {
  const rest = words.slice(1);
  if (!rest.length) {
    return { error: 'rescue needs a prompt, or one of: status <id>, wait <id>, result <id>' };
  }
  if (rest.length === 2 && !verbs.includes(rest[0])) {
    return {
      error: `unknown rescue verb: "${rest[0]}" — use status <id>, wait <id>, result <id>, `
        + 'or quote the prompt',
    };
  }
  if (verbs.includes(rest[0])) {
    if (rest.length !== 2) return { error: `rescue ${rest[0]} takes exactly one job id` };
    return { verb: rest[0], id: rest[1] };
  }
  return { verb: 'submit', prompt: rest.join(' ') };
}

/** `queued` · `running (step 7)` · `done` · `stopped` · `interrupted` · `failed`. */
function humanState(record) {
  if (record.state === 'running') return `running (step ${record.steps})`;
  return record.state;
}

/**
 * The only place this program starts a detached job. `stdio` points at a log
 * file under the rescue root rather than the parent's own streams — nobody is
 * attached to read them live, and `ignore` would throw away the one clue left
 * if the worker dies before it can write its own record (a bad argv, a
 * missing entry point) — and `unref()` is what actually lets the submitting
 * process exit while the child keeps running; without it Node holds the
 * parent open waiting on a child it was just asked to walk away from.
 */
function spawnWorker(id) {
  let stdio = 'ignore';
  try {
    mkdirSync(ROOT(), { recursive: true, mode: 0o700 });
    const fd = openSync(join(ROOT(), `${id}.log`), 'a', 0o600);
    stdio = ['ignore', fd, fd];
  } catch { /* the job still runs; only the crash-before-first-write case loses its clue */ }
  const child = spawn(process.execPath, [CLI, 'rescue', '--rescue-worker', id], {
    detached: true, stdio, cwd: process.cwd(), env: process.env,
  });
  child.unref();
}

async function submitCmd(prompt, args) {
  const role = args.role ?? 'explore';
  if (!AGENTS[role]) {
    console.error(`\n  unknown role "${role}" — use one of: ${Object.keys(AGENTS).join(', ')}\n`);
    return 2;
  }
  if (!prompt.trim()) {
    console.error('\n  rescue needs a prompt saying what to do and what to report back\n');
    return 2;
  }

  // Resolved here, the same way as #84 (src/resolve.js against
  // chatModels(await listModels())), not deferred to the worker: a caller
  // that named a model that does not exist should hear about it now, on the
  // process it is still attached to, rather than have the job quietly run on
  // something else or sit `failed` for a `wait` to discover later.
  let model = null;
  if (args.model) {
    let ids;
    try { ids = await listModels(); }
    catch (e) {
      console.error(`\n  cannot reach Kronk at ${config.baseUrl}\n  ${e.message}\n`);
      return 1;
    }
    model = resolveModel(args.model, chatModels(ids));
    if (!model) {
      console.error(`\n  no model matching "${args.model}"\n`);
      return 1;
    }
  }

  const job = createJob({
    role, prompt, model,
    yes: args.yes, auto: args.auto,
    // `JSON.stringify(Infinity)` is `null`, so the "unlimited" a bare
    // `--steps off` produces (src/argv.js) cannot ride through the record
    // file as the number it is on the way in — it needs a shape that
    // survives being written and read back as JSON.
    maxSteps: args.steps === null ? null : (Number.isFinite(args.steps) ? args.steps : 'unlimited'),
  });
  spawnWorker(job.id);

  if (args.json) console.log(JSON.stringify(toJson(job)));
  else console.log(job.id);
  return 0;
}

function statusCmd(id, args) {
  const record = readJob(id);
  if (!record) { console.error(`\n  no rescue job ${id}\n`); return 1; }
  if (args.json) console.log(JSON.stringify(toJson(record)));
  else console.log(humanState(record));
  return 0;
}

async function waitCmd(id, args) {
  let record = readJob(id);
  if (!record) { console.error(`\n  no rescue job ${id}\n`); return 1; }
  while (!TERMINAL.has(record.state)) {
    await sleep(POLL_MS);
    record = readJob(id);
    if (!record) { console.error(`\n  rescue job ${id} vanished while waiting\n`); return 1; }
  }
  collect(id);
  if (args.json) console.log(JSON.stringify(toJson(record)));
  else console.log(record.report ?? '');
  return EXIT_CODES[record.state] ?? 1;
}

/** Not one of `wait`'s four codes on purpose — this is "ask again", not a finished job's state. */
const NOT_READY = 4;

function resultCmd(id, args) {
  const record = readJob(id);
  if (!record) { console.error(`\n  no rescue job ${id}\n`); return 1; }
  if (!TERMINAL.has(record.state)) {
    console.error(`\n  rescue job ${id} is ${humanState(record)} — not finished yet; `
      + `use \`kronk-cli rescue wait ${id}\`\n`);
    return NOT_READY;
  }
  collect(id);
  if (args.json) console.log(JSON.stringify(toJson(record)));
  else console.log(record.report ?? '');
  return EXIT_CODES[record.state] ?? 1;
}

/**
 * Run one job to completion inside the detached worker process. Everything
 * below is `oneShot` in src/index.js with the terminal taken away: no
 * banner, no streamed output, no readline — the record file is the only
 * audience.
 *
 * `approve` and `grant` are the whole enforcement of the ground rule that
 * matters most here: nobody is at the prompt, so without `--yes` / `--auto`
 * on the original submit, both refuse outright. A rescue job is not a way to
 * get a command approved that nobody was ever asked about.
 */
export async function runWorker(id) {
  const job = readJob(id);
  if (!job) return;

  for (;;) {
    if (acquireLock(id)) break;
    await sleep(POLL_MS);
    if (!readJob(id)) return;   // collected-and-swept, or otherwise gone, while we waited
  }

  // A stale lock this job's own runner is recovering from, or a duplicate
  // worker started by mistake, both look the same from here: the record is
  // not `queued` any more. Either way there is nothing left for this process
  // to do.
  const fresh = readJob(id);
  if (!fresh || fresh.state !== 'queued') { releaseLock(id); return; }

  const ac = new AbortController();
  let interrupted = false;
  const onSignal = () => { interrupted = true; ac.abort(); };
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);

  let steps = 0;
  try {
    const ids = await listModels();
    const model = job.model ?? (ids.includes(DEFAULT_MODEL) ? DEFAULT_MODEL : pickDefault(ids));
    config.model = model;
    applyLimits(await modelLimits(model));
    markRunning(id, { pid: process.pid, model });

    const ctx = await projectContext(process.cwd());
    config.projectPrimer = ctx.text;

    const messages = [
      { role: 'system', content: systemFor(job.role) },
      { role: 'user', content: job.prompt },
    ];

    const approve = async () => job.yes || job.auto;
    const grant = async () => ((job.yes || job.auto) ? 'yes' : 'no');

    const done = await runTurn({
      messages,
      model,
      signal: ac.signal,
      approve,
      grant,
      mcp: null,
      auto: job.auto,
      tools: subagentTools(job.role),
      maxSteps: job.maxSteps === 'unlimited' ? Infinity : (job.maxSteps ?? config.subagentSteps),
      plan: false,
      stream: false,
      out: () => {},
      quiet: true,
      // One, not zero. `runTurn` adds `taskTools(depth)` on top of whatever
      // tool list it is given, and at depth 0 that is the `task` tool — so a
      // rescue job would be handed a tool the role it was submitted under does
      // not list, and the issue's "the same tool lists" would quietly not be
      // true. It would also let a detached job nobody is watching start
      // further runs of its own, each able to pull a different model into a
      // pool that holds one. Depth 1 is also simply what this is: a delegated
      // run, with the caller one level up and outside the process.
      depth: 1,
      onStep: (msgs, n) => { steps = n; recordStep(id, msgs, n); },
    });

    const last = [...done].reverse().find((m) => m.role === 'assistant');
    const text = String(last?.content ?? '').trim();
    // `runTurn` returns the same way whether it finished or ran out of steps,
    // so the note it pushes as the last assistant message is the only signal
    // there is. Matched on its shape rather than on one exact sentence: it
    // has two spellings already, one per depth, and a caller reading `stopped`
    // needs that state to be right far more than this needs to be clever.
    if (text.startsWith('(stopped:')) {
      // Said in terms of the job the caller submitted. `runTurn`'s own wording
      // is written for a sub-agent with someone at a terminal above it, which
      // is not who is reading this.
      const cap = job.maxSteps === 'unlimited' ? 'step cap' : `step cap of ${job.maxSteps ?? config.subagentSteps}`;
      markStopped(id, { report: `error: the job reached its ${cap} before finishing`, steps });
    } else {
      markDone(id, { report: text || 'error: the job finished without reporting anything', steps });
    }
  } catch (e) {
    if (interrupted) markInterrupted(id, { steps });
    else markFailed(id, { error: e.message, steps });
  } finally {
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGINT', onSignal);
    releaseLock(id);
  }
}

/** Dispatched from src/index.js's main() exactly where `setup` is. */
export async function runRescue(args) {
  sweep();

  if (args.rescueWorker) { await runWorker(args.rescueWorker); return 0; }

  const parsed = parseRescueCommand(args.words);
  if (parsed.error) { console.error(`\n  ${parsed.error}\n`); return 2; }

  if (parsed.verb === 'submit') return submitCmd(parsed.prompt, args);
  if (parsed.verb === 'status') return statusCmd(parsed.id, args);
  if (parsed.verb === 'wait') return waitCmd(parsed.id, args);
  return resultCmd(parsed.id, args);
}
