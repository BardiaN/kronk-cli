/**
 * "A newer kronk-cli is available" — asked of the package manager that put
 * this copy on disk, never of the network directly. `test/egress.test.js`
 * forbids `fetch` to anything but the configured Kronk host and forbids a raw
 * `node:http` import; this module respects both by going through `npm`,
 * `brew` and `git` subprocesses the same way `src/setup.js` goes through
 * `kronk` — a manager knows the version graph for the thing it manages, and
 * asking it is the whole point of the issue this module exists for.
 *
 * It is a fifth entry in the `child_process` allowlist that test enforces,
 * alongside `context.js`, `mcp.js`, `setup.js` and `tools.js`. It earns its
 * own entry rather than borrowing one of theirs: `setup.js`'s door is
 * `runKronk`, which only ever spawns the `kronk` binary, and reusing it here
 * would mean either widening what that door lets through or lying about what
 * command is actually running. `context.js` spawns `git` too, but only ever
 * `-C <the user's project>` to describe *their* repository for the system
 * prompt — pointing it at kronk-cli's own install directory to ask a
 * different question would overload what that module is for. A dedicated
 * module keeps each spawner's job legible from its name, which is what the
 * allowlist is trying to preserve in the first place.
 *
 * Never on the path that blocks the prompt. `updateStatus` reads a small
 * cache file synchronously (cheap, local, not a subprocess) and returns
 * immediately; when that cache is missing or a day or more old it also kicks
 * off `refreshCliUpdate` for next time, deliberately unawaited. A stale line
 * shown instantly beats a fresh one that made the REPL wait for `npm view` to
 * come back over whatever network the machine has today.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { config } from './config.js';
import { VERSION } from './version.js';

const execFileAsync = promisify(execFile);

/**
 * Run a manager and let go of it.
 *
 * `unref` is the whole reason this wrapper exists. `updateStatus` fires the
 * refresh deliberately unawaited, and a live child keeps a handle on the event
 * loop: without it, quitting the REPL in the first few seconds of a session
 * prints "bye" and then sits there until `npm view` answers or the timeout
 * kills it. A cache written for next time is never worth delaying this exit
 * for — if the answer is lost because the process went away, the next session
 * simply asks again.
 */
function exec(cmd, argv) {
  const p = execFileAsync(cmd, argv, { timeout: CHECK_TIMEOUT_MS });
  p.child?.unref?.();
  return p;
}

/** A cold `npm view` or `brew outdated` over a slow link still has to give up. */
const CHECK_TIMEOUT_MS = 4000;

/** "At most once a day" from the issue, in milliseconds. */
const DAY_MS = 24 * 60 * 60 * 1000;

/** What `packaging/install.sh` leaves behind. The only record that route has. */
const RECEIPT = '.install-receipt.json';

const HINTS = {
  brew: 'brew upgrade kronk-cli',
  npm: 'npm install -g kronk-cli@latest',
  git: 'git pull',
};

// ---- install-route detection --------------------------------------------

/**
 * How far up from the running file to look for a `.git` before giving up on
 * calling this a checkout. `src/index.js` is one level under the repository
 * root in every layout this project ships or is developed in; the extra
 * headroom is for a checkout nested a few directories deeper than that.
 */
const GIT_SEARCH_DEPTH = 6;

function findGitRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < GIT_SEARCH_DEPTH; i++) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

const toPosix = (p) => p.split(sep).join('/');

/**
 * Where this running copy of kronk-cli came from, read off the path Node
 * resolved for `src/index.js` rather than asked of any registry — the issue's
 * own framing: "detect the route from where the running src/index.js
 * resolves". Each package manager lays its files out in a shape distinctive
 * enough to tell apart without guessing:
 *
 *   - Homebrew nests a formula's version under `Cellar/<name>/<version>`.
 *   - npm's global install nests every package under `lib/node_modules`.
 *   - `packaging/install.sh` has exactly one job — unpack straight into
 *     `$PREFIX/lib/kronk-cli` — and that shape is otherwise unclaimed.
 *   - A git checkout is the one route that carries its own `.git` upward
 *     from wherever the file sits, so it is checked by content rather than by
 *     path shape.
 *
 * Path shape alone is only suggestive, so the routes that can produce
 * *evidence* are asked first, and the install script's receipt is evidence of
 * exactly the same rank as a `.git` directory. That ordering is not a detail:
 * `install.sh` defaults to `$PREFIX=$HOME/.local`, a great many people keep
 * `$HOME` itself under version control for their dotfiles, and walking up
 * from `~/.local/lib/kronk-cli/src` reaches `~/.git` well inside
 * `GIT_SEARCH_DEPTH`. Asking for the `.git` first would tell every one of
 * those people to run `git pull` to upgrade a tarball install — precisely the
 * failure the issue means by "the hint must match how it was installed, or it
 * is worse than nothing". With no receipt there is nothing to go on but the
 * path, and then a `.git` ancestor is the better guess and wins.
 *
 * Returns null when none of the above matches — a shape this function was
 * never taught, which is the honest answer, not a guess dressed as one.
 */
