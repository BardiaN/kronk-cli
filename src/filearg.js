import { readdir, stat } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import { homedir } from 'node:os';
import { IMAGE_EXTENSIONS, sniffMime } from './image.js';
import { safe, session } from './tools.js';

/**
 * Turn what the user typed after `/file` into a path that can be opened.
 *
 * A path pasted from a terminal or Finder arrives wrapped in quotes when it
 * has spaces; macOS hides `.png` on screenshots and puts U+202F (a narrow
 * no-break space) before "AM"/"PM" in their names, which no one types. All of
 * that is forgiven here, and every guess is either unique or refused.
 */

/** One surrounding pair of single or double quotes, once. */
export function unquote(arg) {
  const s = String(arg).trim();
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s.at(-1) === s[0]) return s.slice(1, -1);
  return s;
}

/** `~` and `~/x` to the home directory. `~user` is left alone. */
export function expandHome(p, home = homedir()) {
  if (p === '~') return home;
  if (p.startsWith('~/')) return join(home, p.slice(2));
  return p;
}

/** A file name with every kind of space made a plain one, and NFC-normalised. */
export function normName(name) {
  return String(name).normalize('NFC').replace(/[\s\u202f\u00a0\u2007]/g, ' ');
}

/**
 * The names in `entries` that `typed` can mean: the same name once spaces are
 * normalised, or — when `typed` has no image extension — that name plus one.
 */
export function matchNames(typed, entries) {
  const want = normName(typed).toLowerCase();
  const withExt = IMAGE_EXTENSIONS.some((x) => want.endsWith(x)) ? [] : IMAGE_EXTENSIONS;
  const exact = [];
  const extended = [];
  for (const e of entries) {
    const n = normName(e).toLowerCase();
    if (n === want) exact.push(e);
    else if (withExt.some((x) => n === want + x)) extended.push(e);
  }
  return exact.length ? exact : extended;
}

const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };
const listDir = async (d) => { try { return await readdir(d); } catch { return []; } };

/** Find the typed name in one directory: the literal file first, then the forgiving matches. */
async function findIn(dir, name) {
  const literal = join(dir, name);
  if (await exists(literal)) return [literal];
  return matchNames(name, await listDir(dir)).map((e) => join(dir, e));
}

/**
 * Resolve a `/file` argument. Returns `{ path, note }` (`note` says what was
 * assumed), or throws an Error whose message is fit to print.
 *
 * `cwd`, `root` and `home` are parameters so tests need not touch the process.
 */
export async function resolveFileArg(arg, { cwd = session.cwd, root = session.root, home = homedir() } = {}) {
  const typed = expandHome(unquote(arg), home);
  if (!typed) throw new Error('usage: /file <path>');
  const abs = resolve(cwd, typed);
  const outside = (p) => new Error(`${p} is outside the launch folder (${root}); /file only reads inside it`);
  try { safe(abs); } catch { throw outside(abs); }

  const hits = await findIn(dirname(abs), basename(abs));
  if (hits.length === 1) {
    try { safe(hits[0]); } catch { throw outside(hits[0]); }
    return { path: hits[0], note: hits[0] === abs ? null : `using ${hits[0]}` };
  }
  if (hits.length > 1) {
    throw new Error(`${abs} is ambiguous; it could be ${hits.map((h) => basename(h)).join(', ')} — type the full name`);
  }

  // Nothing here. Say where we looked, and offer (never use) a same-named
  // file one level down: Desktop, Downloads and so on.
  let msg = `not found: ${abs}`;
  if (!extname(abs)) msg += ` (also tried ${IMAGE_EXTENSIONS.join(' ')})`;
  msg += `\n  relative paths resolve against ${cwd}`;
  const near = [];
  for (const d of await listDir(root)) {
    if (d.startsWith('.') || d === 'node_modules') continue;
    const sub = join(root, d);
    if (sub === dirname(abs)) continue;
    for (const h of await findIn(sub, basename(abs))) near.push(relative(root, h));
    if (near.length >= 3) break;
  }
  if (near.length) msg += `\n  Did you mean ${near.slice(0, 3).join(', ')}?`;
  throw new Error(msg);
}

/** What a file's bytes are: an `image`, `text` (valid UTF-8, no NULs) or `binary`. */
export function classifyBytes(buf) {
  if (sniffMime(buf)) return 'image';
  if (buf.includes(0)) return 'binary';
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return 'text';
  } catch { return 'binary'; }
}
