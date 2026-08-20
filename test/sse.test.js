import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSseParser, accumulateToolCalls } from '../src/sse.js';

test('parses complete events', () => {
  const p = createSseParser();
  assert.deepEqual(p.push('data: {"a":1}\ndata: {"b":2}\n'), ['{"a":1}', '{"b":2}']);
});

test('survives a chunk boundary mid-line', () => {
  const p = createSseParser();
  assert.deepEqual(p.push('data: {"a":'), []);      // incomplete, nothing yet
  assert.deepEqual(p.push('1}\n'), ['{"a":1}']);    // completed by the next read
});

test('splits a boundary inside the "data: " prefix itself', () => {
  const p = createSseParser();
  assert.deepEqual(p.push('dat'), []);
  assert.deepEqual(p.push('a: {"x":true}\n'), ['{"x":true}']);
});

test('ignores blank lines and non-data fields', () => {
  const p = createSseParser();
  assert.deepEqual(p.push('event: message_stop\n\ndata: {"z":0}\n'), ['{"z":0}']);
});

test('passes [DONE] through for the caller to handle', () => {
  const p = createSseParser();
  assert.deepEqual(p.push('data: [DONE]\n'), ['[DONE]']);
});

test('flush returns a trailing event with no newline', () => {
  const p = createSseParser();
  p.push('data: {"a":1}');
  assert.deepEqual(p.flush(), ['{"a":1}']);
  assert.deepEqual(p.flush(), []);
});

test('accumulates tool call arguments across deltas', () => {
  const calls = new Map();
  accumulateToolCalls(calls, [{ id: 'c1', index: 0, function: { name: 'read_file', arguments: '' } }]);
  accumulateToolCalls(calls, [{ index: 0, function: { arguments: '{"path":' } }]);
  accumulateToolCalls(calls, [{ index: 0, function: { arguments: '"a.txt"}' } }]);
  assert.deepEqual([...calls.values()], [{ id: 'c1', name: 'read_file', args: '{"path":"a.txt"}' }]);
});

test('keeps parallel tool calls apart by index', () => {
  const calls = new Map();
  accumulateToolCalls(calls, [
    { id: 'a', index: 0, function: { name: 'one', arguments: '{"x":' } },
    { id: 'b', index: 1, function: { name: 'two', arguments: '{"y":' } },
  ]);
  accumulateToolCalls(calls, [
    { index: 1, function: { arguments: '2}' } },
    { index: 0, function: { arguments: '1}' } },
  ]);
  assert.equal(calls.get(0).args, '{"x":1}');
  assert.equal(calls.get(1).args, '{"y":2}');
});

test('tolerates a delta with no index', () => {
  const calls = new Map();
  accumulateToolCalls(calls, [{ id: 'x', function: { name: 'bash', arguments: '{}' } }]);
  assert.equal(calls.get(0).name, 'bash');
});

test('a missing tool_calls field is a no-op', () => {
  assert.equal(accumulateToolCalls(new Map(), undefined).size, 0);
});
