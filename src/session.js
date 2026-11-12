import {
  writeFileSync, renameSync, readFileSync, readdirSync, statSync, rmSync,
} from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { config } from './config.js';
import { privateDir } from './privateDir.js';

/**
 * The store behind `--resume`, `--sessions` and `/resume`: one JSON file per
 * REPL session, grouped in a folder per launch directory, so "the last session
 * here" is a directory listing rather than a search.
 *
 * It lives beside the transcript and rescue stores and is held to the same
 * rule — the conversation is the user's prompts and the contents of their
 * files — so every directory goes through src/privateDir.js and every file is
 * 0600. Unlike them it does not default under `tmpdir()`: a session is meant
 * to be resumed later, and the OS may clear the temp dir first. It lives in the
 * per-user state directory instead, on every platform; `KRONK_SESSION_DIR`
 * moves it.
 *
 * The system message is never stored. A resumed session keeps the prompt and
 * project primer this launch built, which is the one that matches the current
 * mode and working tree, and the file stays free of a copy of AGENTS.md.
 */

/**
 * `$XDG_STATE_HOME/kronk-cli/sessions`, else `~/.local/state/kronk-cli/sessions`.
 * A relative XDG_STATE_HOME is ignored, as the spec says to.
 */
export function defaultRoot(env = process.env, home = homedir()) {
  const xdg = env.XDG_STATE_HOME;
  const base = xdg && isAbsolute(xdg) ? xdg : join(home, '.local', 'state');
  return join(base, 'kronk-cli', 'sessions');
}

export const ROOT = () => config.sessionDir ?? defaultRoot();

/** How many sessions a launch directory keeps; the oldest beyond it are deleted. */
export const KEEP = 20;

const ID = /^[0-9a-z]+-[0-9a-f]{6}$/;
export const isSessionId = (id) => typeof id === 'string' && ID.test(id);

