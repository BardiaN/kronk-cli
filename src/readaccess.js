import { dirname, isAbsolute, relative, sep } from 'node:path';

/**
 * Read-only access to paths outside the launch folder, as a pure decision.
 *
 * The file tools used to refuse anything above the launch root outright, and a
 * model told "refusing to touch path outside" answers the user with "copy the
 * file into this folder". The right answer is to ask. This module decides
 * what happens to one path; src/tools.js holds the session state it reads,
 * src/agent.js asks the question, and src/index.js owns the terminal.
 *
 * Only reads come through here. `write_file`, `edit_file` and `bash` stay
 * confined by `safe()` and the sandbox exactly as before, and nothing in this
 * file can widen either.
 */

/** Whether `child` is `parent` or lives under it. Both must be absolute and resolved. */
export function within(child, parent, ci = false) {
  const rel = ci ? relative(parent.toLowerCase(), child.toLowerCase()) : relative(parent, child);
  if (rel === '') return true;
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * The credential store `abs` touches, or null. `ci` compares without case, for
 * the filesystems (APFS, NTFS by default) where `.SSH` is `.ssh`.
 *
 * Only the store itself or something inside it counts: listing a directory that
 * merely contains one names an entry and reveals no key material. A `search`
 * that walks past one is told to leave it out instead (`secretsUnder`).
 */
export function secretHit(abs, kind, secrets, ci = false) {
  for (const s of secrets) {
    if (within(abs, s, ci)) return s;
  }
  return null;
}

/** The credential stores that sit strictly below `abs`, for a search to skip. */
export function secretsUnder(abs, secrets, ci = false) {
  return secrets.filter((s) => s !== abs && within(s, abs, ci));
}

/**
 * The directory a "folder for this session" answer would grant: the one
 * containing a file, or the directory itself for a listing or a search. Null
 * when that would be the whole filesystem, which is never offered.
 */
export function grantFolder(abs, kind, isDir) {
  const dir = kind === 'read_file' || !isDir ? dirname(abs) : abs;
  return dir === dirname(dir) ? null : dir;
}

/**
 * The verdict for one outside-the-root read.
 *
 * `action` is `allow`, `ask` or `refuse`, `reason` says why. The order is the
 * policy: inside the root is untouched; a credential store is refused before any
 * grant is consulted, so no answer to a prompt can reach one; then what the
 * user already said (granted, declined); and only a path nobody has ruled on is
 * asked about, and only when there is someone to ask.
 *
 * `folders` are real directories granted for the session (subpaths included),
 * `files` are single files the user attached with /file, `once` is the path the
 * user just said yes to for this one call. Every path is already resolved
 * through symlinks, so a link into a granted folder is covered and a link out
 * of one is not.
 */
export function decideRead({
  abs, kind = 'read_file', root, folders = [], files = [], once = [],
  declined = [], secrets = [], interactive = false, ci = false,
}) {
  // Before the launch root, not after: launching in the home folder makes
  // ~/.ssh "inside", and being inside is not a reason to read key material.
  if (secretHit(abs, kind, secrets, ci)) return { action: 'refuse', reason: 'secret' };
  if (within(abs, root)) return { action: 'allow', reason: 'inside' };
  if (files.includes(abs) || once.includes(abs) || folders.some((f) => within(abs, f))) {
    return { action: 'allow', reason: 'granted' };
  }
  if (declined.includes(abs)) return { action: 'refuse', reason: 'declined' };
  return interactive ? { action: 'ask', reason: 'outside' } : { action: 'refuse', reason: 'noninteractive' };
}

/** The line above the question. */
export const readPromptHead = (root, abs) => `read outside ${root}: ${abs}`;

/** What the question offers, given whether a folder can be granted. */
export function readPromptChoices(folder) {
  return folder
    ? `allow? [y] yes once · [f] the folder ${folder} for this session · [N] no `
    : 'allow? [y] yes once · [N] no ';
}

/** `yes`, `folder` or `no`; anything unrecognised is a no, and `f` is a no when no folder was offered. */
export function parseReadAnswer(text, folderOffered = true) {
  const a = String(text ?? '').trim().toLowerCase();
  if (a === 'y' || a === 'yes') return 'yes';
  if ((a === 'f' || a === 'folder') && folderOffered) return 'folder';
  return 'no';
}

/**
 * The tool result for a read that did not happen. Each tells the model what to
 * do next, because a bare refusal is read as "try again, differently".
 */
export function refusalText(reason, abs, root) {
  const where = `${abs} is outside the launch folder (${root})`;
  switch (reason) {
    case 'declined':
      return `the user declined to let you read ${abs}, which is outside the launch folder (${root}). `
        + 'Do not retry this path or ask for it again; carry on without it, or tell the user you could not read it.';
    case 'secret':
      return `${abs} is a credential store, which the file tools never read, wherever you were launched and whatever the user allows. `
        + 'Do not retry it.';
    default:
      return `${where}, and nobody is available to approve reading it. Do not retry this path. `
        + 'Tell the user to start kronk-cli in a folder that contains it, or to attach the file with '
        + '/file <path> at the interactive prompt.';
  }
}
