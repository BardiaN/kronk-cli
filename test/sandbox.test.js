import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, realpathSync, existsSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import { seatbeltProfile, bwrapArgs, detectBackend, sandboxArgv, onPath, extraPaths } from '../src/sandbox.js';
import { safe, session, runTool, resolveSandbox, sandbox } from '../src/tools.js';

/**
 * The README calls the launch directory a sandbox. These are the tests that make
 * that word true rather than aspirational — one per escape that used to work.
 */

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'kronk-sbx-')));

/** Point the tool layer at a throwaway root, and put it back afterwards. */
function withRoot(dir, fn) {
  const prev = { ...session };
  session.root = dir;
  session.cwd = dir;
  try { return fn(); } finally { Object.assign(session, prev); }
}

// ── path containment ──────────────────────────────────────────────────────────

test('a symlink inside the root cannot be used to read outside it', () => {
  const root = tmp();
  symlinkSync('/etc/hosts', join(root, 'escape'));
  withRoot(root, () => {
    assert.throws(() => safe('escape'), /refusing to touch path outside/);
  });
});

test('a symlinked directory cannot be used to write outside the root', () => {
  const root = tmp();
  const outside = tmp();
  symlinkSync(outside, join(root, 'outdir'));
  withRoot(root, () => {
    assert.throws(() => safe('outdir/pwned.txt'), /refusing to touch path outside/);
  });
});

test('an ordinary path that does not exist yet is still allowed', () => {
  const root = tmp();
  withRoot(root, () => {
    assert.equal(safe('nested/new-file.txt'), join(root, 'nested/new-file.txt'));
  });
});

test('search resolves its path through the same guard as read_file', async () => {
  const root = tmp();
  await withRoot(root, async () => {
    const out = await runTool('search', { pattern: 'localhost', path: '/etc/hosts' });
    assert.match(out, /refusing to touch path outside/);
  });
});

test('search still works inside the root', async () => {
  const root = tmp();
  writeFileSync(join(root, 'a.txt'), 'find-me-here\n');
  await withRoot(root, async () => {
    const out = await runTool('search', { pattern: 'find-me-here' });
    assert.match(out, /a\.txt/);
  });
});

// ── profile construction ──────────────────────────────────────────────────────