/** `<base36 time>-<6 hex>`: sorts by age, and the random part stops two launches in one millisecond colliding. */
export const newSessionId = () => `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;

/** The folder name for a launch directory: a hash, so no path ever becomes part of a path. */
export const dirKey = (cwd) => createHash('sha256').update(cwd).digest('hex').slice(0, 16);

const dirFor = (cwd, root) => join(root, dirKey(cwd));

/** Turns are the user's messages: that is what the person typed or attached. */
export const countTurns = (messages) => messages.filter((m) => m?.role === 'user').length;

/** Nothing is worth saving until the user has said something. */
export const hasConversation = (messages) => countTurns(messages) > 0;

/** The messages after the system prompt, in the shape that is safe to store. */
export const storable = (messages) => messages.filter((m) => m && m.role !== 'system');

/**
 * A resumed conversation: the *current* system message followed by the saved
 * ones. Anything in the file that claims to be a system message is dropped, so
 * a doctored file cannot replace the instructions.
 */
export function restoreMessages(current, saved) {
  return [current[0], ...saved.filter((m) => m && typeof m.role === 'string' && m.role !== 'system')];
}

/** Atomic: a crash mid-write leaves the previous save, never half of a new one. */
export function saveSession(record, { cwd = process.cwd(), root = ROOT(), keep = KEEP } = {}) {
  if (!isSessionId(record.id)) throw new Error(`not a session id: ${record.id}`);
  const dir = dirFor(cwd, root);
  privateDir(root);
  privateDir(dir);
  const final = join(dir, `${record.id}.json`);
  const tmp = join(dir, `.${record.id}.${randomBytes(3).toString('hex')}.tmp`);
  try {
    writeFileSync(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    renameSync(tmp, final);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  prune(cwd, { root, keep });
  return final;
}

/** A save the REPL can attempt every turn: a full disk must not end the conversation. */
export function trySave(record, opts) {
  try { saveSession(record, opts); return true; } catch { return false; }
}

function read(file) {
  try {
    const r = JSON.parse(readFileSync(file, 'utf8'));
    return isSessionId(r?.id) && Array.isArray(r.messages) ? r : null;
  } catch { return null; }
}

/** Newest first, by last save. Unreadable or foreign files are skipped, not guessed at. */
export function listSessions(cwd = process.cwd(), { root = ROOT() } = {}) {
  let names;
  try { privateDir(root, { create: false }); names = readdirSync(dirFor(cwd, root)); } catch { return []; }
  return names
    .filter((n) => n.endsWith('.json'))
    .map((n) => read(join(dirFor(cwd, root), n)))
    .filter(Boolean)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || (a.id < b.id ? 1 : -1));
}

/**
 * One session: the newest when `id` is omitted, otherwise an exact id or an
 * unambiguous prefix of one. Null for none, and for a prefix that fits several.
 */
export function findSession(cwd, id, opts) {
  const all = listSessions(cwd, opts);
  if (id === undefined || id === null || id === '') return all[0] ?? null;
  const exact = all.find((s) => s.id === id);
  if (exact) return exact;
  const hits = all.filter((s) => s.id.startsWith(id));
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Session files in this launch folder that exist but cannot be used (not JSON,
 * wrong shape). `listSessions` skips them silently; `--resume` should not.
 */
export function unreadableSessions(cwd = process.cwd(), { root = ROOT() } = {}) {
  let names;
  try { privateDir(root, { create: false }); names = readdirSync(dirFor(cwd, root)); } catch { return []; }
  return names
    .filter((n) => n.endsWith('.json'))
    .map((n) => join(dirFor(cwd, root), n))
    .filter((f) => read(f) === null);
}

/**
 * The folder a session id was saved under, when it is not `cwd`: an exact id or
 * a unique prefix, looked up across every launch folder. Null when nothing (or
 * more than one session) matches. `folder` is null for a record written before
 * the folder was stored.
 */
export function sessionElsewhere(cwd, id, { root = ROOT() } = {}) {
  if (!id) return null;
  let dirs;
  try { privateDir(root, { create: false }); dirs = readdirSync(root); } catch { return null; }
  const hits = [];
  for (const d of dirs) {
    if (d === dirKey(cwd)) continue;
    let names;
    try { names = readdirSync(join(root, d)); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      const r = read(join(root, d, n));
      if (r && r.id.startsWith(id)) hits.push(r);
    }
  }
  const exact = hits.filter((r) => r.id === id);
  const pick = exact.length ? exact : hits;
  return pick.length === 1 ? { id: pick[0].id, folder: typeof pick[0].cwd === 'string' ? pick[0].cwd : null } : null;
}

/** Delete everything past the newest `keep`. Returns how many went. */
export function prune(cwd, { root = ROOT(), keep = KEEP } = {}) {
  const dir = dirFor(cwd, root);
  let names;
  try { names = readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return 0; }
  const aged = names.map((n) => {
    try { return { n, t: statSync(join(dir, n)).mtimeMs }; } catch { return { n, t: 0 }; }
  }).sort((a, b) => b.t - a.t || (a.n < b.n ? 1 : -1));
  let removed = 0;
  for (const { n } of aged.slice(keep)) {
    try { rmSync(join(dir, n), { force: true }); removed += 1; } catch { /* leave it for next time */ }
  }
  return removed;
}

const two = (n) => String(n).padStart(2, '0');

/** `2026-11-11 14:05`, local time — what someone scanning a list recognises. */
export function fmtWhen(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'unknown date';
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** The one-line summary: date, turns, model. */
export function summary(s) {
  const turns = s.turns ?? countTurns(s.messages);
  return `${fmtWhen(s.updatedAt)} · ${turns} ${turns === 1 ? 'turn' : 'turns'} · ${s.model ?? 'unknown model'}`;
}

/** The first thing the user said, trimmed to one line, so a list says what each session was about. */
export function firstPrompt(s, width = 60) {
  const m = s.messages.find((x) => x?.role === 'user' && typeof x.content === 'string');
  const text = (m?.content ?? '').replace(/\s+/g, ' ').trim();
  return text.length > width ? `${text.slice(0, width - 1)}…` : text;
}

/** Numbered lines for `--sessions` and `/resume`: `1  <id>  <summary>  <first prompt>`. */
export function listLines(sessions) {
  return sessions.map((s, i) => `${String(i + 1).padStart(2)}  ${s.id}  ${summary(s)}  ${firstPrompt(s)}`);
}
