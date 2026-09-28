import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { config } from '../src/config.js';
import { VERSION, parseKronkVersion } from '../src/version.js';
import { detectInstall, refreshCliUpdate, updateStatus } from '../src/update.js';
import { banner } from '../src/ui.js';

const run = promisify(execFile);
const CLI = new URL('../src/index.js', import.meta.url).pathname;

// ---- one source of the version -------------------------------------------

test('mcp.js announces the real package.json version, not a carried literal', async () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const { loadServers } = await import('../src/mcp.js');
  // loadServers is imported only to force module evaluation the same way
  // index.js does; the assertion is against the exported constant itself,
  // reached the same way mcp.js reaches it, so a future refactor of either
  // side still has to keep them equal to pass.
  assert.equal(typeof loadServers, 'function');
  assert.equal(VERSION, pkg.version, 'src/version.js must read the same file package.json ships');
});

test('parseKronkVersion reads the version kronk --version prints', () => {
  assert.equal(parseKronkVersion('kronk version 1.32.7\n'), '1.32.7');
  assert.equal(parseKronkVersion('kronk version 1.32.7'), '1.32.7');
  // No recognisable shape: the first line is still more useful on screen than
  // silence, so it is not thrown away — but it is only the first line, and it
  // is bounded. `--version` prints one row; a binary that answered with a
  // stack trace must not turn that row into a page.
  assert.equal(parseKronkVersion('  something else  \n'), 'something else');
  assert.equal(parseKronkVersion('boom\nat a()\nat b()'), 'boom');
  assert.ok(parseKronkVersion(`${'x'.repeat(500)}\n`).length <= 60);
  assert.equal(parseKronkVersion('   \n'), null);
});

// ---- install-route detection ----------------------------------------------

function fakeEntry(dir, ...segments) {
  const full = join(dir, ...segments, 'src');
  mkdirSync(full, { recursive: true });
  return join(full, 'index.js');
}

test('install-route detection: Homebrew, npm, install.sh and a git checkout are told apart', () => {
  const root = mkdtempSync(join(tmpdir(), 'kronk-routes-'));

  const brew = fakeEntry(root, 'opt', 'homebrew', 'Cellar', 'kronk-cli', '0.8.1', 'libexec');
  assert.deepEqual(detectInstall(brew), { route: 'brew' });

  const npm = fakeEntry(root, 'usr', 'local', 'lib', 'node_modules', 'kronk-cli');
  assert.deepEqual(detectInstall(npm), { route: 'npm' });

  const installSh = fakeEntry(root, 'home', 'x', '.local', 'lib', 'kronk-cli');
  assert.deepEqual(detectInstall(installSh), {
    route: 'install-sh', dir: join(root, 'home', 'x', '.local', 'lib', 'kronk-cli'),
  });

  const gitCheckout = fakeEntry(root, 'checkout');
  mkdirSync(join(root, 'checkout', '.git'));
  assert.deepEqual(detectInstall(gitCheckout), { route: 'git', dir: join(root, 'checkout') });

  // With no receipt to go on, a .git ancestor is the better guess and wins
  // even where the path also happens to look like the install script's shape.
  const gitInsideLib = fakeEntry(root, 'weird', 'lib', 'kronk-cli');
  mkdirSync(join(root, 'weird', '.git'));
  assert.equal(detectInstall(gitInsideLib).route, 'git');

  // None of the above.
  assert.equal(detectInstall(fakeEntry(root, 'somewhere', 'else')), null);
});

test('a receipt outranks a .git ancestor, so a tarball install is never told to git pull', () => {
  const root = mkdtempSync(join(tmpdir(), 'kronk-routes-receipt-'));

  // install.sh's own default is $PREFIX=$HOME/.local, and keeping $HOME under
  // version control for one's dotfiles is common enough that this is the
  // ordinary case, not a contrived one: ~/.git sits well inside the depth the
  // search walks. Telling that person `git pull` to upgrade a tarball install
  // sends them somewhere that will not have it.
  const entry = fakeEntry(root, 'home', 'x', '.local', 'lib', 'kronk-cli');
  const libDir = join(root, 'home', 'x', '.local', 'lib', 'kronk-cli');
  mkdirSync(join(root, 'home', 'x', '.git'), { recursive: true });

  // Without the receipt there is nothing but the path to go on, so the .git wins.
  assert.equal(detectInstall(entry).route, 'git');

  writeFileSync(join(libDir, '.install-receipt.json'),
    JSON.stringify({ version: '0.7.0', source: 'install.sh' }));
  assert.deepEqual(detectInstall(entry), { route: 'install-sh', dir: libDir },
    'the receipt is evidence of the same rank as a .git directory, and it is nearer');
});

