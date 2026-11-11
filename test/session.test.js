import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync, mkdirSync, chmodSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  newSessionId, isSessionId, dirKey, countTurns, hasConversation, storable, restoreMessages,
  saveSession, trySave, listSessions, findSession, prune, summary, firstPrompt, listLines, KEEP,
} from '../src/session.js';
import { parseArgv } from '../src/argv.js';

const posix = typeof process.getuid === 'function';
const fresh = () => mkdtempSync(join(tmpdir(), 'kronk-session-'));
const SYS = { role: 'system', content: 'be helpful' };

function record(id, over = {}) {
  return {
    id, createdAt: '2026-11-11T10:00:00.000Z', updatedAt: '2026-11-11T10:00:00.000Z',
    model: 'm1', turns: 1,
    messages: [{ role: 'user', content: 'hello there' }, { role: 'assistant', content: 'hi' }],
    ...over,
  };
}

test('ids have the shape the argv parser and the store both expect', () => {
  assert.ok(isSessionId(newSessionId()));
  assert.ok(!isSessionId('../etc/passwd'));
  assert.ok(!isSessionId(undefined));
});

test('the directory key is stable, distinct per directory, and path-free', () => {
  assert.equal(dirKey('/a/b'), dirKey('/a/b'));
  assert.notEqual(dirKey('/a/b'), dirKey('/a/c'));
  assert.match(dirKey('/a/b'), /^[0-9a-f]{16}$/);
});

test('turns count user messages only; the system message is never stored', () => {
  const msgs = [SYS, { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'c' }];
  assert.equal(countTurns(msgs), 2);
  assert.equal(hasConversation([SYS]), false);
  assert.deepEqual(storable(msgs).map((m) => m.role), ['user', 'assistant', 'user']);
});

test('restoring keeps the current system message and drops any saved one', () => {
  const current = [{ role: 'system', content: 'fresh primer' }];
  const saved = [{ role: 'system', content: 'injected' }, { role: 'user', content: 'a' }, null, { content: 'no role' }];
  const out = restoreMessages(current, saved);
  assert.deepEqual(out, [current[0], { role: 'user', content: 'a' }]);
});

test('a saved session round-trips and the file is private', () => {
  const root = fresh();
  const file = saveSession(record('aaa-000001'), { cwd: '/proj', root });
  const [back] = listSessions('/proj', { root });
  assert.equal(back.id, 'aaa-000001');
  assert.deepEqual(back.messages, record('aaa-000001').messages);
  if (posix) {
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(join(root, dirKey('/proj'))).mode & 0o777, 0o700);
  }
});

test('the write is atomic: no temp file is left behind, and a rewrite replaces the record', () => {
  const root = fresh();
  saveSession(record('aaa-000001'), { cwd: '/proj', root });
  saveSession(record('aaa-000001', { turns: 2 }), { cwd: '/proj', root });
  const names = readdirSync(join(root, dirKey('/proj')));
  assert.deepEqual(names, ['aaa-000001.json']);
  assert.equal(listSessions('/proj', { root })[0].turns, 2);
});

test('sessions are kept per launch directory', () => {
  const root = fresh();
  saveSession(record('aaa-000001'), { cwd: '/one', root });
  saveSession(record('bbb-000002'), { cwd: '/two', root });
  assert.deepEqual(listSessions('/one', { root }).map((s) => s.id), ['aaa-000001']);
  assert.deepEqual(listSessions('/two', { root }).map((s) => s.id), ['bbb-000002']);
  assert.deepEqual(listSessions('/none', { root }), []);
});

test('listing is newest first, and findSession defaults to the newest', () => {
  const root = fresh();
  saveSession(record('aaa-000001', { updatedAt: '2026-11-10T10:00:00.000Z' }), { cwd: '/p', root });
  saveSession(record('bbb-000002', { updatedAt: '2026-11-11T10:00:00.000Z' }), { cwd: '/p', root });
  assert.deepEqual(listSessions('/p', { root }).map((s) => s.id), ['bbb-000002', 'aaa-000001']);
  assert.equal(findSession('/p', undefined, { root }).id, 'bbb-000002');
  assert.equal(findSession('/p', 'aaa-000001', { root }).id, 'aaa-000001');
  assert.equal(findSession('/p', 'aaa', { root }).id, 'aaa-000001');
  assert.equal(findSession('/p', 'zzz', { root }), null);
});

