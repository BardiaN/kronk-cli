import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CREDENTIAL_TOOLS, credentialPaths, session, ungranted } from '../src/tools.js';

const HOME = '/h';
const KEYCHAIN = join(HOME, 'Library', 'Keychains');

/** Run with a known grant/decline state, then put back whatever was there. */
function withSession(state, fn) {
  const grants = new Set(session.grants);
  const declined = new Set(session.declined);
  session.grants = new Set(state.grants ?? []);
  session.declined = new Set(state.declined ?? []);
  try { return fn(); } finally { Object.assign(session, { grants, declined }); }
}

// ── the command scanner ───────────────────────────────────────────────────────

test('a known binary in command position matches', () => {
  for (const cmd of ['gh issue view 1', 'cd x && gh pr list', 'FOO=1 gh auth status']) {
    assert.deepEqual(credentialPaths(cmd, HOME), [KEYCHAIN], cmd);
  }
});

test('a known name that is not the command does not match', () => {
  // `echo gh` runs echo. `mygh` is a different binary that merely ends in gh.
  for (const cmd of ['echo gh', 'mygh status', 'ls', 'npm test', 'grep gh file']) {
    assert.deepEqual(credentialPaths(cmd, HOME), [], cmd);
  }
});

test('every separator that starts a new command is honoured', () => {
  for (const sep of [';', '&&', '||', '|', '\n']) {
    assert.deepEqual(credentialPaths(`ls ${sep} gh pr list`, HOME), [KEYCHAIN], sep);
  }
});

test('an absolute path to a known binary matches on its basename', () => {
  assert.deepEqual(credentialPaths('/usr/local/bin/gh pr list', HOME), [KEYCHAIN]);
});

test('two commands needing the same path yield it once', () => {
  assert.deepEqual(credentialPaths('gh pr list && docker push x', HOME), [KEYCHAIN]);
});

test('the scanner never mutates the command it is given', () => {
  const cmd = 'FOO=1 gh auth status && echo done';
  const copy = String(cmd);
  credentialPaths(cmd, HOME);
  assert.equal(cmd, copy);
});

test('empty and nonsense input is answered, not thrown at', () => {
  for (const cmd of ['', '   ', undefined, null, ';;;', '| | |']) {
    assert.deepEqual(credentialPaths(cmd, HOME), []);
  }
});

test('the tool map holds only what was measured', () => {
  assert.deepEqual(Object.keys(CREDENTIAL_TOOLS).sort(), ['docker', 'gh']);
});

// ── what is actually worth asking about ───────────────────────────────────────

test('nothing is ungranted when no sandbox is in force', () => {
  withSession({}, () => {
    assert.deepEqual(ungranted('gh pr list', { home: HOME, backend: 'none' }), []);
    assert.deepEqual(ungranted('gh pr list', { home: HOME, backend: 'pending' }), []);
  });
});

test('a path already granted is not asked about again', () => {
  withSession({ grants: [KEYCHAIN] }, () => {
    assert.deepEqual(ungranted('gh pr list', { home: HOME, backend: 'seatbelt' }), []);
  });
});

// This is what keeps Linux quiet about a macOS keychain: the path is simply not
// there, so there is nothing to grant and nothing to ask.
test('a path that does not exist on this machine is never asked about', () => {
  withSession({}, () => {
    assert.deepEqual(ungranted('gh pr list', { home: '/nonexistent-home', backend: 'seatbelt' }), []);
  });
});

test('a real, denied, ungranted path is what produces a question', () => {
  const home = mkdtempSync(join(tmpdir(), 'kc-'));
  mkdirSync(join(home, 'Library', 'Keychains'), { recursive: true });
  withSession({}, () => {
    assert.deepEqual(
      ungranted('gh pr list', { home, backend: 'seatbelt' }),
      [join(home, 'Library', 'Keychains')],
    );
  });
});

test('declining is remembered separately from granting', () => {
  // `ungranted` reports what is denied; whether to *ask* also depends on
  // `declined`, which the agent layer consults. Keeping them apart is what lets
  // a declined path still produce the failure hint without re-prompting.
  withSession({ declined: [KEYCHAIN] }, () => {
    assert.ok(session.declined.has(KEYCHAIN));
    assert.ok(!session.grants.has(KEYCHAIN));
  });
});