// ---- stub package managers, and the spawn log that proves what ran -------

function bin(dir) { mkdirSync(dir, { recursive: true }); return dir; }

function stub(dir, name, body) {
  writeFileSync(join(dir, name), body, { mode: 0o755 });
}

const NPM_OK = (log, version) => `#!/bin/sh
echo "npm $*" >> "${log}"
echo "${version}"
`;
const NPM_GARBAGE = (log) => `#!/bin/sh
echo "npm $*" >> "${log}"
echo "not-a-version"
`;
// PATH is pinned to the stub directory alone for these tests (see world()),
// so the script sticks to shell builtins — no cat, no echo -e — rather than
// relying on anything else that happens to live on the real PATH.
const BREW_OK = (log, version) => `#!/bin/sh
echo "brew $*" >> "${log}"
printf '%s\\n' '{"formulae":[{"name":"kronk-cli","current_version":"${version}"}]}'
`;
const BREW_FAIL = (log) => `#!/bin/sh
echo "brew $*" >> "${log}"
echo "boom" 1>&2
exit 1
`;
const GIT_OK = (log, tag) => `#!/bin/sh
echo "git $*" >> "${log}"
case "$*" in
  *"fetch --tags"*) exit 0 ;;
  *"tag --sort"*) printf '%s\\n' "${tag}" ;;
esac
`;
const HANGS = (log) => `#!/bin/sh
echo "hang $*" >> "${log}"
exec sleep 30
`;

function world() {
  const dir = mkdtempSync(join(tmpdir(), 'kronk-update-'));
  const binDir = bin(join(dir, 'bin'));
  const log = join(dir, 'spawn.log');
  const cacheFile = join(dir, 'cache.json');
  return { dir, binDir, log, cacheFile, spawned: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : []) };
}

/** entryPath + install for a bare git checkout the tests can point routes at. */
function gitInstall(dir) {
  const entryPath = fakeEntry(dir, 'checkout');
  mkdirSync(join(dir, 'checkout', '.git'));
  return { entryPath, install: { route: 'git', dir: join(dir, 'checkout') } };
}

let savedPath;
test.beforeEach(() => { savedPath = process.env.PATH; });
test.afterEach(() => { process.env.PATH = savedPath; });

// ---- each manager, asked for real ------------------------------------------

test('npm, brew and git each produce their own, distinct upgrade hint', async () => {
  const w = world();
  const { entryPath: gitEntry, install: gitInst } = gitInstall(w.dir);

  stub(w.binDir, 'npm', NPM_OK(w.log, '9.9.9'));
  stub(w.binDir, 'brew', BREW_OK(w.log, '9.9.9'));
  stub(w.binDir, 'git', GIT_OK(w.log, 'v9.9.9'));
  process.env.PATH = w.binDir;

  const npmCli = join(w.dir, 'npm', 'lib', 'node_modules', 'kronk-cli', 'src', 'index.js');
  const brewCli = join(w.dir, 'brew', 'Cellar', 'kronk-cli', '9.9.9', 'libexec', 'src', 'index.js');

  const [npmHint, brewHint, gitHint] = await Promise.all([
    refreshCliUpdate({ entryPath: npmCli, install: { route: 'npm' }, cacheFile: join(w.dir, 'npm.json') }),
    refreshCliUpdate({ entryPath: brewCli, install: { route: 'brew' }, cacheFile: join(w.dir, 'brew.json') }),
    refreshCliUpdate({ entryPath: gitEntry, install: gitInst, cacheFile: join(w.dir, 'git.json') }),
  ]);

  assert.equal(npmHint.hint, 'npm install -g kronk-cli@latest');
  assert.equal(brewHint.hint, 'brew upgrade kronk-cli');
  assert.equal(gitHint.hint, 'git pull');
  const hints = new Set([npmHint.hint, brewHint.hint, gitHint.hint]);
  assert.equal(hints.size, 3, 'all three must be distinct');
  for (const h of [npmHint, brewHint, gitHint]) {
    assert.equal(h.current, VERSION);
    assert.equal(h.latest, '9.9.9');
  }
});