test('an ambiguous prefix finds nothing rather than guessing', () => {
  const root = fresh();
  saveSession(record('abc-000001'), { cwd: '/p', root });
  saveSession(record('abd-000002'), { cwd: '/p', root });
  assert.equal(findSession('/p', 'ab', { root }), null);
});

test('only the newest KEEP sessions per directory survive', () => {
  assert.equal(KEEP, 20);
  const root = fresh();
  const dir = join(root, dirKey('/p'));
  for (let i = 0; i < 5; i += 1) {
    const id = `s${i}-00000${i}`;
    saveSession(record(id), { cwd: '/p', root, keep: 100 });
    const t = new Date(Date.now() - (5 - i) * 60_000);
    utimesSync(join(dir, `${id}.json`), t, t);
  }
  assert.equal(prune('/p', { root, keep: 3 }), 2);
  assert.deepEqual(readdirSync(dir).sort(), ['s2-000002.json', 's3-000003.json', 's4-000004.json']);
});

test('saving prunes on its own', () => {
  const root = fresh();
  for (let i = 0; i < 4; i += 1) saveSession(record(`s${i}-00000${i}`), { cwd: '/p', root, keep: 2 });
  assert.equal(readdirSync(join(root, dirKey('/p'))).length, 2);
});

test('a corrupt or foreign file in the folder is skipped', () => {
  const root = fresh();
  saveSession(record('aaa-000001'), { cwd: '/p', root });
  const dir = join(root, dirKey('/p'));
  writeFileSync(join(dir, 'broken.json'), '{nope');
  writeFileSync(join(dir, 'other.json'), JSON.stringify({ id: '../x', messages: [] }));
  assert.deepEqual(listSessions('/p', { root }).map((s) => s.id), ['aaa-000001']);
});

test('a save that cannot be made is refused, and trySave reports it instead of throwing', () => {
  const root = fresh();
  assert.throws(() => saveSession(record('../escape'), { cwd: '/p', root }), /not a session id/);
  assert.equal(trySave(record('../escape'), { cwd: '/p', root }), false);
  assert.equal(trySave(record('aaa-000001'), { cwd: '/p', root }), true);
});

test('a store directory that belongs to someone else is refused', { skip: !posix }, () => {
  const root = fresh();
  const real = process.getuid;
  process.getuid = () => real() + 1;
  try {
    assert.throws(() => saveSession(record('aaa-000001'), { cwd: '/p', root }), /another user/);
    assert.deepEqual(listSessions('/p', { root }), []);
  } finally { process.getuid = real; }
});

test('an existing store directory that is too open is tightened on save', { skip: !posix }, () => {
  const root = fresh();
  mkdirSync(join(root, 'sub'));
  chmodSync(root, 0o777);
  saveSession(record('aaa-000001'), { cwd: '/p', root });
  assert.equal(statSync(root).mode & 0o777, 0o700);
});

test('summary is one line with date, turns and model', () => {
  const line = summary(record('aaa-000001', { turns: 3, model: 'qwen' }));
  assert.match(line, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} · 3 turns · qwen$/);
  assert.match(summary(record('aaa-000001', { turns: 1 })), /1 turn · m1/);
  assert.match(summary(record('aaa-000001', { updatedAt: 'garbage' })), /^unknown date/);
});

test('the list shows what each session was about, on one line', () => {
  const s = record('aaa-000001', { messages: [{ role: 'user', content: 'x'.repeat(200) + '\nsecond line' }] });
  assert.ok(firstPrompt(s).length <= 60);
  assert.ok(!firstPrompt(s).includes('\n'));
  const lines = listLines([s, record('bbb-000002')]);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^ 1 {2}aaa-000001 /);
  assert.match(lines[1], /^ 2 {2}bbb-000002 .*hello there$/);
});

test('the saved file is plain JSON a person could read back', () => {
  const root = fresh();
  const file = saveSession(record('aaa-000001'), { cwd: '/p', root });
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).id, 'aaa-000001');
});

test('argv: --resume with and without an id, -r, and --sessions', () => {
  assert.equal(parseArgv([]).resume, false);
  assert.deepEqual(
    (({ resume, resumeId }) => ({ resume, resumeId }))(parseArgv(['--resume'])),
    { resume: true, resumeId: null },
  );
  assert.equal(parseArgv(['-r', 'abc-0123ef']).resumeId, 'abc-0123ef');
  assert.equal(parseArgv(['--sessions']).sessions, true);
  // A prompt after the flag stays a prompt.
  const p = parseArgv(['--resume', 'fix the bug']);
  assert.equal(p.resumeId, null);
  assert.deepEqual(p.words, ['fix the bug']);
});
