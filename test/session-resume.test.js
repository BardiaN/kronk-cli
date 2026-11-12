import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveSession, sessionElsewhere, unreadableSessions, dirKey } from '../src/session.js';

const fresh = () => mkdtempSync(join(tmpdir(), 'kronk-resume-'));
const rec = (id, cwd) => ({
  id, createdAt: '2026-11-11T10:00:00.000Z', updatedAt: '2026-11-11T10:00:00.000Z', cwd, model: 'm', turns: 1,
  messages: [{ role: 'user', content: 'hi' }],
});

test('an id saved under another folder is found, with that folder', () => {
  const root = fresh();
  saveSession(rec('aaa-000001', '/work/a'), { cwd: '/work/a', root });
  assert.deepEqual(sessionElsewhere('/work/b', 'aaa-000001', { root }), { id: 'aaa-000001', folder: '/work/a' });
  assert.deepEqual(sessionElsewhere('/work/b', 'aaa', { root }), { id: 'aaa-000001', folder: '/work/a' });
  assert.equal(sessionElsewhere('/work/a', 'aaa-000001', { root }), null, 'not "elsewhere" in its own folder');
  assert.equal(sessionElsewhere('/work/b', 'zzz', { root }), null);
  assert.equal(sessionElsewhere('/work/b', undefined, { root }), null);
});

test('an ambiguous prefix across folders is not guessed', () => {
  const root = fresh();
  saveSession(rec('aaa-000001', '/x'), { cwd: '/x', root });
  saveSession(rec('aab-000002', '/y'), { cwd: '/y', root });
  assert.equal(sessionElsewhere('/z', 'aa', { root }), null);
});

test('corrupt and wrong-shaped session files are listed, good ones are not', () => {
  const root = fresh();
  saveSession(rec('aaa-000001', '/p'), { cwd: '/p', root });
  const dir = join(root, dirKey('/p'));
  writeFileSync(join(dir, 'bbb-000002.json'), '{ not json');
  writeFileSync(join(dir, 'ccc-000003.json'), '{"id":"ccc-000003"}');
  mkdirSync(join(root, dirKey('/empty')), { recursive: true });
  assert.deepEqual(unreadableSessions('/p', { root }).map((f) => f.split('/').pop()).sort(), ['bbb-000002.json', 'ccc-000003.json']);
  assert.deepEqual(unreadableSessions('/empty', { root }), []);
  assert.deepEqual(unreadableSessions('/none', { root }), []);
});
