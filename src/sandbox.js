import { existsSync, statSync } from 'node:fs';
import { join, delimiter } from 'node:path';

/**
 * OS-level confinement for `bash`.
 *
 * The file tools resolve paths and refuse to leave the launch root, but `bash`
 * had no such guard: `cat ~/.ssh/id_rsa` ran fine, and the README called the
 * launch root a sandbox anyway. A path check in JavaScript cannot constrain a
 * process it has already handed the whole machine to, so the confinement has to
 * come from the kernel.
 *
 * This module is pure — it builds an argv and nothing else. Spawning stays in
 * the tool layer, which is the only place allowed to start processes.
 */

/** Directories a build legitimately writes to outside the project. */
const CACHE_DIRS = ['.npm', '.cache', '.yarn', '.pnpm-store', 'Library/Caches'];

/**
 * Key material the agent has no reason to read, and that no build step needs.
 *
 * This list was once wider — it covered `~/.kube`, `~/.aws`, `~/.config/gh` and
 * friends. That broke `kubectl`, `gh` and anything else the user had already
 * logged in to, while still missing tools nobody thought of (`argocd` keeps its
 * token in `~/.config/argocd`, and sailed straight through). A deny-list that
 * blocks the tools you use and misses the ones you forgot is worse than an
 * honest boundary: it costs real work and buys little, because an attacker
 * exfiltrates whichever credential store was not on it.
 *
 * So the default is narrow and covers material that is pivot-grade and never
 * legitimately read by a build. Session tokens for CLIs you are already logged
 * in to stay readable — add them with KRONK_SANDBOX_DENY if your threat model
 * wants them gone, at the cost of those commands failing.
 *
 * The write confinement is the half that holds categorically. This half is
 * best-effort, and the README says so.
 */
const SECRET_DIRS = ['.ssh', '.gnupg', '.password-store', 'Library/Keychains'];

const SECRET_FILES = ['.npmrc', '.netrc', '.pypirc', '.git-credentials'];

/** `A:B` or `A,B`, absolute or `~`-relative. Empty entries are dropped. */
export function extraPaths(value, home) {
  return (value ?? '')
    .split(/[:,]/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => (p.startsWith('~/') ? join(home, p.slice(2)) : p));
}

/** Seatbelt string literals are double-quoted; only `\` and `"` need escaping. */
const sb = (p) => `"${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * Allow everything, then take away writes outside the project and reads of
 * credential stores. Starting from `(deny default)` would mean enumerating every
 * dylib, locale file and device node a toolchain touches, and getting that wrong
 * fails closed in ways that look like a broken CLI rather than a blocked write.
 */
export function seatbeltProfile({ root, home, tmp, allow = [], deny = [] }) {
  const writable = [root, '/dev', '/private/tmp', '/private/var/tmp', '/private/var/folders', '/tmp']
    .concat(tmp ? [tmp] : [])
    .concat(CACHE_DIRS.map((d) => join(home, d)))
    .concat(allow);

  // ALLOW means "this path is fully available", so it also lifts a default
  // denial. Without that there is no way to run a keychain-backed CLI like `gh`
  // short of turning the sandbox off entirely, which is a worse trade.
  const unreadable = SECRET_DIRS.map((d) => join(home, d)).concat(deny)
    .filter((d) => !allow.some((a) => d === a || d.startsWith(`${a}/`)));

  return [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* ${writable.map((p) => `(subpath ${sb(p)})`).join(' ')})`,
    `(deny file-read* ${unreadable.map((d) => `(subpath ${sb(d)})`).join(' ')} `
      + `${SECRET_FILES.map((f) => `(literal ${sb(join(home, f))})`).join(' ')})`,
  ].join('\n');
}

/** bubblewrap equivalent: rebind the project read-write inside a read-only home. */
export function bwrapArgs({ root, home, cwd, allow = [], deny = [] }) {
  const args = ['--die-with-parent', '--dev-bind', '/', '/'];

  // Order matters: each bind overrides the ones before it, so home goes
  // read-only first and the project and caches are handed back afterwards.
  if (existsSync(home)) args.push('--ro-bind', home, home);
  args.push('--bind', root, root, '--bind', '/tmp', '/tmp');

  for (const d of CACHE_DIRS.map((x) => join(home, x)).concat(allow)) {
    if (existsSync(d)) args.push('--bind', d, d);
  }
  // A tmpfs makes a credential directory exist but be empty; /dev/null over a
  // file makes it readable and empty. Both beat a missing path, which tools
  // report as a confusing ENOENT rather than an obvious denial.
  const hidden = SECRET_DIRS.map((x) => join(home, x)).concat(deny)
    .filter((d) => !allow.some((a) => d === a || d.startsWith(`${a}/`)));
  for (const d of hidden) {
    if (existsSync(d) && statSync(d).isDirectory()) args.push('--tmpfs', d);
  }
  for (const f of SECRET_FILES) {
    const p = join(home, f);
    if (existsSync(p)) args.push('--ro-bind', '/dev/null', p);
  }

  return args.concat('--chdir', cwd, 'bash');
}

/** First match in PATH, without shelling out to `which`. */
export function onPath(bin, { env = process.env } = {}) {
  return (env.PATH ?? '').split(delimiter).some((d) => d && existsSync(join(d, bin)));
}

/**
 * Which backend this machine can offer, before we know whether it works.
 * `KRONK_SANDBOX=off` skips confinement; `strict` refuses to run unconfined.
 */
export function detectBackend({ platform = process.platform, env = process.env } = {}) {
  if ((env.KRONK_SANDBOX ?? 'auto') === 'off') return 'none';
  if (platform === 'darwin' && onPath('sandbox-exec', { env })) return 'seatbelt';
  if (platform === 'linux' && onPath('bwrap', { env })) return 'bwrap';
  return 'none';
}

/**
 * Build the argv that runs `script` under `backend`.
 * Returns `['bash', ['-c', script]]` shaped output for spawn().
 */
export function sandboxArgv(script, { backend, root, home, cwd, tmp, env = process.env }) {
  const allow = extraPaths(env.KRONK_SANDBOX_ALLOW, home);
  const deny = extraPaths(env.KRONK_SANDBOX_DENY, home);

  if (backend === 'seatbelt') {
    return ['sandbox-exec',
      ['-p', seatbeltProfile({ root, home, tmp, allow, deny }), 'bash', '-c', script]];
  }
  if (backend === 'bwrap') {
    return ['bwrap', [...bwrapArgs({ root, home, cwd, allow, deny }), '-c', script]];
  }
  return ['bash', ['-c', script]];
}
