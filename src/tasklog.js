import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { config } from './config.js';
import { c, elapsed } from './ui.js';

/**
 * Sub-agent transcripts: the one part of a session you could not go back to.
 *
 * src/subagent.js is built on throwing context away, and it should be — a
 * survey that reads thirty files costs the conversation one report instead of
 * thirty files. But "the caller's window must not hold it" and "the user may
 * never see it" are two different claims, and the code used to make both:
 * `runTask` took the last assistant message and let the rest go out of scope.
 *
 * So the transcript goes to a file instead of the window. Nothing here is ever
 * read back into a conversation on its own — `/tasks` prints, it does not
 * re-inject — which is what keeps the context economy intact. The user gets to
 * look; the model still pays one report.
 *
 * Temp, not $HOME. These are disposable by construction: a transcript is
 * interesting for as long as you are still wondering what that sub-agent did,
 * which is the session it ran in and maybe the morning after. Somewhere that
 * gets swept is the honest place for that, and it needs no new dotfile.
 */

/** Everything this module writes lives under one directory, so cleanup is one call. */
const ROOT = () => config.taskLogDir ?? join(tmpdir(), 'kronk-cli');

/**
 * One directory per session, named so two sessions cannot collide and a stale
 * one can be aged out by its own timestamp rather than by stat'ing it.
 */
const SESSION = `${Date.now().toString(36)}-${process.pid}`;

/** Sessions older than this are swept at startup. */
const KEEP_MS = 24 * 60 * 60 * 1000;

/**
 * Runs kept per session.
 *
 * An autonomous run that delegates forty times should not quietly fill the
 * temp dir with forty 40-step transcripts. The oldest go first: the run you
 * want to read is almost always a recent one, and the alternative — refusing
 * to write past the cap — loses exactly the transcripts most likely to matter.
 */
const MAX_RUNS = 50;

let counter = 0;

/** Where this session's transcripts go. Created on first write, not at import. */
export const sessionDir = () => join(ROOT(), SESSION);

const file = (n) => join(sessionDir(), `task-${String(n).padStart(3, '0')}.json`);

/**
 * 0700 and 0600 throughout.
 *
 * A transcript holds file contents and command output from the user's project,
 * which is the same material `~/.kronk-cli.json` guards, in a directory that on
 * a shared machine is world-readable by default.
 */
function ensureDir() {
  mkdirSync(sessionDir(), { recursive: true, mode: 0o700 });
}

/** Drop the oldest transcripts once the cap is exceeded. */
function trim() {
  const files = readdirSync(sessionDir()).filter((f) => /^task-\d+\.json$/.test(f)).sort();
  for (const f of files.slice(0, Math.max(0, files.length - MAX_RUNS))) {
    try { rmSync(join(sessionDir(), f)); } catch { /* already gone */ }
  }
}

/**
 * A run in progress.
 *
 * `step` is called as the sub-agent works and rewrites the whole record, which
 * is the point: a run that is interrupted, that throws, or that hits its step
 * cap is exactly the run whose transcript is worth having, and it never reaches
 * a tidy end at which to write one. Rewriting a small JSON file a few dozen
 * times costs nothing next to the model call that produced each step.
 */
class Run {
  constructor(n, meta) {
    this.n = n;
    this.path = file(n);
    this.record = { n, ...meta, startedAt: new Date().toISOString(), endedAt: null, state: 'running', steps: 0, messages: [], report: null };
  }

  /** Never throw into the sub-agent: a full disk must not fail a delegated task. */
  #flush() {
    try {
      ensureDir();
      writeFileSync(this.path, `${JSON.stringify(this.record, null, 2)}\n`, { mode: 0o600 });
    } catch { /* the transcript is a convenience, not the work */ }
  }

  step(messages, steps) {
    this.record.messages = messages;
    this.record.steps = steps;
    this.#flush();
  }

  finish({ report, steps }) {
    this.record.endedAt = new Date().toISOString();
    // No report means the run threw or was interrupted: runTask closes the
    // record from a `finally`, so this is the only signal that it did not end
    // on its own terms.
    this.record.state = report === undefined ? 'stopped' : 'done';
    if (report !== undefined) this.record.report = report;
    if (steps !== undefined) this.record.steps = steps;
    this.#flush();
    try { trim(); } catch { /* nothing worth reporting */ }
    return this.path;
  }
}

/**
 * Begin recording one delegated task, or don't.
 *
 * Returns null when logging is off, and every caller is written to treat that
 * as ordinary rather than as an error — the feature switching off should not
 * put a branch in the middle of the delegation path.
 */
export function startRun(meta) {
  if (!config.taskLog) return null;
  counter += 1;
  const run = new Run(counter, meta);
  run.step([], 0);
  return run;
}

/** Every run this session recorded, oldest first. Summaries only — not the messages. */
export function listRuns() {
  let names;
  try { names = readdirSync(sessionDir()); } catch { return []; }
  return names.filter((f) => /^task-\d+\.json$/.test(f)).sort()
    .map((f) => {
      try {
        const r = JSON.parse(readFileSync(join(sessionDir(), f), 'utf8'));
        return {
          n: r.n,
          agent: r.agent,
          prompt: r.prompt ?? '',
          model: r.model ?? null,
          steps: r.steps ?? 0,
          ms: r.endedAt ? Date.parse(r.endedAt) - Date.parse(r.startedAt) : null,
          state: r.state ?? (r.endedAt ? 'done' : 'running'),
          path: join(sessionDir(), f),
        };
      } catch { return null; }   // a half-written file is not a crash
    })
    .filter(Boolean);
}