test('a manager that is not outdated, or reports the same version, produces no update', async () => {
  const w = world();
  stub(w.binDir, 'npm', NPM_OK(w.log, VERSION));   // "latest" == current
  process.env.PATH = w.binDir;
  const npmCli = join(w.dir, 'npm', 'lib', 'node_modules', 'kronk-cli', 'src', 'index.js');
  const result = await refreshCliUpdate({
    entryPath: npmCli, install: { route: 'npm' }, cacheFile: w.cacheFile,
  });
  assert.equal(result, null);
});

// ---- a manager that misbehaves --------------------------------------------

test('garbage output, a non-zero exit, and a hang all produce null, never a throw', async () => {
  const w = world();
  stub(w.binDir, 'npm', NPM_GARBAGE(w.log));
  stub(w.binDir, 'brew', BREW_FAIL(w.log));
  stub(w.binDir, 'git', HANGS(w.log));
  process.env.PATH = w.binDir;

  const { entryPath: gitEntry, install: gitInst } = gitInstall(w.dir);
  const npmCli = join(w.dir, 'npm', 'lib', 'node_modules', 'kronk-cli', 'src', 'index.js');
  const brewCli = join(w.dir, 'brew', 'Cellar', 'kronk-cli', '0.1.0', 'libexec', 'src', 'index.js');

  const results = await Promise.all([
    refreshCliUpdate({ entryPath: npmCli, install: { route: 'npm' }, cacheFile: join(w.dir, 'a.json') }),
    refreshCliUpdate({ entryPath: brewCli, install: { route: 'brew' }, cacheFile: join(w.dir, 'b.json') }),
    refreshCliUpdate({ entryPath: gitEntry, install: gitInst, cacheFile: join(w.dir, 'c.json') }),
  ]);
  assert.deepEqual(results, [null, null, null]);
});

// ---- the cache --------------------------------------------------------------

test('a fresh cache entry is used without spawning anything', () => {
  const w = world();
  stub(w.binDir, 'npm', NPM_OK(w.log, '9.9.9'));
  process.env.PATH = w.binDir;

  const npmCli = join(w.dir, 'npm', 'lib', 'node_modules', 'kronk-cli', 'src', 'index.js');
  const seeded = { current: VERSION, latest: '9.9.9', hint: 'npm install -g kronk-cli@latest' };
  writeFileSync(w.cacheFile, JSON.stringify({ checkedAt: Date.now(), cli: seeded }));

  const status = updateStatus({ entryPath: npmCli, cacheFile: w.cacheFile });
  assert.deepEqual(status, { cli: seeded });
  assert.deepEqual(w.spawned(), [], 'a fresh cache must not spawn anything');
});

test('an entry older than a day triggers a refresh', async () => {
  const w = world();
  stub(w.binDir, 'npm', NPM_OK(w.log, '9.9.9'));
  process.env.PATH = w.binDir;

  const npmCli = join(w.dir, 'npm', 'lib', 'node_modules', 'kronk-cli', 'src', 'index.js');
  const stale = { current: VERSION, latest: '8.0.0', hint: 'npm install -g kronk-cli@latest' };
  writeFileSync(w.cacheFile, JSON.stringify({ checkedAt: Date.now() - (25 * 60 * 60 * 1000), cli: stale }));

  // Called directly (not fired-and-forgotten) so the assertion is deterministic.
  await refreshCliUpdate({ entryPath: npmCli, install: { route: 'npm' }, cacheFile: w.cacheFile });
  assert.ok(w.spawned().length > 0, 'a stale entry must trigger a real check');
  const rewritten = JSON.parse(readFileSync(w.cacheFile, 'utf8'));
  assert.equal(rewritten.cli.latest, '9.9.9');
});

