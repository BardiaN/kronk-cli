import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keyLines } from '../src/distill.js';

const noisy = [
  ...Array.from({ length: 400 }, (_, i) => `[${i + 1}/400] Building @acme/module-${i} ... transpiling`),
  "ERROR: src/api/handlers.ts:142:11 - TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
  'ERROR: src/api/handlers.ts:207:3 - TS2554: Expected 2 arguments, but got 1.',
  'Tests: 14 failed, 203 passed, 217 total',
].join('\n');

test('finds the needles in 400 lines of build chatter', () => {
  const hits = keyLines(noisy);
  assert.equal(hits.length, 3, `expected 3 signal lines, got ${hits.length}`);
  assert.ok(hits.some((l) => l.includes('TS2345')));
  assert.ok(hits.some((l) => l.includes('TS2554')));
  assert.ok(hits.some((l) => l.includes('14 failed')));
});

test('keeps error text byte-for-byte', () => {
  const [first] = keyLines(noisy);
  assert.ok(first.includes("Argument of type 'string' is not assignable to parameter of type 'number'."));
});

test('reports nothing for clean output', () => {
  assert.deepEqual(keyLines('built 3 packages\nall good\ndone in 4s'), []);
});

test('de-duplicates identical repeated errors', () => {
  const repeated = Array.from({ length: 50 }, () => 'ERROR: connection refused').join('\n');
  assert.equal(keyLines(repeated).length, 1);
});

test('caps runaway matches and says so', () => {
  const many = Array.from({ length: 500 }, (_, i) => `ERROR: failure number ${i}`).join('\n');
  const hits = keyLines(many, 10);
  assert.equal(hits.length, 11);
  assert.match(hits.at(-1), /more matches suppressed/);
});

test('truncates a single enormous line', () => {
  const hits = keyLines(`ERROR: ${'y'.repeat(2000)}`);
  assert.ok(hits[0].length <= 510);
  assert.ok(hits[0].endsWith('…'));
});

test('skips progress-bar noise that happens to contain a keyword', () => {
  assert.deepEqual(keyLines('[12/40] \n  50%\n⠹ working'), []);
});

test('recognises varied failure vocabularies', () => {
  for (const line of [
    'Traceback (most recent call last):',
    'panic: runtime error: index out of range',
    'FATAL: could not connect',
    'Error: ENOENT: no such file or directory',
    'AssertionError: expected 1 to equal 2',
    'npm ERR! code ECONNREFUSED',
    'exit code 1',
  ]) {
    assert.equal(keyLines(line).length, 1, `missed: ${line}`);
  }
});
