import { mkdirSync, lstatSync, chmodSync } from 'node:fs';

/**
 * A directory only this user can see into, or an error.
 *
 * The transcript and rescue stores default to fixed names under `tmpdir()`.
 * On macOS that is a per-user folder, but on Linux it is the shared `/tmp`,
 * and `mkdirSync(..., { recursive: true, mode: 0o700 })` succeeds silently on a
 * directory that already exists, without applying the mode or checking whose
 * it is. Another local account could create `/tmp/kronk-cli-rescue` first and
 * then own every record written into it: read the prompts, swap a record for
 * one of its own, or replace a record with a symlink so the next write
 * truncates a file elsewhere in this user's home.
 *
 * So the directory is checked after it is made: a real directory, not a
 * symlink, owned by this user, with no group or other bits. One that is ours but
 * too open is tightened. One that is not ours is refused, because nothing
 * written into it can be kept private. Windows has no uid and a per-user temp
 * directory, so the ownership half is skipped there.
 *
 * `create: false` is the read-side check. A directory that does not exist yet
 * holds nothing to distrust, so that returns quietly.
 */
export function privateDir(dir, { create = true } = {}) {
  if (create) mkdirSync(dir, { recursive: true, mode: 0o700 });
  let st;
  try { st = lstatSync(dir); } catch (e) {
    if (!create && e.code === 'ENOENT') return dir;
    throw e;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new Error(`refusing to use ${dir}: not a plain directory`);
  }
  if (typeof process.getuid === 'function') {
    if (st.uid !== process.getuid()) {
      throw new Error(`refusing to use ${dir}: it belongs to another user`);
    }
    if (st.mode & 0o077) chmodSync(dir, 0o700);
  }
  return dir;
}