test('a corrupt or unreadable cache file is a no-op, not a crash', () => {
  const w = world();
  stub(w.binDir, 'npm', NPM_OK(w.log, '9.9.9'));
  process.env.PATH = w.binDir;
  const npmCli = join(w.dir, 'npm', 'lib', 'node_modules', 'kronk-cli', 'src', 'index.js');

  writeFileSync(w.cacheFile, '{ this is not json');
  assert.doesNotThrow(() => updateStatus({ entryPath: npmCli, cacheFile: w.cacheFile }));
  const status = updateStatus({ entryPath: npmCli, cacheFile: w.cacheFile });
  // Treated exactly like "no cache": nothing to show yet, a refresh was queued.
  assert.equal(status, null);

  const missing = join(w.dir, 'does-not-exist.json');
  assert.doesNotThrow(() => updateStatus({ entryPath: npmCli, cacheFile: missing }));
});

// ---- the off switch ---------------------------------------------------------

test('KRONK_UPDATE_CHECK off: nothing spawns and no line renders', () => {
  const w = world();
  stub(w.binDir, 'npm', NPM_OK(w.log, '9.9.9'));
  process.env.PATH = w.binDir;
  const npmCli = join(w.dir, 'npm', 'lib', 'node_modules', 'kronk-cli', 'src', 'index.js');

  const before = config.updateCheck;
  config.updateCheck = false;
  try {
    const status = updateStatus({ entryPath: npmCli, cacheFile: w.cacheFile });
    assert.equal(status, null);
    assert.deepEqual(w.spawned(), []);
    assert.equal(existsSync(w.cacheFile), false, 'not even a cache read/write happens');
  } finally {
    config.updateCheck = before;
  }
});

// ---- install.sh's receipt ---------------------------------------------------

test('the install-script route shows a plain nudge only when a receipt exists, never a fabricated comparison', () => {
  const w = world();
  const entryPath = fakeEntry(w.dir, 'prefix', 'lib', 'kronk-cli');
  const libDir = join(w.dir, 'prefix', 'lib', 'kronk-cli');

  // No receipt yet: nothing to say, and nothing spawned to find out.
  assert.equal(updateStatus({ entryPath, cacheFile: w.cacheFile }), null);

  writeFileSync(join(libDir, '.install-receipt.json'), JSON.stringify({
    version: VERSION, source: 'install.sh', installedAt: new Date().toISOString(),
  }));
  const status = updateStatus({ entryPath, cacheFile: w.cacheFile });
  assert.equal(status.cli.hint, 're-run the install script');
  assert.equal(status.cli.current, VERSION);
  assert.equal(status.cli.latest, undefined, 'this route never claims to know a newer version exists');
});

// ---- startup must never wait ------------------------------------------------

test('updateStatus returns immediately even when the detected manager hangs', () => {
  const w = world();
  stub(w.binDir, 'git', HANGS(w.log));
  process.env.PATH = w.binDir;
  const { entryPath } = gitInstall(w.dir);

  const t0 = Date.now();
  const status = updateStatus({ entryPath, cacheFile: w.cacheFile });
  const elapsed = Date.now() - t0;
  assert.equal(status, null, 'nothing cached yet, so nothing to show this run');
  assert.ok(elapsed < 500, `updateStatus must not block on the manager (took ${elapsed}ms)`);
});

// ---- the banner --------------------------------------------------------------

test('the banner is byte-identical to today\'s when there is nothing to report', () => {
  const plain = banner('some/Model/AGENT', 'http://localhost:11435/v1');
  const withNull = banner('some/Model/AGENT', 'http://localhost:11435/v1', null);
  const withEmpty = banner('some/Model/AGENT', 'http://localhost:11435/v1', {});
  assert.equal(plain, withNull);
  assert.equal(plain, withEmpty);
  assert.doesNotMatch(plain, /update/);
});

