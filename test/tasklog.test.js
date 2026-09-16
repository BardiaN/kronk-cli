import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { config } from '../src/config.js';
import {
  startRun, listRuns, readRun, sessionDir, sweep, cleanup, runLines, transcriptLines,
} from '../src/tasklog.js';

// Never the real temp dir: these tests write, sweep and delete whole trees.
config.taskLogDir = mkdtempSync(join(tmpdir(), 'kronk-tasklog-'));
config.taskLog = true;

const files = () => readdirSync(sessionDir()).filter((f) => f.endsWith('.json')).sort();
const mode = (p) => statSync(p).mode & 0o777;

test('a run is on disk before it has done anything', () => {
  const run = startRun({ agent: 'explore', prompt: 'find the SSE parser', model: 'small' });
  const saved = JSON.parse(readFileSync(run.path, 'utf8'));
  assert.equal(saved.agent, 'explore');
  assert.equal(saved.prompt, 'find the SSE parser');
  assert.equal(saved.steps, 0);
  assert.equal(saved.state, 'running', 'and it says so');
});

test('each step rewrites the record, so a run that never finishes still has one', () => {
  const run = startRun({ agent: 'code', prompt: 'reproduce the failure', model: 'small' });
  run.step([{ role: 'system', content: 'c' }, { role: 'user', content: 'p' }], 1);
  run.step([{ role: 'system', content: 'c' }, { role: 'user', content: 'p' },
    { role: 'assistant', content: 'half way' }], 2);

  // No finish() — this is the interrupted case, which is the one worth having.
  const saved = readRun(run.n);
  assert.equal(saved.steps, 2);
  assert.equal(saved.messages.length, 3);
  assert.equal(saved.state, 'running');
  assert.equal(saved.report, null);
});

test('finishing records the report, the step count and an end time', () => {
  const run = startRun({ agent: 'explore', prompt: 'look', model: 'small' });
  const path = run.finish({ report: 'it is in src/sse.js:12', steps: 6 });
  assert.equal(path, run.path);
  const saved = readRun(run.n);
  assert.equal(saved.report, 'it is in src/sse.js:12');
  assert.equal(saved.steps, 6);
  assert.equal(saved.state, 'done');
  assert.ok(Date.parse(saved.endedAt) >= Date.parse(saved.startedAt));
});

test('the directory and every file in it are the user’s alone', () => {
  const run = startRun({ agent: 'explore', prompt: 'look', model: 'small' });
  assert.equal(mode(sessionDir()), 0o700, 'a transcript holds the project’s file contents');
  assert.equal(mode(run.path), 0o600);
});

test('with logging off nothing is written at all', () => {
  const before = files().length;
  config.taskLog = false;
  assert.equal(startRun({ agent: 'explore', prompt: 'look' }), null, 'callers treat null as ordinary');
  config.taskLog = true;
  assert.equal(files().length, before, 'not one more file');
});

test('past the cap the oldest go, not the newest', () => {
  for (let i = 0; i < 60; i += 1) {
    startRun({ agent: 'explore', prompt: `run ${i}`, model: 'small' }).finish({ report: 'r', steps: 1 });
  }
  const kept = files();
  assert.equal(kept.length, 50, 'a forty-step autonomous run does not fill the temp dir');
  const runs = listRuns();
  assert.equal(runs.at(-1).prompt, 'run 59', 'the newest survived');
  assert.ok(runs.every((r) => r.prompt !== 'run 0'), 'the oldest did not');
});

test('a half-written file is skipped, not a crash', () => {
  // 0600 like the real thing writes: a predictable name under the temp dir with
  // default permissions is the pattern CodeQL's js/insecure-temporary-file is
  // about, and a fixture that stands in for a transcript should hold the same
  // line the module it stands in for does.
  writeFileSync(join(sessionDir(), 'task-999.json'), '{"n": 999, "agent": "expl', { mode: 0o600 });
  const runs = listRuns();
  assert.ok(Array.isArray(runs));
  assert.ok(runs.every((r) => r.n !== 999));
});

test('sweeping removes sessions that have aged out and leaves this one alone', () => {
  const stale = join(config.taskLogDir, 'k5abcd-999');
  mkdirSync(stale, { recursive: true });
  const old = Date.now() / 1000 - 3 * 24 * 60 * 60;
  utimesSync(stale, old, old);

  const fresh = join(config.taskLogDir, 'k5efgh-998');
  mkdirSync(fresh, { recursive: true });

  assert.equal(sweep(), 1, 'only the aged-out one');
  assert.ok(readdirSync(config.taskLogDir).includes('k5efgh-998'));
  assert.ok(files().length, 'and never this session’s own');
});

test('/tasks lists what ran, and says where to look for the rest', () => {
  const lines = runLines().join('\n');
  assert.match(lines, /explore/);
  assert.match(lines, /run 59/);
  assert.match(lines, /\/tasks <n>/);
  assert.match(lines, new RegExp(sessionDir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('/tasks says so when transcripts are off rather than looking empty', () => {
  config.taskLog = false;
  assert.match(runLines().join('\n'), /transcripts are off/);
  config.taskLog = true;
});

test('/tasks <n> prints the whole run, uncut', () => {
  const run = startRun({ agent: 'code', prompt: 'reproduce it', model: 'small' });
  const body = Array.from({ length: 80 }, (_, i) => `result line ${i + 1}`).join('\n');
  run.step([
    { role: 'system', content: 'contract' },
    { role: 'user', content: 'reproduce it' },
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'bash', arguments: '{"cmd":"npm test"}' } }] },
    { role: 'tool', content: body },
  ], 1);
  run.finish({ report: 'it fails on line 12', steps: 1 });

  const out = transcriptLines(run.n).join('\n');
  assert.match(out, /reproduce it/, 'the prompt');
  assert.match(out, /bash/, 'the call');
  assert.match(out, /npm test/, 'its arguments');
  assert.match(out, /result line 80/, 'and every line of the result — a second ceiling would only move the wall');
  assert.match(out, /it fails on line 12/, 'the report');
});

test('/tasks <n> for a run that does not exist says so', () => {
  assert.match(transcriptLines(9999).join('\n'), /no run 9999/);
});

test('a clean exit takes this session’s transcripts with it', () => {
  assert.ok(files().length);
  cleanup();
  assert.throws(() => readdirSync(sessionDir()));
});

test('a run that stopped before reporting is not listed as if it finished', () => {
  const run = startRun({ agent: 'code', prompt: 'reproduce it', model: 'small' });
  run.step([{ role: 'system', content: 'c' }, { role: 'user', content: 'p' }], 1);
  run.finish({ steps: 1 });          // no report: runTask closes from a `finally`

  const saved = readRun(run.n);
  assert.equal(saved.state, 'stopped');
  assert.equal(saved.report, null);
  assert.match(runLines().join('\n'), /stopped/);
  assert.match(transcriptLines(run.n).join('\n'), /stopped before it reported/);
});

test('the report is printed once, under its own heading', () => {
  const run = startRun({ agent: 'explore', prompt: 'look', model: 'small' });
  run.step([
    { role: 'system', content: 'c' },
    { role: 'user', content: 'look' },
    { role: 'assistant', content: 'it is at src/sse.js:12' },
  ], 1);
  run.finish({ report: 'it is at src/sse.js:12', steps: 1 });

  const out = transcriptLines(run.n).join('\n');
  assert.equal(out.split('it is at src/sse.js:12').length - 1, 1, 'the last assistant message is the report');
  assert.match(out, /── report ──/);
});