test('the seatbelt profile denies writes but hands the project back', () => {
  const p = seatbeltProfile({ root: '/proj', home: '/Users/x', tmp: '/tmp/t' });
  assert.match(p, /\(deny file-write\*\)/);
  assert.match(p, /\(allow file-write\*[^\n]*\(subpath "\/proj"\)/);
  assert.match(p, /\(deny file-read\*[^\n]*\(subpath "\/Users\/x\/\.ssh"\)/);
});

test('paths with quotes cannot break out of the profile syntax', () => {
  const p = seatbeltProfile({ root: '/a"b', home: '/h', tmp: '/t' });
  assert.match(p, /\(subpath "\/a\\"b"\)/);
});

test('bwrap denies by default rather than subtracting from a writable root', () => {
  const a = bwrapArgs({ root: '/home/x/proj', home: '/home/x', cwd: '/home/x/proj' }).join(' ');
  // `--dev-bind / /` hands over the whole filesystem read-write; making $HOME
  // read-only afterwards still leaves /etc, /opt and /usr/local writable.
  assert.ok(!a.includes('--dev-bind / /'), 'the root filesystem must not be bound read-write');
  assert.ok(a.indexOf('--ro-bind / /') < a.indexOf('--bind /home/x/proj /home/x/proj'),
    'the project must be rebound after the filesystem is made read-only, or it stays read-only');
  assert.match(a, /--dev \/dev/);
  assert.match(a, /--proc \/proc/);
});

test('bwrap keeps TMPDIR writable when it is not /tmp', () => {
  const a = bwrapArgs({ root: '/p', home: '/h', cwd: '/p', tmp: '/tmp' }).join(' ');
  assert.match(a, /--bind \/tmp \/tmp/);
});

test('a logged-in CLI can still read its own session token', () => {
  // The deny-list used to cover ~/.kube, ~/.aws and ~/.config/gh, which broke
  // kubectl and gh outright while missing argocd. Only pivot-grade material is
  // denied by default now.
  const p = seatbeltProfile({ root: '/proj', home: '/h', tmp: '/t' });
  for (const readable of ['/h/.kube', '/h/.aws', '/h/.config/gh', '/h/.config/argocd', '/h/.docker']) {
    assert.ok(!p.includes(`(subpath "${readable}")`), `${readable} should stay readable`);
  }
  for (const denied of ['/h/.ssh', '/h/.gnupg', '/h/Library/Keychains']) {
    assert.ok(p.includes(`(subpath "${denied}")`), `${denied} should be denied`);
  }
});

test('KRONK_SANDBOX_DENY hides more, KRONK_SANDBOX_ALLOW lifts a default denial', () => {
  const denied = seatbeltProfile({ root: '/proj', home: '/h', tmp: '/t', deny: ['/h/.kube'] });
  assert.ok(denied.includes('(subpath "/h/.kube")'), 'DENY should add a path');

  // Without this there is no way to run a keychain-backed CLI short of
  // disabling the sandbox entirely.
  const allowed = seatbeltProfile({ root: '/proj', home: '/h', tmp: '/t', allow: ['/h/Library/Keychains'] });
  const readDenies = allowed.split('\n').find((l) => l.startsWith('(deny file-read*'));
  assert.ok(!readDenies.includes('/h/Library/Keychains'), 'ALLOW should lift the denial');
  assert.ok(allowed.includes('(allow file-write*') && allowed.includes('/h/Library/Keychains'),
    'ALLOW should also make it writable');
});

test('extraPaths accepts colon or comma lists and expands ~', () => {
  assert.deepEqual(extraPaths('~/.kube:/etc/x', '/h'), ['/h/.kube', '/etc/x']);
  assert.deepEqual(extraPaths('a,,b', '/h'), ['a', 'b']);
  assert.deepEqual(extraPaths(undefined, '/h'), []);
});

test('KRONK_SANDBOX=off turns confinement off and nothing else does', () => {
  assert.equal(detectBackend({ platform: 'darwin', env: { KRONK_SANDBOX: 'off', PATH: '/usr/bin' } }), 'none');
  assert.equal(detectBackend({ platform: 'linux', env: { PATH: '/nonexistent' } }), 'none');
});

test('an unconfined argv is still a runnable bash argv', () => {
  const [bin, argv] = sandboxArgv('echo hi', { backend: 'none', root: '/r', home: '/h', cwd: '/r' });
  assert.equal(bin, 'bash');
  assert.deepEqual(argv, ['-c', 'echo hi']);
});

// ── the kernel actually enforcing it ──────────────────────────────────────────

const backend = resolveSandbox();
const unconfined = backend === 'none';
const why = { skip: unconfined ? `no sandbox backend here (${sandbox.reason})` : false };

/**
 * Skipping is the right default — plenty of machines cannot offer a backend, and
 * failing there would be noise. But a green run that silently proved nothing is
 * worse than a red one, so CI sets this and the absence of a backend becomes a
 * failure instead of a shrug.
 */
test('a sandbox backend is available where one is required', {
  skip: process.env.KRONK_SANDBOX_REQUIRED === '1' ? false : 'KRONK_SANDBOX_REQUIRED is not set',
}, () => {
  assert.notEqual(backend, 'none',
    `KRONK_SANDBOX_REQUIRED=1 but the shell would run unconfined: ${sandbox.reason}`);
});

test('bash cannot write outside the root', why, async () => {
  // The root goes under $HOME, not TMPDIR: /tmp is deliberately writable so
  // builds can use it, so a root inside /tmp makes "just outside the root" a
  // permitted location and the test proves nothing.
  const root = realpathSync(mkdtempSync(join(homedir(), '.kronk-root-')));
  const sibling = realpathSync(mkdtempSync(join(homedir(), '.kronk-outside-')));

  // An earlier version only tried $HOME. On Linux $HOME was the one place that
  // happened to be protected, while /etc, /opt and /usr/local stayed writable —
  // so this passed while the shipped claim was false. Any location that is
  // writable *without* the sandbox has to be blocked *with* it.
  const candidates = [
    join(homedir(), '.kronk-sandbox-escape-test'),
    join(sibling, 'escape.txt'),
    '/usr/local/.kronk-sandbox-escape-test',
    '/opt/.kronk-sandbox-escape-test',
    '/etc/.kronk-sandbox-escape-test',
  ];

  try {
    let exercised = 0;
    for (const outside of candidates) {
      // Only meaningful where the write would otherwise succeed; asserting that
      // a root-owned path stayed empty proves file permissions, not a sandbox.
      try { writeFileSync(outside, 'probe'); rmSync(outside, { force: true }); }
      catch { continue; }
      exercised++;

      await withRoot(root, async () => { await runTool('bash', { cmd: `echo pwned > ${outside}` }); });
      const landed = existsSync(outside);
      if (landed) rmSync(outside, { force: true });
      assert.equal(landed, false, `the write escaped the sandbox: ${outside}`);
    }
    assert.ok(exercised >= 2, `only ${exercised} escape targets were writable — this proved little`);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(sibling, { recursive: true, force: true });
  }
});

test('bash cannot read a credential directory', why, async () => {
  const root = tmp();
  await withRoot(root, async () => {
    const out = await runTool('bash', { cmd: `cat ${join(homedir(), '.ssh', 'id_rsa')}` });
    assert.match(out, /error: exit code/);
    assert.doesNotMatch(out, /PRIVATE KEY/);
  });
});

test('bash can still do ordinary work inside the root', why, async () => {
  const root = tmp();
  mkdirSync(join(root, 'sub'));
  await withRoot(root, async () => {
    const out = await runTool('bash', { cmd: 'echo ok > f.txt && cat f.txt' });
    assert.match(out, /ok/);
  });
});

test('onPath finds a binary that exists and not one that does not', () => {
  assert.equal(onPath('sh', { env: { PATH: '/bin:/usr/bin' } }), true);
  assert.equal(onPath('definitely-not-a-real-binary', { env: { PATH: '/bin:/usr/bin' } }), false);
});

// ---------------------------------------------------------------------------
// #21: a read-only grant channel, separate from KRONK_SANDBOX_ALLOW.
// The whole point is the asymmetry — `allow` grants read and write, `readable`
// grants only read — so every test here checks both halves, not just the one
// that was asked for.
// ---------------------------------------------------------------------------

const readDenyLine = (p) => p.split('\n').find((l) => l.startsWith('(deny file-read*'));
const writeAllowLine = (p) => p.split('\n').find((l) => l.startsWith('(allow file-write*'));

test('a readable path is lifted out of the read denial', () => {
  const p = seatbeltProfile({ root: '/proj', home: '/h', tmp: '/t', readable: ['/h/Library/Keychains'] });
  assert.ok(!readDenyLine(p).includes('/h/Library/Keychains'), 'the denial must be lifted');
  // Everything else on the default list stays denied — a grant is one path.
  assert.ok(readDenyLine(p).includes('/h/.ssh'));
  assert.ok(readDenyLine(p).includes('/h/.gnupg'));
});

test('a readable path is NOT made writable', () => {
  const p = seatbeltProfile({ root: '/proj', home: '/h', tmp: '/t', readable: ['/h/Library/Keychains'] });
  assert.ok(!writeAllowLine(p).includes('/h/Library/Keychains'),
    'granting a read must never grant a write to a credential store');
});

test('allow still grants both, so the existing escape hatch is unchanged', () => {
  const p = seatbeltProfile({ root: '/proj', home: '/h', tmp: '/t', allow: ['/h/Library/Keychains'] });
  assert.ok(!readDenyLine(p).includes('/h/Library/Keychains'));
  assert.ok(writeAllowLine(p).includes('/h/Library/Keychains'));
});

test('bwrap does not tmpfs a readable path, and does not bind it read-write', () => {
  const dir = tmp();
  const home = join(dir, 'home');
  const granted = join(home, 'Library', 'Keychains');
  mkdirSync(granted, { recursive: true });
  mkdirSync(join(home, '.ssh'), { recursive: true });

  const argv = bwrapArgs({ root: dir, home, cwd: dir, readable: [granted] }).join(' ');

  assert.ok(!argv.includes(`--tmpfs ${granted}`), 'a granted path must not be hidden');
  assert.ok(!argv.includes(`--bind ${granted} ${granted}`), 'and must not become writable');
  // It needs no bind of its own: `--ro-bind / /` already covers it.
  assert.ok(argv.includes('--ro-bind / /'));
  // The rest of the default list is still hidden.
  assert.ok(argv.includes(`--tmpfs ${join(home, '.ssh')}`));
});

test('a readable path that does not exist adds nothing and does not throw', () => {
  const dir = tmp();
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });
  const missing = join(home, 'Library', 'Keychains');
  const args = bwrapArgs({ root: dir, home, cwd: dir, readable: [missing] });
  assert.ok(!args.includes(missing), 'nothing to hide and nothing to bind');
});

test('sandboxArgv forwards readable, and behaves as before when it is omitted', () => {
  const env = {};
  const [, withGrant] = sandboxArgv('true', {
    backend: 'seatbelt', root: '/proj', home: '/h', cwd: '/proj', tmp: '/t', env,
    readable: ['/h/Library/Keychains'],
  });
  assert.ok(!readDenyLine(withGrant[1]).includes('/h/Library/Keychains'));

  const [, without] = sandboxArgv('true', {
    backend: 'seatbelt', root: '/proj', home: '/h', cwd: '/proj', tmp: '/t', env,
  });
  assert.ok(readDenyLine(without[1]).includes('/h/Library/Keychains'),
    'omitting readable must leave the default denial in place');
});