/** One run in full, or null if there is no such run. */
export function readRun(n) {
  try { return JSON.parse(readFileSync(file(n), 'utf8')); }
  catch { return null; }
}

/**
 * Remove this session's transcripts, and any session that has aged out.
 *
 * Called at startup rather than only at exit, because the transcripts worth
 * sweeping are precisely the ones a crash left behind — the exit path that
 * would have cleaned them is the path that did not run.
 */
export function sweep({ all = false } = {}) {
  const root = ROOT();
  let dirs;
  try { dirs = readdirSync(root); } catch { return 0; }
  let removed = 0;
  for (const d of dirs) {
    const full = join(root, d);
    if (!all) {
      if (d === SESSION) continue;
      try { if (Date.now() - statSync(full).mtimeMs < KEEP_MS) continue; } catch { continue; }
    }
    try { rmSync(full, { recursive: true, force: true }); removed += 1; } catch { /* in use */ }
  }
  return removed;
}

/** Drop this session's own directory on a clean exit. */
export function cleanup() {
  try { rmSync(sessionDir(), { recursive: true, force: true }); } catch { /* nothing to do */ }
}

/** `4.2s`, or an em dash for a run with no end time yet. */
const took = (ms) => (ms === null ? '\u2014' : elapsed(ms));

const gist = (prompt, width) => {
  const first = String(prompt).split('\n')[0].trim();
  return first.length > width ? `${first.slice(0, width - 1)}\u2026` : first;
};

/**
 * `/tasks` — one line per run this session.
 *
 * Numbered, because the number is how the next command names one. A run that
 * never finished says so rather than reporting a duration it does not have:
 * "still running" and "died three steps in" are the two states where the
 * transcript is worth the most, and both would otherwise render as a blank.
 */
export function runLines() {
  if (!config.taskLog) {
    return [c.grey('  transcripts are off \u2014 drop KRONK_TASK_LOG=false')];
  }
  const runs = listRuns();
  if (!runs.length) {
    return [c.grey('  no sub-agent runs yet \u2014 the model starts one with the task tool')];
  }
  const lines = runs.map((r) => {
    const how = { done: took(r.ms), stopped: 'stopped', running: 'running' }[r.state] ?? took(r.ms);
    const state = `${r.steps} step${r.steps === 1 ? '' : 's'} \u00b7 ${how}`.padEnd(20);
    const dot = { done: c.green('\u25cf'), stopped: c.yellow('\u25cf'), running: c.blue('\u25cf') }[r.state] ?? c.grey('\u25cf');
    return `  ${dot} ${c.bold(String(r.n).padStart(2))}  ${r.agent.padEnd(7)} ${c.grey(state)} ${c.grey(gist(r.prompt, 44))}`;
  });
  lines.push(c.grey(`\n  /tasks <n> for one in full \u00b7 ${sessionDir()}`));
  return lines;
}

/**
 * `/tasks <n>` — one run, whole.
 *
 * Nothing is cut here, and that is the point: the bounded report on screen is
 * what sent the user looking, so a second ceiling would only move the wall.
 * This is printed, never pushed back into the conversation — looking at what a
 * sub-agent did must not cost the window the delegation just saved.
 */
export function transcriptLines(n) {
  const r = readRun(n);
  if (!r) return [c.red(`  no run ${n} \u2014 /tasks to list them`)];

  const ms = r.endedAt ? Date.parse(r.endedAt) - Date.parse(r.startedAt) : null;
  const out = [
    '',
    `  ${c.bold(`task ${r.n}`)} ${c.grey(`\u00b7 ${r.agent} \u00b7 ${r.model ?? 'session model'} \u00b7 ${r.steps} step${r.steps === 1 ? '' : 's'} \u00b7 ${took(ms)}${r.state === 'done' ? '' : ` \u00b7 ${r.state}`}`)}`,
    '',
    c.grey('  \u2500\u2500 prompt \u2500\u2500'),
    ...String(r.prompt ?? '').split('\n').map((l) => `  ${l}`),
  ];

  // The system prompt is the contract in src/subagent.js and the same every
  // time; the user message is the prompt already printed above.
  const body = (r.messages ?? []).slice(2);
  // The last assistant message *is* the report — `reportFrom` takes it. It gets
  // its own heading below, so printing it here too would only be twice.
  if (r.report != null && body.at(-1)?.role === 'assistant') body.pop();

  for (const m of body) {
    if (m.role === 'assistant') {
      for (const t of m.tool_calls ?? []) {
        out.push('', `  ${c.blue(`\u2699 ${t.function?.name}`)} ${c.grey(t.function?.arguments ?? '')}`);
      }
      const text = String(m.content ?? '').trim();
      if (text && !(m.tool_calls ?? []).length) {
        out.push('', ...text.split('\n').map((l) => `  ${l}`));
      }
    } else if (m.role === 'tool') {
      out.push(...String(m.content ?? '').split('\n').map((l) => c.grey(`  \u2502 ${l}`)));
    }
  }

  if (r.report != null) {
    out.push('', c.grey('  \u2500\u2500 report \u2500\u2500'), ...String(r.report).split('\n').map((l) => `  ${l}`));
  } else if (r.state === 'stopped') {
    out.push('', c.yellow('  \u2500\u2500 stopped before it reported \u2500\u2500'));
  }
  out.push('', c.grey(`  ${join(sessionDir(), `task-${String(r.n).padStart(3, '0')}.json`)}`));
  return out;
}
