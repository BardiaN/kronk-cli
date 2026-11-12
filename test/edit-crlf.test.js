import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEdit } from '../src/tools.js';

test('applyEdit matches an LF old_string against a CRLF file and keeps CRLF', () => {
  const r = applyEdit('one\r\ntwo\r\nthree\r\n', 'one\ntwo', 'uno\ndos\ntres');
  assert.deepEqual(r, { text: 'uno\r\ndos\r\ntres\r\nthree\r\n', count: 1 });
});

test('applyEdit on one line of a CRLF file writes new lines with CRLF', () => {
  assert.equal(applyEdit('a\r\nb\r\n', 'a', 'a\nA').text, 'a\r\nA\r\nb\r\n');
});

test('applyEdit leaves the endings of untouched lines alone in a mixed file', () => {
  assert.equal(applyEdit('x\ny\r\nz\nw\r\n', 'y\nz', 'Y\nZ').text, 'x\nY\r\nZ\nw\r\n');
});

test('applyEdit on a CRLF file still reports misses and ambiguity, and keeps $ literal', () => {
  assert.match(applyEdit('a\r\nb\r\n', 'c\nd', 'x').error, /0 matches/);
  assert.match(applyEdit('a\r\na\r\n', 'a', 'x').error, /2 places/);
  assert.equal(applyEdit('a.b\r\n', 'a.b', '$&').text, '$&\r\n');
});
