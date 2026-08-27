import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CREDENTIAL_TOOLS, credentialHint, credentialPaths, declineGrants, grantsNeeded, rememberGrants,
  resolveSandbox, runBash, session, ungranted,
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

// ── the failure hint ──────────────────────────────────────────────────────────
//
// The criterion most likely to be got wrong, and the one worth the most: the
// hint must be silent on ordinary failures. SECRET_FILES are denied
// unconditionally under any active backend, so "something is denied" is always
// true and would make this fire on every failing build.

function withKeychainHome(fn) {
  const home = mkdtempSync(join(tmpdir(), 'kc-'));
  mkdirSync(join(home, 'Library', 'Keychains'), { recursive: true });
  return fn(home, { home, backend: 'seatbelt' });
}

test('a failing credential command gets the hint', () => {
  withKeychainHome((home, opts) => {
    withSession({}, () => {
      const hint = credentialHint('gh auth status', opts);
      assert.match(hint, /^note: the sandbox denies reads of ~\/Library\/Keychains/);
      assert.match(hint, /which gh uses/);
      assert.match(hint, /Re-run and allow it/);
    });
  });
});

test('a failing ordinary command gets NO hint', () => {
  withKeychainHome((home, opts) => {
    withSession({}, () => {
      for (const cmd of ['npm test', 'make build', 'node x.js', 'echo gh', 'cargo test']) {
        assert.equal(credentialHint(cmd, opts), null, cmd);
      }
    });
  });
});

test('a credential command with the grant already in place gets no hint', () => {
  withKeychainHome((home, opts) => {
    withSession({ grants: [join(home, 'Library', 'Keychains')] }, () => {
      assert.equal(credentialHint('gh auth status', opts), null);
    });
  });
});

test('with the sandbox off nothing is denied, so there is no hint', () => {
  withKeychainHome((home) => {
    withSession({}, () => {
      assert.equal(credentialHint('gh auth status', { home, backend: 'none' }), null);
    });
  });
});

// A decline means "do not ask me again", not "stop telling me why it failed" —
// otherwise declining once hides the reason for every later failure.
test('a declined path still produces the hint', () => {
  withKeychainHome((home, opts) => {
    withSession({ declined: [join(home, 'Library', 'Keychains')] }, () => {
      assert.ok(credentialHint('gh auth status', opts));
    });
  });
});

test('the hint never advises the read-write escape hatch', () => {
  withKeychainHome((home, opts) => {
    withSession({}, () => {
      assert.ok(!credentialHint('gh auth status', opts).includes('KRONK_SANDBOX_ALLOW'));
    });
  });
});

test('the hint sits with the error, above the output a cap would cut', async () => {
  // Real command, real failure, real sandbox — but only where one exists.
  const backend = resolveSandbox();
  const out = await runBash('gh auth status', { timeoutMs: 20_000 });
  const lines = out.split('\n');
  const hintAt = lines.findIndex((l) => l.startsWith('note: the sandbox denies reads'));

  if (backend === 'none' || hintAt === -1) return;   // nothing denied here to hint about
  assert.ok(lines[0].startsWith('error:'), 'the error still leads');
  assert.ok(hintAt <= 3, `the hint must sit near the top, was line ${hintAt}`);
  assert.ok(lines.slice(0, hintAt).some((l) => l.startsWith('ran in:')),
    'it comes after ran in:, not before');
});
