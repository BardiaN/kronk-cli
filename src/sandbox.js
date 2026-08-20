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
 * Credentials the agent has no reason to read. This is a deny-list, so it is
 * only as good as its entries — the write confinement below is the part that
 * holds categorically. Reads stay open by default because denying them wholesale
 * breaks every compiler, linter and runtime the agent needs.
 */
const SECRET_DIRS = [
  '.ssh', '.aws', '.gnupg', '.kube', '.docker', '.azure',
  '.config/gh', '.config/gcloud', '.config/doctl',
  'Library/Keychains',
];

const SECRET_FILES = ['.npmrc', '.netrc', '.pypirc', '.git-credentials'];

/** Seatbelt string literals are double-quoted; only `\` and `"` need escaping. */
const sb = (p) => `"${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * Allow everything, then take away writes outside the project and reads of
 * credential stores. Starting from `(deny default)` would mean enumerating every
 * dylib, locale file and device node a toolchain touches, and getting that wrong
 * fails closed in ways that look like a broken CLI rather than a blocked write.
 */
export function seatbeltProfile({ root, home, tmp }) {
  const writable = [root, '/dev', '/private/tmp', '/private/var/tmp', '/private/var/folders', '/tmp']
    .concat(tmp ? [tmp] : [])
    .concat(CACHE_DIRS.map((d) => join(home, d)));

  return [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* ${writable.map((p) => `(subpath ${sb(p)})`).join(' ')})`,
    `(deny file-read* ${SECRET_DIRS.map((d) => `(subpath ${sb(join(home, d))})`).join(' ')} `
      + `${SECRET_FILES.map((f) => `(literal ${sb(join(home, f))})`).join(' ')})`,
  ].join('\n');
}

/** bubblewrap equivalent: rebind the project read-write inside a read-only home. */
export function bwrapArgs({ root, home, cwd }) {
  const args = ['--die-with-parent', '--dev-bind', '/', '/'];

  // Order matters: each bind overrides the ones before it, so home goes
  // read-only first and the project and caches are handed back afterwards.
  if (existsSync(home)) args.push('--ro-bind', home, home);
  args.push('--bind', root, root, '--bind', '/tmp', '/tmp');

  for (const d of CACHE_DIRS) {
    const p = join(home, d);
    if (existsSync(p)) args.push('--bind', p, p);
  }
  // A tmpfs makes a credential directory exist but be empty; /dev/null over a
  // file makes it readable and empty. Both beat a missing path, which tools
  // report as a confusing ENOENT rather than an obvious denial.
  for (const d of SECRET_DIRS) {
    const p = join(home, d);
    if (existsSync(p) && statSync(p).isDirectory()) args.push('--tmpfs', p);
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
export function sandboxArgv(script, { backend, root, home, cwd, tmp }) {
  if (backend === 'seatbelt') {
    return ['sandbox-exec', ['-p', seatbeltProfile({ root, home, tmp }), 'bash', '-c', script]];
  }
  if (backend === 'bwrap') {
    return ['bwrap', [...bwrapArgs({ root, home, cwd }), '-c', script]];
  }
  return ['bash', ['-c', script]];
}
