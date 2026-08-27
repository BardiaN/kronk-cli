import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CREDENTIAL_TOOLS, credentialPaths, declineGrants, grantsNeeded, rememberGrants, session, ungranted,
} from '../src/tools.js';
import { config } from '../src/config.js';

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

// ── asked once per path per session ───────────────────────────────────────────

test('granting a path stops it being asked about again', () => {
  const home = mkdtempSync(join(tmpdir(), 'kc-'));
  mkdirSync(join(home, 'Library', 'Keychains'), { recursive: true });
  const opts = { home, backend: 'seatbelt' };

  withSession({}, () => {
    assert.equal(grantsNeeded('gh pr list', opts).length, 1, 'first command asks');
    rememberGrants(grantsNeeded('gh pr list', opts));
    assert.deepEqual(grantsNeeded('gh issue list', opts), [], 'the second must not');
  });
});

test('declining a path also stops it being asked about again', () => {
  const home = mkdtempSync(join(tmpdir(), 'kc-'));
  mkdirSync(join(home, 'Library', 'Keychains'), { recursive: true });
  const opts = { home, backend: 'seatbelt' };

  withSession({}, () => {
    const needed = grantsNeeded('gh pr list', opts);
    assert.equal(needed.length, 1);
    declineGrants(needed);
    // Still denied, still ungranted — but not asked about, which is the point.
    assert.equal(ungranted('gh issue list', opts).length, 1);
    assert.deepEqual(grantsNeeded('gh issue list', opts), []);
  });
});

test('granting after a decline clears the decline', () => {
  const home = mkdtempSync(join(tmpdir(), 'kc-'));
  const keychain = join(home, 'Library', 'Keychains');
  mkdirSync(keychain, { recursive: true });

  withSession({ declined: [keychain] }, () => {
    rememberGrants([keychain]);
    assert.ok(session.grants.has(keychain));
    assert.ok(!session.declined.has(keychain), 'a later yes must win over an earlier no');
  });
});

// ── persistence ───────────────────────────────────────────────────────────────

/** Point config.rcPath at a scratch file for one test. */
function withRc(contents, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'kc-rc-'));
  const file = join(dir, '.kronk-cli.json');
  if (contents !== null) writeFileSync(file, contents);
  const prev = config.rcPath;
  config.rcPath = file;
  try { return fn(file); } finally { config.rcPath = prev; }
}

test('always writes sandboxReadable without discarding other keys', () => {
  withRc(JSON.stringify({ model: 'some/model', maxTokens: 4096 }), (file) => {
    withSession({}, () => {
      const wrote = rememberGrants(['/h/Library/Keychains'], { persist: true, home: '/h' });
      assert.equal(wrote, file);
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      assert.deepEqual(saved.sandboxReadable, ['~/Library/Keychains'], 'stored ~-relative');
      assert.equal(saved.model, 'some/model', 'an unrelated key must survive');
      assert.equal(saved.maxTokens, 4096);
    });
  });
});

test('always merges with what is already there, without duplicating', () => {
  withRc(JSON.stringify({ sandboxReadable: ['~/Library/Keychains', '~/.other'] }), (file) => {
    withSession({}, () => {
      rememberGrants(['/h/Library/Keychains'], { persist: true, home: '/h' });
      const saved = JSON.parse(readFileSync(file, 'utf8'));
      assert.deepEqual(saved.sandboxReadable, ['~/Library/Keychains', '~/.other']);
    });
  });
});

test('a missing config file is created, not treated as an error', () => {
  withRc(null, (file) => {
    withSession({}, () => {
      rememberGrants(['/h/Library/Keychains'], { persist: true, home: '/h' });
      assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).sandboxReadable,
        ['~/Library/Keychains']);
    });
  });
});

test('an unparseable config file is left alone and reported', () => {
  withRc('{ this is not json', (file) => {
    withSession({}, () => {
      assert.throws(() => rememberGrants(['/h/Library/Keychains'], { persist: true, home: '/h' }),
        /not valid JSON/);
      assert.equal(readFileSync(file, 'utf8'), '{ this is not json', 'the file is untouched');
      // The grant still applies to this session — persistence is the bonus.
      assert.ok(session.grants.has('/h/Library/Keychains'));
    });
  });
});

test('answering yes rather than always persists nothing', () => {
  withRc(null, (file) => {
    withSession({}, () => {
      assert.equal(rememberGrants(['/h/Library/Keychains'], { home: '/h' }), null);
      assert.equal(existsSync(file), false, 'a session grant must not touch the config file');
    });
  });
});
