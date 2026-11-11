import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planBatches, runConcurrently, READ_ONLY } from '../src/batch.js';

const ro = (c) => READ_ONLY.has(c.name);
const mk = (...names) => names.map((name, id) => ({ name, id }));
const names = (bs) => bs.map((b) => b.map((c) => c.name));

test('consecutive read-only calls share a batch', () => {
  assert.deepEqual(names(planBatches(mk('read_file', 'list_dir', 'search'), ro)),
    [['read_file', 'list_dir', 'search']]);
});

test('gated calls are barriers that run alone and in order', () => {
  const bs = planBatches(mk('read_file', 'search', 'bash', 'read_file', 'write_file', 'list_dir', 'list_dir'), ro);
  assert.deepEqual(names(bs),
    [['read_file', 'search'], ['bash'], ['read_file'], ['write_file'], ['list_dir', 'list_dir']]);
});

test('a run is split at the cap and the original order survives', () => {
  const calls = mk(...Array(9).fill('read_file'));
  const bs = planBatches(calls, ro, 4);
  assert.deepEqual(bs.map((b) => b.length), [4, 4, 1]);
  assert.deepEqual(bs.flat(), calls);
});

test('no calls, no batches', () => {
  assert.deepEqual(planBatches([], ro), []);
});

test('results keep call order whatever order the tools finish in', async () => {
  const finished = [];
  const out = await runConcurrently([40, 5, 20], async (d) => {
    await new Promise((r) => setTimeout(r, d));
    finished.push(d);
    return `r${d}`;
  });
  assert.deepEqual(finished, [5, 20, 40]);
  assert.deepEqual(out, ['r40', 'r5', 'r20']);
});
