import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, realpathSync, existsSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import { seatbeltProfile, bwrapArgs, detectBackend, sandboxArgv, onPath } from '../src/sandbox.js';
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

test('bwrap rebinds the project read-write inside a read-only home', () => {
  const a = bwrapArgs({ root: '/home/x/proj', home: '/home/x', cwd: '/home/x/proj' }).join(' ');
  assert.match(a, /--dev-bind \/ \//);
  assert.ok(a.indexOf('--ro-bind /home/x /home/x') < a.indexOf('--bind /home/x/proj /home/x/proj'),
    'the project must be rebound after the home is made read-only, or it wins');
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

test('bash cannot write outside the root', why, async () => {
  const root = tmp();
  // Not a temp path — the profile allows those on purpose, so a build can use
  // TMPDIR. Home is where an escape would actually hurt.
  const outside = join(homedir(), '.kronk-sandbox-escape-test');
  await withRoot(root, async () => {
    await runTool('bash', { cmd: `echo pwned > ${outside}` });
    const landed = existsSync(outside);
    if (landed) rmSync(outside, { force: true });
    assert.equal(landed, false, 'the write escaped the sandbox');
  });
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
