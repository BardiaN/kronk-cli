import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmtContext, fmtUsage, statusLine } from '../src/ui.js';

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
    mcp: 'nx,kronk', steps: 50, used: 22000, window: 131072,
  }));
  assert.match(loud, /auto/);
  assert.match(loud, /no-think/);
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