export function detectInstall(entryPath) {
  const norm = toPosix(entryPath);
  if (/\/Cellar\/kronk-cli\//.test(norm)) return { route: 'brew' };
  if (/\/node_modules\/kronk-cli(\/|$)/.test(norm)) return { route: 'npm' };

  const libDir = /\/lib\/kronk-cli\//.test(norm) ? dirname(dirname(entryPath)) : null;
  if (libDir && existsSync(join(libDir, RECEIPT))) return { route: 'install-sh', dir: libDir };

  const gitRoot = findGitRoot(dirname(entryPath));
  if (gitRoot) return { route: 'git', dir: gitRoot };

  if (libDir) return { route: 'install-sh', dir: libDir };
  return null;
}

// ---- the cache ------------------------------------------------------------

function readCache(path) {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    return typeof data?.checkedAt === 'number' ? data : null;
  } catch {
    // Missing, unreadable, or not JSON — treated exactly like "never checked",
    // which is what it functionally is. A corrupt cache must never crash the
    // one thing on the startup path that is supposed to be purely cosmetic.
    return null;
  }
}

function writeCache(path, data) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(data), 'utf8');
  } catch {
    // The cache is a convenience, not the check itself — losing this write
    // only means the next session asks again instead of reading an answer.
  }
}

// ---- semver, just enough of it --------------------------------------------

/** `a` and `b` as dotted numeric components; a leading `v` is not data. */
function isNewer(current, latest) {
  if (!latest) return false;
  const a = current.replace(/^v/, '').split('.').map(Number);
  const b = latest.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return false;   // an unparseable
    if (y > x) return true;                                 // component is
    if (y < x) return false;                                // "no opinion"
  }
  return false;
}

// ---- asking each manager ---------------------------------------------------

async function npmLatest() {
  try {
    const { stdout } = await exec('npm', ['view', 'kronk-cli', 'version']);
    const v = stdout.trim();
    return /^\d+\.\d+\.\d+/.test(v) ? v : null;
  } catch {
    return null;
  }
}

async function brewLatest() {
  try {
    const { stdout } = await exec('brew', ['outdated', '--json']);
    const data = JSON.parse(stdout);
    // Absent means "not outdated", which is not a failure — most days this
    // is the answer, and it renders exactly like "nothing to report".
    return data.formulae?.find((f) => f.name === 'kronk-cli')?.current_version ?? null;
  } catch {
    return null;
  }
}

/**
 * `git fetch --tags` is the one network call this module makes through a
 * manager rather than being blocked outright — the issue asks for it by
 * name ("though the fetch is a network call made through git and should
 * follow the same off-switch as the rest"), which `refreshCliUpdate`'s
 * `config.updateCheck` guard already covers before this is ever called.
 */
async function gitLatest(dir) {
  try {
    await exec('git', ['-C', dir, 'fetch', '--tags', '--quiet']);
    const { stdout } = await exec('git', ['-C', dir, 'tag', '--sort=-v:refname']);
    return stdout.split('\n').map((l) => l.trim()).find(Boolean) ?? null;
  } catch {
    return null;
  }
}

async function latestForRoute(route, dir) {
  if (route === 'brew') return brewLatest();
  if (route === 'npm') return npmLatest();
  if (route === 'git') return gitLatest(dir);
  return null;
}

/**
 * The install script leaves no record of where a copy came from unless it
 * chose to write one — see `packaging/install.sh`'s receipt. Its presence is
 * the only thing this route can honestly report: not a version comparison
 * (there is no registry to ask), just a nudge to re-run the same script,
 * exactly as the issue specifies: "without claiming to know whether a newer
 * release exists". No cache, no subprocess — a receipt is either sitting
 * next to this install or it is not.
 */
function installScriptHint(install) {
  if (!existsSync(join(install.dir, RECEIPT))) return null;
  return { current: VERSION, hint: 're-run the install script' };
}

/**
 * Ask the detected manager what the newest kronk-cli is, and cache the
 * answer. Exported so a test can await it directly; `updateStatus` below
 * fires it without awaiting, which is the shape the startup path actually
 * uses.
 */
export async function refreshCliUpdate({ entryPath = process.argv[1], install, cacheFile = config.updateCacheFile } = {}) {
  const found = install ?? detectInstall(entryPath);
  const cache = { checkedAt: Date.now(), cli: null };
  if (found && found.route !== 'install-sh') {
    // A git tag is conventionally `v0.8.1`; npm and Homebrew both answer in
    // bare `0.8.1`. Stripped here, once, so the banner's arrow reads as one
    // version pointing at another and not at a spelling difference.
    const latest = (await latestForRoute(found.route, found.dir))?.replace(/^v/, '') ?? null;
    if (isNewer(VERSION, latest)) {
      cache.cli = { current: VERSION, latest, hint: HINTS[found.route] };
    }
  }
  writeCache(cacheFile, cache);
  return cache.cli;
}

/**
 * What the startup banner should say about kronk-cli's own version, decided
 * without ever making the REPL wait for it.
 *
 * `KRONK_UPDATE_CHECK=false` (or the matching config key) turns the whole
 * thing off: no cache read, no subprocess, ever — for anyone who wants a
 * program that runs nothing it was not asked to run.
 */
export function updateStatus({
  entryPath = process.argv[1], now = Date.now(), cacheFile = config.updateCacheFile,
} = {}) {
  if (!config.updateCheck) return null;

  const install = detectInstall(entryPath);
  if (!install) return null;

  if (install.route === 'install-sh') {
    const hint = installScriptHint(install);
    return hint ? { cli: hint } : null;
  }

  const cache = readCache(cacheFile);
  const stale = !cache || now - cache.checkedAt >= DAY_MS;
  if (stale) {
    // Next session's answer, not this one's wait.
    refreshCliUpdate({ entryPath, install, cacheFile }).catch(() => {});
  }
  return cache?.cli ? { cli: cache.cli } : null;
}
