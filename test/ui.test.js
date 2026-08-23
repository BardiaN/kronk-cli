import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtContext, fmtUsage, statusLine, toolResultLines } from '../src/ui.js';

// eslint-disable-next-line no-control-regex -- stripping ANSI is the point
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

test('context meter shows fraction, percent and a ten-cell bar', () => {
  const out = strip(fmtContext(13107, 131072));
  assert.match(out, /13k\/131k 10%/);
  assert.equal((out.match(/[▓░]/g) ?? []).length, 10);
});

test('an empty or unknown window renders nothing', () => {
  assert.equal(fmtContext(0, 131072), '');
  assert.equal(fmtContext(100, null), '');
});

test('a full window fills the bar', () => {
  assert.match(strip(fmtContext(131072, 131072)), /100% ▓{10}/);
});

test('usage line carries throughput and cache hits', () => {
  const out = strip(fmtUsage({
    prompt_tokens: 100, completion_tokens: 20, tokens_per_second: 78.4,
    time_to_first_token_ms: 233, prompt_tokens_details: { cached_tokens: 90 },
    completion_tokens_details: { reasoning_tokens: 5 },
  }, 131072));
  assert.match(out, /100→20 tok/);
  assert.match(out, /78\.4 tok\/s/);
  assert.match(out, /ttft 233ms/);
  assert.match(out, /90 cached/);
  assert.match(out, /5 thinking/);
});

test('usage line is empty without usage', () => {
  assert.equal(fmtUsage(null, 131072), '');
});

test('status line shows only what is active', () => {
  const quiet = strip(statusLine({
    model: 'unsloth/Model-Q4/AGENT', auto: false, yes: false, noThink: false,
    mcp: null, steps: Infinity, used: 0, window: 131072,
  }));
  assert.equal(quiet, '⏵ AGENT');

  const loud = strip(statusLine({
    model: 'unsloth/Model-Q4/AGENT', auto: true, yes: true, noThink: true,
    noPreserve: true, mcp: 'nx,kronk', steps: 50, used: 22000, window: 131072,
  }));
  assert.match(loud, /auto/);
  assert.match(loud, /no-think/);
  assert.match(loud, /no-preserve/);
  assert.match(loud, /mcp nx,kronk/);
  assert.match(loud, /steps 50/);
  assert.match(loud, /22k\/131k 17%/);
});

test('an unlimited step budget is not advertised', () => {
  const out = strip(statusLine({
    model: 'm', auto: false, yes: false, noThink: false,
    mcp: null, steps: Infinity, used: 0, window: 0,
  }));
  assert.ok(!out.includes('steps'));
});

test('a single-line error result is exactly one entry', () => {
  const lines = toolResultLines('error: exit code 128 after 0.0s').map(strip);
  assert.deepEqual(lines, ['  ✗ error: exit code 128 after 0.0s']);
});

test('a four-line error keeps every line, the rest indented four spaces', () => {
  const result = ['error: boom', 'cwd: /x', 'stderr:', 'fatal: not a git repository'].join('\n');
  const lines = toolResultLines(result).map(strip);
  assert.equal(lines.length, 4);
  assert.equal(lines[0], '  ✗ error: boom');
  assert.equal(lines[1], '    cwd: /x');
  assert.equal(lines[2], '    stderr:');
  assert.equal(lines[3], '    fatal: not a git repository');
});

test('a thirty-line error caps at 22 entries with the model-received note', () => {
  const result = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
  const lines = toolResultLines(result).map(strip);
  assert.equal(lines.length, 22);
  assert.equal(lines[0], '  ✗ line 0');
  assert.equal(lines[21], '    …9 more lines (the model received all of it)');
});

test('exactly 21 lines shows all 21 and no summary', () => {
  const result = Array.from({ length: 21 }, (_, i) => `line ${i}`).join('\n');
  const lines = toolResultLines(result).map(strip);
  assert.equal(lines.length, 21);
  assert.ok(!lines.some((l) => l.includes('more line')));
});

test('22 lines suppresses exactly one, singular', () => {
  const result = Array.from({ length: 22 }, (_, i) => `line ${i}`).join('\n');
  const lines = toolResultLines(result).map(strip);
  assert.equal(lines.length, 22);
  assert.equal(lines[21], '    …1 more line (the model received all of it)');
});

test('a 500-char line at position 2 is cut to 201 chars after the indent', () => {
  const long = 'x'.repeat(500);
  const result = `error: boom\n${long}`;
  const lines = toolResultLines(result).map(strip);
  const body = lines[1].slice(4); // drop the four-space indent
  assert.equal(body.length, 201);
  assert.equal(body, `${'x'.repeat(200)}…`);
});

test('a 500-char first line is never truncated', () => {
  const long = `error: ${'x'.repeat(500)}`;
  const lines = toolResultLines(long).map(strip);
  assert.equal(lines.length, 1);
  assert.equal(lines[0], `  ✗ ${long}`);
});

test('maxLines and maxWidth are honoured when passed explicitly', () => {
  const result = Array.from({ length: 5 }, (_, i) => `line ${i}`).join('\n');
  const lines = toolResultLines(result, { maxLines: 2, maxWidth: 3 }).map(strip);
  // first + 2 shown + summary
  assert.equal(lines.length, 4);
  assert.equal(lines[1], '    lin…');
  assert.equal(lines[3], '    …2 more lines (the model received all of it)');
});