test('the banner adds exactly one grey "update" row when there is something to report', () => {
  const withUpdate = banner('some/Model/AGENT', 'http://localhost:11435/v1', {
    cli: { current: '0.7.0', latest: '0.8.1', hint: 'brew upgrade kronk-cli' },
  });
  assert.match(withUpdate, /update {2}kronk-cli 0\.7\.0 → 0\.8\.1 · run: brew upgrade kronk-cli/);
});

// ---- end to end: the real CLI as a subprocess -------------------------------

function throwawayHome() { return mkdtempSync(join(tmpdir(), 'kronk-home-')); }

test('--version prints the real version and exits 0 with no server running', async () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const env = {
    ...process.env,
    HOME: throwawayHome(),
    KRONK_URL: 'http://127.0.0.1:9/v1',   // nothing listens here
    NO_COLOR: '1',
  };
  const { stdout } = await run(process.execPath, [CLI, '--version'], { env, timeout: 15_000 });
  // Compared as a whole line rather than through a regex built from the
  // version string. Hand-escaping a value into a pattern is the wrong shape
  // even when the value is our own semver: it reads as sanitisation, it is
  // incomplete as sanitisation, and there is nothing here a plain string
  // comparison cannot say.
  const lines = stdout.split('\n').map((l) => l.trim());
  assert.ok(lines.includes(`kronk-cli ${pkg.version}`),
    `expected a "kronk-cli ${pkg.version}" line, got: ${JSON.stringify(stdout)}`);
});

/** A minimal Kronk stub: just enough for boot() and the banner to print. */
function startStub() {
  const server = createServer((req, res) => {
    const url = req.url.split('?')[0];
    const send = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url === '/v1/models') return send(200, { data: [{ id: 'stub/Model-Q4/AGENT', object: 'model' }] });
    if (url === '/v1/kronk/models/ps') return send(200, []);
    if (url.startsWith('/v1/kronk/models')) return send(200, { model_config: {}, metadata: {}, data: [] });
    return send(404, { error: { message: `no route for ${url}` } });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}/v1`,
      close: () => { server.closeAllConnections(); server.close(); },
    }));
  });
}

test('a pre-seeded cache renders the update line at startup, with no manager spawned', async () => {
  const stubServer = await startStub();
  const cacheFile = join(mkdtempSync(join(tmpdir(), 'kronk-e2e-')), 'cache.json');
  const spawnLog = join(mkdtempSync(join(tmpdir(), 'kronk-e2e-log-')), 'spawn.log');
  const binDir = bin(join(mkdtempSync(join(tmpdir(), 'kronk-e2e-bin-')), 'bin'));
  // Matches this checkout's own route (this repository has a .git), so if
  // the cache were somehow ignored the code would fall through to git and
  // this stub would prove it by leaving a mark in the log.
  stub(binDir, 'git', GIT_OK(spawnLog, 'v999.0.0'));

  writeFileSync(cacheFile, JSON.stringify({
    checkedAt: Date.now(),
    cli: { current: VERSION, latest: '999.0.0', hint: 'git pull' },
  }));

  const env = {
    ...process.env,
    HOME: throwawayHome(),
    KRONK_URL: stubServer.url,
    KRONK_UPDATE_CACHE: cacheFile,
    PATH: binDir,
    NO_COLOR: '1',
  };
  delete env.KRONK_MODEL;
  delete env.KRONK_WARM;

  try {
    const p = run(process.execPath, [CLI, '--no-context', '--no-warm'], { env, timeout: 20_000 });
    // An immediate, empty stdin: with no prompt on argv and nothing piped in,
    // `readStdin` resolves to '' right away rather than waiting out its
    // timeout, so this lands on the REPL path — the one that prints the
    // banner — instead of being read as a one-shot prompt. The readline
    // interface then hits the same EOF and closes the loop on its own.
    p.child.stdin.end();
    const { stdout } = await p;
    assert.match(stdout, /update {2}kronk-cli .* → 999\.0\.0 · run: git pull/);
    assert.equal(existsSync(spawnLog), false, 'a fresh cache must not touch the manager at all');
  } finally {
    stubServer.close();
  }
});
