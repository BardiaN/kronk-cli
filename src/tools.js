import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, relative, dirname, basename, isAbsolute, join } from 'node:path';
import { realpathSync, mkdirSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { detectBackend, sandboxArgv, cacheDirs, secretPaths } from './sandbox.js';
import { decideRead, grantFolder, refusalText } from './readaccess.js';
import { config } from './config.js';
import { setPlan, MAX_ITEMS } from './plan.js';
import { c } from './ui.js';
import { loadImage, IMAGE_NOT_SHOWN } from './image.js';

const exec = promisify(execFile);
export const MAX_OUT = 30_000;
const MAX_CAPTURE = 400_000;                     // keep the tail of chatty builds
const TOOL_TIMEOUT = Number(process.env.KRONK_TOOL_TIMEOUT ?? 900) * 1000;   // 15 min

/**
 * One shell session for the whole run.
 *
 * Each bash call is a fresh `bash -c`, so a bare `cd` would evaporate and the
 * next command would silently run somewhere else — the model then flails,
 * re-running `pwd` and `cd` trying to work out where it is. We keep the cwd
 * here and hand it back to every subsequent call.
 */
export const session = {
  root: real(process.cwd()),
  cwd: real(process.cwd()),
  // Paths granted read-only to the sandbox for the rest of this run, and paths
  // the user was asked about and said no to. Both are needed: without
  // `declined`, a refusal would be re-asked on the very next command, which is
  // how a prompt trains people to stop reading it.
  //
  // The seatbelt profile is rebuilt per command — `runBash` calls `sandboxArgv`
  // every time — so adding to this set takes effect on the next command with no
  // restart. That is what makes asking at the moment of need possible at all.
  grants: new Set(config.sandboxReadable),
  declined: new Set(),
  // Read-only access outside the launch root, for this run only and never
  // written anywhere. `readFolders` are directories the user granted for the
  // session, `readFiles` are single files they attached with /file, and
  // `readDeclined` are paths they were asked about and refused. These are not
  // `grants`: that set lifts a sandbox denial for `bash`, this one lets the file
  // tools look, and neither may stand in for the other.
  readFolders: new Set(),
  readFiles: new Set(),
  readDeclined: new Set(),
};

/**
 * Credential stores a tool needs to read, and cannot reach under the sandbox.
 *
 * Deliberately tiny, and grown only on measurement. Under the denied profile on
 * macOS, `kubectl config current-context` and `aws configure list` both exit 0 —
 * their tokens live in their own config directories, which are readable — so
 * neither belongs here. `heroku` uses `~/.netrc` and `vault` uses
 * `~/.vault-token`; both are SECRET_FILES rather than SECRET_DIRS, and this
 * makes no file grantable, so neither belongs here either.
 *
 * A speculative entry would prompt for something that was never denied, which
 * is worse than not prompting: it teaches the user that the question is noise.
 */
export const CREDENTIAL_TOOLS = {
  gh: ['Library/Keychains'],        // verified: fails denied, succeeds granted
  docker: ['Library/Keychains'],    // unverified; credsStore: "desktop" uses the keychain
};

/**
 * Which known binaries a command line actually runs.
 *
 * Split on the separators that start a new command, then take the first token
 * of each segment after stepping over leading `NAME=value` assignments. That is
 * a heuristic and is meant to be: its only outputs are "ask" and "do not ask",
 * so a miss costs one un-asked question and a false hit costs one declined
 * prompt. It never rewrites, blocks or delays the command.
 *
 * `echo gh` must not match — `gh` is an argument there, not the command — and
 * neither must `mygh`, which is why the first token is compared whole.
 */
export function credentialMatches(cmd, home = homedir()) {
  const hits = new Map();
  for (const segment of String(cmd ?? '').split(/[;&|\n]+/)) {
    const tokens = segment.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
    if (!tokens[i]) continue;
    const bin = basename(tokens[i]);
    const paths = CREDENTIAL_TOOLS[bin];
    if (paths && !hits.has(bin)) hits.set(bin, paths.map((rel) => join(home, rel)));
  }
  return [...hits].map(([bin, paths]) => ({ bin, paths }));
}

/** Just the paths, deduplicated across however many tools matched. */
export function credentialPaths(cmd, home = homedir()) {
  return [...new Set(credentialMatches(cmd, home).flatMap((m) => m.paths))];
}

/**
 * The paths this command needs that are denied right now — nothing to ask about
 * when the sandbox is off, when they are already granted, or when the path does
 * not exist on this machine, which is what keeps Linux silent about a macOS
 * keychain.
 */
export function ungranted(cmd, { home = homedir(), backend = sandbox.backend } = {}) {
  if (backend === 'none' || backend === 'pending') return [];
  return credentialPaths(cmd, home)
    .filter((p) => !session.grants.has(p) && existsSync(p));
}

/**
 * What this command would need asking about: denied, not granted, and not
 * already refused this session. Empty means say nothing and run it.
 *
 * `declined` is filtered here rather than at the call site so that "ask at most
 * once per path per session" is one rule in one place, true of a refusal
 * exactly as it is of a grant.
 */
export function grantsNeeded(cmd, opts = {}) {
  return ungranted(cmd, opts).filter((p) => !session.declined.has(p));
}

/**
 * Record a grant, and optionally remember it past this session.
 *
 * Persisting is a read-modify-write of `~/.kronk-cli.json` rather than a
 * rewrite: the file is the user's, and it holds their model, their base URL and
 * whatever else they have set. Losing those to record a keychain path would be
 * a bad trade for a convenience feature. A file that cannot be parsed is left
 * alone and reported, never silently replaced.
 *
 * Returns the path written to, or null when nothing was persisted.
 */
export function rememberGrants(paths, { persist = false, home = homedir() } = {}) {
  for (const p of paths) {
    session.grants.add(p);
    session.declined.delete(p);
  }
  if (!persist || !paths.length) return null;

  const tilde = (p) => (p.startsWith(`${home}/`) ? `~/${p.slice(home.length + 1)}` : p);
  let current = {};
  try { current = JSON.parse(readFileSync(config.rcPath, 'utf8')); }
  catch (e) {
    if (e.code !== 'ENOENT') throw new Error(`${config.rcPath} is not valid JSON — leaving it alone`, { cause: e });
  }
  const merged = [...new Set([
    ...(Array.isArray(current.sandboxReadable) ? current.sandboxReadable : []),
    ...paths.map(tilde),
  ])];
  writeFileSync(config.rcPath, `${JSON.stringify({ ...current, sandboxReadable: merged }, null, 2)}\n`);
  return config.rcPath;
}

/** Remember a refusal, so the same command does not ask again this session. */
export function declineGrants(paths) {
  for (const p of paths) session.declined.add(p);
}

/**
 * Resolve symlinks before comparing paths.
 *
 * macOS maps /tmp and /var onto /private/*, so a shell reporting its own `pwd`
 * hands back a path that no longer looks like a child of the launch root. The
 * containment check then fails and `cd` silently stops persisting.
 */
function real(p) {
  try { return realpathSync.native(p); } catch { return p; }
}

/**
 * Resolve symlinks all the way down, including for a path that does not exist
 * yet.
 *
 * Comparing the textual path against the root let a symlink inside the project
 * point anywhere: `ln -s /etc/passwd notes` and then `read_file notes` passed
 * the containment check and read the target. Writes were worse — a symlinked
 * directory meant `write_file` landed outside the root entirely. So we resolve
 * the deepest ancestor that exists and re-attach the rest, which is the path the
 * filesystem will actually use.
 */
function realDeep(abs) {
  const tail = [];
  let cur = abs;
  for (;;) {
    try { return tail.length ? resolve(realpathSync.native(cur), ...tail) : realpathSync.native(cur); }
    catch { /* does not exist yet — walk up */ }
    const parent = dirname(cur);
    if (parent === cur) return abs;
    tail.unshift(basename(cur));
    cur = parent;
  }
}

/**
 * Trim from the MIDDLE, never the end.
 *
 * Build output puts its errors last, so head-only truncation silently dropped
 * exactly the lines that mattered and left 30k characters of progress chatter.
 */
export const clip = (s) => {
  if (s.length <= MAX_OUT) return s;
  const head = Math.floor(MAX_OUT * 0.3);
  const tail = MAX_OUT - head;
  const dropped = s.length - head - tail;
  return `${s.slice(0, head)}\n…[${dropped.toLocaleString()} chars elided from the middle]…\n${s.slice(-tail)}`;
};

/** Resolve against the session cwd, and keep the agent inside the launch root. */
export function safe(p) {
  const abs = realDeep(resolve(real(session.cwd), p));
  const rel = relative(real(session.root), abs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`refusing to touch path outside ${session.root}: ${p}`);
  }
  return abs;
}

/** `~` and `~/x` to the home directory; anything else untouched. */
const untilde = (p) => (p === '~' ? homedir() : String(p).startsWith('~/') ? join(homedir(), String(p).slice(2)) : p);

/**
 * Where a read-only tool call stands against the launch root, the session's
 * grants and the credential list. `interactive` says whether anyone could be
 * asked, which turns an unruled path from a refusal into a question.
 *
 * Reads only. `safe()` above stays the gate for every write.
 */
export function readCheck(p, { kind = 'read_file', allow, interactive = false } = {}) {
  const abs = realDeep(resolve(real(session.cwd), untilde(p)));
  const secrets = secretPaths(homedir()).map(realDeep);
  const verdict = decideRead({
    abs, kind, root: real(session.root), secrets, interactive,
    ci: process.platform === 'darwin' || process.platform === 'win32',
    folders: [...session.readFolders], files: [...session.readFiles],
    once: allow ? [...allow] : [], declined: [...session.readDeclined],
  });
  let isDir = false;
  try { isDir = statSync(abs).isDirectory(); } catch { /* does not exist */ }
  return { abs, ...verdict, folder: verdict.action === 'ask' ? grantFolder(abs, kind, isDir) : null };
}

/** The resolved path for a read, or a throw that tells the model what happened. */
export function safeRead(p, { kind = 'read_file', allow } = {}) {
  const v = readCheck(p, { kind, allow });
  if (v.action === 'allow') return v.abs;
  throw new Error(refusalText(v.reason, v.abs, real(session.root)));
}

/** The path a read-only call would touch, or null when it touches none. */
export function readTarget(name, args) {
  if (name === 'read_file') return typeof args?.path === 'string' ? args.path : null;
  if (name === 'list_dir' || name === 'search') return typeof (args?.path ?? '.') === 'string' ? (args?.path ?? '.') : null;
  return null;
}

/** Allow reads under `dir` for the rest of this run. */
export function grantReadFolder(dir) { session.readFolders.add(dir); session.readDeclined.clear(); }

/** The user attached this file themselves: it needs no question. */
export function consentFile(p) {
  const abs = realDeep(resolve(real(session.cwd), untilde(p)));
  if (readCheck(abs).reason !== 'inside') session.readFiles.add(abs);
  return abs;
}

/** Remember a refusal so the same path is not asked about twice. */
export function declineRead(abs) { session.readDeclined.add(abs); }

/** What has been opened up outside the launch root this run, for /context. */
export const readGrantLines = () => [
  ...[...session.readFolders].map((d) => `${d}/ (folder)`),
  ...[...session.readFiles].map((f) => `${f} (attached)`),
];

/**
 * A tool definition in the shape the OpenAI-compatible API wants.
 *
 * Exported because src/subagent.js defines a tool too — one that is only
 * offered at the top level, so it cannot live in TOOLS below.
 */
export const def = (name, description, properties, required) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
});

export const TOOLS = [
  def('read_file', 'Read a UTF-8 text file relative to the working directory, or at any path: one outside the launch folder asks the user first. A PNG, JPEG, WebP or GIF (10 MB at most) is shown to you as an image instead, if your model can see.',
    { path: { type: 'string' } }, ['path']),

  def('write_file', 'Create a new text file, or replace one wholesale. To change part of an existing file use edit_file. Requires user approval.',
    { path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),

  // Steers the model off write_file for existing files: rewriting a whole file
  // costs every unchanged line in tokens and is where local models drop code.
  def('edit_file',
    'Change part of an existing file by replacing an exact string. Prefer this over write_file for any '
    + 'change to a file that already exists. old_string must match the file exactly (whitespace included) '
    + 'and be unique unless replace_all is true. Requires user approval.',
    {
      path: { type: 'string' },
      old_string: { type: 'string', description: 'The exact text to replace.' },
      new_string: { type: 'string', description: 'The text to put in its place.' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring exactly one.' },
    },
    ['path', 'old_string', 'new_string']),

  def('list_dir', 'List entries in a directory. Defaults to the working directory. A path outside the launch folder asks the user first.',
    { path: { type: 'string' } }, []),

  def('search', 'Search file contents with a regular expression (ripgrep-style). Returns matching lines with file:line prefixes. A path outside the launch folder asks the user first.',
    { pattern: { type: 'string' }, path: { type: 'string' } }, ['pattern']),

  def('bash', 'Run a shell command in the working directory. Requires user approval.',
    { cmd: { type: 'string' } }, ['cmd']),

  // Never gated: it runs nothing new. Killing is a SIGKILL to a process group
  // the user already approved when they approved the `bash` call that started it.
  def('bash_output',
    'A bash command that outlives its timeout keeps running in the background and is given a job id. '
    + 'Call this with that id to read what it has printed since you last looked and to see whether it has '
    + 'finished (with its exit status). If the job is still running and has printed nothing new, this waits up '
    + 'for a few seconds for output or exit before answering, so there is no need to poll it in a loop. '
    + 'Set kill to true to stop it.',
    {
      id: { type: 'string', description: 'The job id from the bash result, e.g. "bg1".' },
      kill: { type: 'boolean', description: 'Stop the job instead of just reading it.' },
    },
    ['id']),

  // The description is the only instruction a small model reliably reads, so it
  // carries the whole protocol: call it first, one item per criterion, resend
  // the entire list every time.
  def('set_plan',
    'Record the checklist for the current task and keep it updated. Call this first, with one '
    + 'item per acceptance criterion in the request. Call it again after each item is finished. '
    + 'The list you send replaces the stored one, so always send every item.',
    {
      items: {
        type: 'array',
        description: `The whole checklist, in order. At most ${MAX_ITEMS} items.`,
        items: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'The requirement, in the words of the request.' },
            status: { type: 'string', enum: ['todo', 'doing', 'done'] },
          },
          required: ['text'],
        },
      },
    },
    ['items']),
];

/** Tools that mutate state or run arbitrary code must be confirmed. */
export const NEEDS_APPROVAL = new Set(['write_file', 'edit_file', 'bash']);

/**
 * MCP tools are arbitrary third-party code, so anything that looks like it
 * writes gets gated. Read-only lookups stay frictionless — prompting for
 * `nx__nx_docs` would train you to hit `y` without reading.
 */
const MUTATING = /(^|_)(create|update|delete|remove|write|edit|apply|sync|run|exec|deploy|restart|scale|patch|set|add|move|rename|push|merge|close|assign)(_|$)/i;

export function mcpNeedsApproval(qualifiedName) {
  return MUTATING.test(qualifiedName.split('__').slice(1).join('__'));
}

/**
 * Exact-string replacement, as a pure function so the failure messages are
 * testable without a filesystem. Returns `{ text }` or `{ error }`.
 *
 * A miss or an ambiguous match is reported with the count rather than
 * guessing: replacing the first of several would silently edit the wrong place.
 */
export function applyEdit(text, oldStr, newStr, replaceAll = false) {
  if (typeof oldStr !== 'string' || oldStr === '') return { error: 'old_string must be a non-empty string (to create a file use write_file)' };
  // Checked because split().join(undefined) would insert a literal ",".
  if (typeof newStr !== 'string') return { error: 'new_string must be a string (use an empty string to delete the matched text)' };
  if (oldStr === newStr) return { error: 'old_string and new_string are identical, so nothing would change' };
  // A CRLF file read by the model and quoted back with LF endings would never
  // match verbatim. Match with `\r?\n` per newline and write the replacement
  // in the endings of what it replaced, so untouched lines are never rewritten.
  if (text.includes('\r')) return applyEditEol(text, oldStr, newStr, replaceAll);
  const count = text.split(oldStr).length - 1;
  if (count === 0) return { error: 'old_string was not found in the file (0 matches); re-read the file and copy the text exactly, whitespace included' };
  if (count > 1 && !replaceAll) {
    return { error: `old_string matches ${count} places; add surrounding lines to make it unique, or set replace_all to true` };
  }
  // split/join rather than String.replace, so `$&` in new_string stays literal.
  return { text: text.split(oldStr).join(newStr), count };
}

function applyEditEol(text, oldStr, newStr, replaceAll) {
  const pattern = oldStr.replace(/\r\n/g, '\n').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\n/g, '\r?\n');
  const re = new RegExp(pattern, 'g');
  const count = [...text.matchAll(re)].length;
  if (count === 0) return { error: 'old_string was not found in the file (0 matches); re-read the file and copy the text exactly, whitespace included' };
  if (count > 1 && !replaceAll) {
    return { error: `old_string matches ${count} places; add surrounding lines to make it unique, or set replace_all to true` };
  }
  const lf = newStr.replace(/\r\n/g, '\n');
  // No newline in the match: follow the file, but only when it is all CRLF.
  const fileCrlf = /\r\n/.test(text) && !/(^|[^\r])\n/.test(text);
  const out = text.replace(re, (m) => {
    const crlf = m.includes('\n') ? m.includes('\r\n') : fileCrlf;
    return crlf ? lf.replace(/\n/g, '\r\n') : lf;
  });
  return { text: out, count };
}

export function preview(name, args) {
  if (name === 'edit_file') {
    const cut = (s, mark, paint) => {
      const lines = String(s ?? '').split('\n');
      const out = lines.slice(0, 12).map((l) => paint(`${mark} ${l}`)).join('\n');
      return lines.length > 12 ? `${out}${c.grey(`\n  …${lines.length - 12} more lines`)}` : out;
    };
    return `${c.bold(args.path)}\n${cut(args.old_string, '-', c.red)}\n${cut(args.new_string, '+', c.green)}`;
  }
  if (name === 'write_file') {
    const lines = (args.content ?? '').split('\n');
    const head = lines.slice(0, 12).map((l) => c.green(`+ ${l}`)).join('\n');
    const more = lines.length > 12 ? c.grey(`\n  …${lines.length - 12} more lines`) : '';
    return `${c.bold(args.path)}\n${head}${more}`;
  }
  if (name === 'bash') return c.yellow(`$ ${args.cmd}`);
  return '';
}

export function describe(name, args) {
  switch (name) {
    case 'read_file':  return `read ${args.path}`;
    case 'write_file': return `write ${args.path}`;
    case 'edit_file':  return `edit ${args.path}`;
    case 'list_dir':   return `ls ${args.path ?? '.'}`;
    case 'search':     return `search /${args.pattern}/ in ${args.path ?? '.'}`;
    case 'bash':       return `bash: ${args.cmd}`;
    case 'bash_output': return `${args.kill ? 'kill' : 'output of'} ${args.id}`;
    case 'set_plan':   return `plan: ${args.items?.length ?? 0} items`;
    case 'task':       return `task ${args.agent ?? 'explore'}: ${String(args.prompt ?? '').split('\n')[0]}`;
    default:           return `${name}(${JSON.stringify(args)})`;
  }
}

/**
 * Strip the cwd marker off command output and report where we ended up.
 *
 * A command that walks out of the launch root does not move the session, but
 * the caller still has to say where it ran: reporting `session.cwd` for a
 * command that ran somewhere else handed the model a flat contradiction —
 * "you are in the project" next to "this is not a git repository" — and it
 * resolved it by going looking for the project elsewhere.
 *
 * `pwd` is null when the marker never printed, which is what `exec` does.
 */
function applyCwd(out, mark) {
  const i = out.lastIndexOf(mark);
  if (i === -1) return { body: out, pwd: null, escaped: false };
  const body = out.slice(0, i).replace(/\n$/, '');
  const next = real(out.slice(i + mark.length).trim());
  if (!next) return { body, pwd: null, escaped: false };
  const escaped = relative(real(session.root), next).startsWith('..');
  if (!escaped) session.cwd = next;
  return { body, pwd: next, escaped };
}

/**
 * One line telling the model that a sandbox denial is the likely cause, when it
 * actually is.
 *
 * The gate is narrow on purpose: this fires only when the failing command named
 * a tool in CREDENTIAL_TOOLS *and* the path it needs is still ungranted.
 * Loosening it to "the sandbox denies something" would fire on every failing
 * `npm test` and every failing build, because SECRET_FILES are denied
 * unconditionally under any active backend — something is always denied. A hint
 * that appears on every failure teaches the model to blame the sandbox for
 * ordinary bugs, which is worse than no hint at all.
 *
 * KRONK_SANDBOX_ALLOW is deliberately not suggested here. It is the read-write
 * hatch the grant prompt exists to replace.
 */
export function credentialHint(cmd, opts = {}) {
  const denied = ungranted(cmd, opts);
  if (!denied.length) return null;
  const home = opts.home ?? homedir();
  const tilde = (p) => (p.startsWith(`${home}/`) ? `~/${p.slice(home.length + 1)}` : p);
  const match = credentialMatches(cmd, home).find((m) => m.paths.some((p) => denied.includes(p)));
  return `note: the sandbox denies reads of ${denied.map(tilde).join(', ')}, which `
    + `${match?.bin ?? 'this command'} uses. Re-run and allow it if this failed on credentials.`;
}

/** The directory a command ran in, and a warning when that was outside the root. */
function whereLines(pwd, escaped) {
  const ran = pwd ? `ran in: ${pwd}` : `ran in: ${session.cwd} (final directory unknown)`;
  if (!escaped) return [ran];
  return [ran, `note: this command left the launch root ${session.root} and the session `
    + 'directory is unchanged. Work inside the root; paths above it are outside this '
    + "agent's scope."];
}

const MARK = '__KRONK_CWD__';

/** `text` without the cwd marker the EXIT trap appends (and the directory after it). */
export const stripMark = (text) => {
  const cut = text.indexOf(MARK);
  return cut === -1 ? text : text.slice(0, cut);
};

/**
 * Streaming counterpart of `stripMark` for live progress. The trap prints
 * `\n` + MARK + the directory, and the pipe may split that anywhere — even into
 * a chunk holding only the newline — so per-chunk stripping leaks pieces of it.
 * `push(chunk)` returns what is safe to show now: a tail that could still grow
 * into the marker is held back, and nothing at or after the marker is ever
 * returned. A held-back tail that turns out to be ordinary output is released
 * with the next chunk.
 */
export function markFilter() {
  const tag = `\n${MARK}`;
  let held = '';
  let done = false;
  return {
    push(chunk) {
      if (done) return '';
      held += chunk;
      const cut = held.indexOf(tag);
      if (cut !== -1) {
        done = true;
        const shown = held.slice(0, cut);
        held = '';
        return shown;
      }
      let keep = 0;
      for (let k = Math.min(tag.length - 1, held.length); k > 0; k--) {
        if (tag.startsWith(held.slice(-k))) { keep = k; break; }
      }
      const shown = held.slice(0, held.length - keep);
      held = held.slice(held.length - keep);
      return shown;
    },
  };
}

/**
 * What is actually confining `bash`, resolved once and reported in the banner.
 * `pending` until the first command runs, because the preflight costs a process.
 */
export const sandbox = { backend: 'pending', reason: null };

/**
 * Ask the kernel, do not assume.
 *
 * `sandbox-exec` exists on every Mac and `bwrap` may be installed but unusable
 * — unprivileged user namespaces are off on some distros, and a container often
 * has neither. A backend that fails to launch would turn every command into a
 * confusing startup error, so it is tried against `true` once and dropped if it
 * does not work.
 */
export function resolveSandbox({ platform = process.platform, env = process.env } = {}) {
  if (sandbox.backend !== 'pending') return sandbox.backend;

  const mode = env.KRONK_SANDBOX ?? 'auto';
  const wanted = detectBackend({ platform, env });

  if (wanted === 'none') {
    sandbox.backend = 'none';
    sandbox.reason = mode === 'off'
      ? 'disabled by KRONK_SANDBOX=off'
      : platform === 'linux' ? 'bwrap not installed' : 'no sandbox backend on this platform';
    return sandbox.backend;
  }

  // With the filesystem read-only inside the sandbox these cannot be created
  // from within it, and a missing ~/.npm would break `npm install` outright.
  for (const d of cacheDirs(homedir())) {
    try { mkdirSync(d, { recursive: true }); } catch { /* not fatal — it just stays unwritable */ }
  }

  const [bin, argv] = sandboxArgv('exit 0', {
    backend: wanted, root: session.root, home: homedir(), cwd: session.cwd, tmp: real(tmpdir()),
    readable: [...session.grants],
  });
  const probe = spawnSync(bin, argv, { stdio: 'ignore', timeout: 10_000 });

  if (probe.error || probe.status !== 0) {
    sandbox.backend = 'none';
    sandbox.reason = `${wanted} failed to start`;
  } else {
    sandbox.backend = wanted;
  }
  return sandbox.backend;
}

/**
 * Background jobs: commands that outlived their timeout and were left running.
 *
 * `out`/`err` behind a job's snapshot are the same tail-capped buffers `runBash`
 * keeps (MAX_CAPTURE each), so a chatty job cannot grow without bound; the
 * running totals let a read say how much fell off the front between two looks.
 */
const MAX_JOBS = 8;
const MAX_FINISHED = 8;
const jobs = new Map();
const discarded = new Set();   // ids evicted unread, so a late read can say so
let nextJob = 1;
let cleanupArmed = false;

const runningJobs = () => [...jobs.values()].filter((j) => !j.done).length;

function addJob(j) {
  const job = { ...j, id: `bg${nextJob++}`, done: false, code: null, signal: null,
    ended: null, note: null, outRead: 0, errRead: 0 };
  job.closed = new Promise((r) => { job.settle = r; });
  jobs.set(job.id, job);
  return job;
}

function finishJob(job, code, signal, note = null) {
  job.done = true;
  job.code = code;
  job.signal = signal;
  job.note = note;
  job.ended = Date.now();
  job.settle();
  // A job nobody reads would hold up to 800 KB for the rest of the run.
  // Oldest finished first; running jobs are never evicted.
  const finished = [...jobs.values()].filter((j) => j.done);
  for (const old of finished.slice(0, Math.max(0, finished.length - MAX_FINISHED))) {
    jobs.delete(old.id);
    discarded.add(old.id);
  }
}

/** Kill functions of the foreground commands running right now. */
const foreground = new Set();
const INTERRUPT_GRACE_MS = 2000;

/** Kill every background job and any foreground command. Called on exit, on /exit and on /clear. */
export function killAllJobs() {
  for (const kill of foreground) kill('SIGKILL');
  foreground.clear();
  for (const j of jobs.values()) if (!j.done) j.killTree('SIGKILL');
  jobs.clear();
  discarded.clear();
}

/** Number of jobs still running. */
export const backgroundJobs = () => runningJobs();

function armExitCleanup() {
  if (cleanupArmed) return;
  cleanupArmed = true;
  process.on('exit', killAllJobs);
  // Closing the terminal must not leave builds running. Re-raise so the default
  // action still ends the process.
  for (const sig of ['SIGHUP', 'SIGTERM']) {
    process.once(sig, () => { killAllJobs(); process.kill(process.pid, sig); });
  }
}

/** The part of a stream's buffer the model has not seen yet. */
function unread(buf, total, read) {
  const start = total - buf.length;          // total offset of buf[0]
  return { text: buf.slice(Math.max(0, read - start)), dropped: Math.max(0, start - read) };
}

/** How long `bash_output` waits on a running job that has printed nothing new. */
export const JOB_WAIT_MS = 5000;

/** Resolve when `job` has output the model has not seen, has finished, `ms` pass, or `signal` aborts. */
function waitForJob(job, ms, signal) {
  const fresh = () => {
    const s = job.snapshot();
    return s.outTotal > job.outRead || s.errTotal > job.errRead;
  };
  // Output that is only the cwd marker is not news; it arrives with the exit.
  if (fresh() || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { clearInterval(tick); clearTimeout(limit); signal?.removeEventListener('abort', done); resolve(); };
    const tick = setInterval(() => { if (job.done || fresh()) done(); }, 50);
    const limit = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
    job.closed.then(done);
  });
}

/**
 * Read a background job: new output since the last read, and its status.
 * With `kill`, stop it first. A finished job is forgotten once its final
 * output has been handed over.
 */
export async function readJob(id, { kill = false, waitMs = 0, signal } = {}) {
  const job = jobs.get(String(id ?? '').trim());
  if (!job) {
    if (discarded.has(String(id ?? '').trim())) {
      return `error: no such job "${id}" (finished and discarded — only the ${MAX_FINISHED} most recent finished jobs are kept)`;
    }
    const known = [...jobs.keys()].join(', ');
    return `error: no background job "${id}"${known ? ` (known: ${known})` : ' (none running)'}`;
  }
  if (kill && !job.done) {
    job.killTree('SIGKILL');
    await Promise.race([job.closed, new Promise((r) => setTimeout(r, 2000))]);
  }
  // Nothing new yet and still running: a model that re-asks at once only burns
  // a round trip per poll. Hold the call until output arrives, the job ends,
  // the wait runs out or the turn is aborted.
  if (!kill && !job.done && waitMs > 0) await waitForJob(job, waitMs, signal);
  const snap = job.snapshot();
  const o = unread(snap.out, snap.outTotal, job.outRead);
  const e = unread(snap.err, snap.errTotal, job.errRead);
  job.outRead = snap.outTotal;
  job.errRead = snap.errTotal;

  const secs = (((job.ended ?? Date.now()) - job.started) / 1000).toFixed(1);
  let status;
  if (!job.done) status = `still running (${secs}s so far)`;
  else if (job.note) status = `failed — ${job.note}`;
  else if (job.signal) status = `killed by ${job.signal} after ${secs}s`;
  else status = `exited with code ${job.code} after ${secs}s`;

  // The cwd marker is printed by the EXIT trap; a background job must not move
  // the session, so it is stripped and not applied.
  const cut = o.text.lastIndexOf(MARK);
  const body = (cut === -1 ? o.text : o.text.slice(0, cut)).replace(/\n$/, '');
  const dropped = o.dropped + e.dropped;
  const text = [
    `job ${job.id}: ${status}`,
    dropped && `[${dropped} characters of earlier output were dropped to stay under the cap]`,
    body.trim() && `new stdout:\n${body.trim()}`,
    e.text.trim() && `new stderr:\n${e.text.trim()}`,
    !body.trim() && !e.text.trim() && '(no new output)',
  ].filter(Boolean).join('\n');
  if (job.done) jobs.delete(job.id);
  return clip(text);
}

/**
 * Run a shell command, streaming progress to `onProgress` as it goes.
 *
 * `execFile` buffers silently, so a ten-minute build looked identical to a
 * hang, and when it was killed the rejection carried `code: undefined` — the
 * infamous `exit code ?`. Spawning directly gives us live output, the real
 * signal, and whatever the command managed to print before it died.
 */
export function runBash(cmd, { onProgress: progress, timeoutMs = TOOL_TIMEOUT, signal } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    if (signal?.aborted) return resolve('error: interrupted before it started (Ctrl-C); the command was not run.');
    // Own process group: killing bash alone leaves its children running and
    // holding the stdout pipe open, so `close` would not fire until they
    // finished anyway — a 5s timeout that returned after 30s.
    // Print the marker from an EXIT trap rather than appending it after the
    // command. A command ending in `exit 1` never reaches an appended line, so
    // the shell's final directory was unobservable for exactly the failures
    // that most need reporting. The trap fires whatever route the shell takes
    // out, and bash exits with the status in effect when it ran — so, unlike an
    // appended `printf`, it cannot make a failure look successful.
    const script = `__kronk_mark() { printf '\\n${MARK}%s' "$(pwd)"; }\ntrap __kronk_mark EXIT\n${cmd}`;

    const backend = resolveSandbox();
    if (backend === 'none' && (process.env.KRONK_SANDBOX ?? 'auto') === 'strict') {
      return resolve(`error: refusing to run unconfined — KRONK_SANDBOX=strict and ${sandbox.reason}.`);
    }

    // Read straight from module state rather than from `opts`. The profile is
    // rebuilt here on every command, so a grant made a moment ago is in force
    // now; threading it through the caller would add a second route for the
    // same fact, and the two would eventually disagree.
    const [bin, argv] = sandboxArgv(script, {
      backend, root: session.root, home: homedir(), cwd: session.cwd, tmp: real(tmpdir()),
      readable: [...session.grants],
    });
    const child = spawn(bin, argv, {
      cwd: session.cwd,
      env: { ...process.env, TERM: 'dumb', CI: process.env.CI ?? '1' },
      detached: true,
    });

    const killTree = (sig) => {
      try { process.kill(-child.pid, sig); }
      catch { try { child.kill(sig); } catch { /* already gone */ } }
    };

    // Ctrl-C: the command runs in its own process group, so the terminal's
    // SIGINT never reaches it. Stop it ourselves — politely, then for good.
    let interrupted = false;
    let hardKill = null;
    const onAbort = () => {
      if (job) return;           // a background job outlives the turn that started it
      interrupted = true;
      killTree('SIGTERM');
      hardKill = setTimeout(() => killTree('SIGKILL'), INTERRUPT_GRACE_MS);
    };
    const release = () => {
      signal?.removeEventListener('abort', onAbort);
      foreground.delete(killTree);
      clearTimeout(hardKill);
    };
    // Exit, SIGHUP and SIGTERM must not leave this command running either.
    foreground.add(killTree);
    armExitCleanup();
    signal?.addEventListener('abort', onAbort, { once: true });

    let onProgress = progress;
    let out = '';
    let err = '';
    let outTotal = 0;          // characters ever seen, so a job can tell what was dropped
    let errTotal = 0;
    let job = null;            // set once a timeout moves this command to the background
    let truncated = false;
    let lines = 0;
    let produced = 0;          // total bytes the command has emitted
    const visibleOut = markFilter();
    let shownLine = '';        // a chunk of bare newlines keeps the previous live line

    const take = (chunk, into) => {
      const raw = chunk.toString();
      if (into === 'out') outTotal += raw.length; else errTotal += raw.length;
      if (into === 'out') out += raw; else err += raw;
      if (out.length + err.length > MAX_CAPTURE) {
        truncated = true;
        if (out.length > MAX_CAPTURE) out = out.slice(-MAX_CAPTURE);
        if (err.length > MAX_CAPTURE) err = err.slice(-MAX_CAPTURE);
      }
      // The EXIT trap's cwd marker is bookkeeping, not output: keep it out of
      // the live line and the size estimate. The final result strips it too.
      const text = into === 'out' ? visibleOut.push(raw) : raw;
      if (!text) return;
      produced += text.length;
      lines += (text.match(/\n/g) ?? []).length;
      const lastLine = text.trimEnd().split('\n').pop() || shownLine;
      shownLine = lastLine;
      onProgress?.({
        seconds: (Date.now() - started) / 1000,
        lines,
        bytes: produced,
        kept: Math.min(produced, MAX_OUT),
        capped: produced > MAX_OUT,
        lastLine: lastLine.slice(0, 90),
      });
    };

    child.stdout.on('data', (d) => take(d, 'out'));
    child.stderr.on('data', (d) => take(d, 'err'));

    let timedOut = false;
    const timer = setTimeout(() => {
      // Killing a slow build throws away the minutes it already spent, and the
      // model then re-runs it with the same timeout. Keep it alive and hand back
      // a handle instead — unless the table is full, where an unbounded number
      // of forgotten processes is worse than a kill.
      if (runningJobs() < MAX_JOBS) {
        const secs = ((Date.now() - started) / 1000).toFixed(1);
        job = addJob({
          cmd, started, killTree,
          snapshot: () => ({ out, err, outTotal, errTotal }),
        });
        // What the timeout message below shows counts as already read.
        job.outRead = outTotal;
        job.errRead = errTotal;
        onProgress = null;
        signal?.removeEventListener('abort', onAbort);
        foreground.delete(killTree);
        // Without this the pipes keep the event loop alive and the exit hook
        // that kills background jobs would never get to run.
        child.unref();
        child.stdout.unref?.();
        child.stderr.unref?.();
        const { body } = applyCwd(out, MARK);
        const tail = [
          body.trim() && `stdout:\n${body.trim()}`,
          err.trim() && `stderr:\n${err.trim()}`,
        ].filter(Boolean).join('\n\n');
        return resolve(clip([
          `note: still running after ${secs}s (timeout ${Math.round(timeoutMs / 1000)}s). It was NOT killed — it is job ${job.id} in the background.`,
          `Call bash_output {"id":"${job.id}"} to read new output and check whether it finished, or {"id":"${job.id}","kill":true} to stop it.`,
          'Output so far:',
          tail || '(no output yet)',
        ].join('\n')));
      }
      timedOut = true;
      killTree('SIGKILL');
    }, timeoutMs);

    child.on('error', (e) => {
      clearTimeout(timer);
      release();
      if (job) { finishJob(job, null, null, e.message); return; }
      // `cwd:`, not `ran in:` — this fires before any output exists, so nothing
      // ever ran and there is no final directory to report. Naming one would be
      // a worse lie than the stale cwd this file otherwise stopped printing.
      resolve(`error: could not start command — ${e.message}\ncwd: ${session.cwd}`);
    });

    child.on('close', (code, sig) => {
      clearTimeout(timer);
      if (job) { finishJob(job, code, sig); return; }
      release();
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      const { body, pwd, escaped } = applyCwd(out, MARK);
      const where = whereLines(pwd, escaped);
      const tail = [
        body.trim() && `stdout:\n${body.trim()}`,
        err.trim() && `stderr:\n${err.trim()}`,
      ].filter(Boolean).join('\n\n');

      // Right after `error:` and `ran in:`, never appended at the end: the tool
      // result is capped for display, and a hint below the cap is a hint the
      // reader never sees.
      const hint = credentialHint(cmd);

      if (interrupted) {
        return resolve(clip([
          `error: interrupted by the user (Ctrl-C) after ${secs}s; the command was stopped.`,
          ...where,
          tail || '(no output before it was interrupted)',
        ].filter(Boolean).join('\n')));
      }
      if (timedOut) {
        return resolve(clip([
          `error: killed after ${secs}s (timeout ${Math.round(timeoutMs / 1000)}s).`,
          'The command may simply be slow — re-run a narrower scope, or raise KRONK_TOOL_TIMEOUT.',
          ...where,
          hint,
          tail || '(no output before it was killed)',
        ].filter(Boolean).join('\n')));
      }
      if (code === 0) {
        const okBody = clip(body + err);
        const text = `${okBody.trim() || '(no output)'}${truncated ? '\n[earlier output dropped]' : ''}`;
        // Prepended, and outside clip(): a command that succeeded on the way out
        // of the root is exactly how a model talks itself into believing the
        // project lives somewhere else, so the warning leads and cannot be elided.
        return resolve(escaped ? `${where.join('\n')}\n${text}` : text);
      }
      return resolve(clip([
        sig
          ? `error: killed by ${sig} after ${secs}s`
          : `error: exit code ${code} after ${secs}s`,
        ...where,
        hint,
        tail || '(no output)',
        truncated ? '[earlier output dropped]' : '',
      ].filter(Boolean).join('\n')));
    });
  });
}

export async function runTool(name, args, opts = {}) {
  try {
    switch (name) {
      case 'read_file': {
        // Bytes decide, not the name: macOS screenshots have no extension.
        const img = opts.images ? await loadImage(args.path, { optional: true, allow: opts.allowRead }) : null;
        if (img && opts.vision === false) {
          return `${IMAGE_NOT_SHOWN} ${args.path} is an image (${img.mime}, ${img.bytes.toLocaleString()} bytes) but the active model has no vision support, so it could not be shown. Do not describe or guess its contents; tell the user the image could not be viewed and that a vision model is needed.`;
        }
        if (img) {
          opts.images.push(img.part);
          return `image attached: ${args.path} (${img.mime}, ${img.bytes.toLocaleString()} bytes). It follows this result as a user message.`;
        }
        const file = safeRead(args.path, { kind: 'read_file', allow: opts.allowRead });
        // A FIFO or a device would block a read forever, and outside the launch
        // folder nothing else has vouched for the path.
        const st = await stat(file);
        if (!st.isFile() && !st.isDirectory()) return `error: ${args.path} is not a regular file`;
        return clip(await readFile(file, 'utf8'));
      }

      case 'write_file':
        await writeFile(safe(args.path), args.content ?? '');
        return `wrote ${args.path} (${(args.content ?? '').length} bytes)`;

      case 'edit_file': {
        const file = safe(args.path);
        let before;
        try {
          const raw = await readFile(file);
          before = raw.toString('utf8');
          // Decoding invalid UTF-8 substitutes U+FFFD, and writing that back would
          // silently corrupt the file, so a lossy round trip is refused outright.
          if (!Buffer.from(before, 'utf8').equals(raw)) {
            return `error: ${args.path} is not valid UTF-8 text; edit_file will not rewrite it`;
          }
        }
        catch (e) {
          if (e.code === 'ENOENT') return `error: ${args.path} does not exist; use write_file to create it`;
          throw e;
        }
        const r = applyEdit(before, args.old_string, args.new_string, args.replace_all === true);
        if (r.error) return `error: ${r.error}`;
        await writeFile(file, r.text);
        return `edited ${args.path} (${r.count} replacement${r.count === 1 ? '' : 's'})`;
      }

      case 'list_dir': {
        const dir = safeRead(args.path ?? '.', { kind: 'list_dir', allow: opts.allowRead });
        const names = await readdir(dir);
        const rows = await Promise.all(names.map(async (n) => {
          try {
            const s = await stat(resolve(dir, n));
            return s.isDirectory() ? `${n}/` : `${n}  ${s.size}b`;
          } catch { return n; }
        }));
        return clip(rows.join('\n')) || '(empty)';
      }

      case 'search': {
        // Went straight to ripgrep unchecked, so `search` with an absolute path
        // read anything on the machine while read_file was busy refusing to.
        const where = safeRead(args.path ?? '.', { kind: 'search', allow: opts.allowRead });
        // Both tools exit 1 to mean "nothing matched", which is an answer and
        // not a failure. Reported as an error the model stops believing the
        // tool, and spends its step budget re-phrasing and re-reading rather
        // than using the fact it was just handed.
        const NOTHING = '(no matches)';
        try {
          const { stdout } = await exec('rg', ['-n', '--no-heading', '-m', '200', args.pattern, where]);
          return clip(stdout) || NOTHING;
        } catch (e) {
          if (e.code === 1) return NOTHING;
          // No ripgrep on this machine, or it refused the pattern. grep is the
          // floor, and it needs the same exit-1 reading the call above has —
          // this is the branch CI never reaches, because its images ship rg.
          try {
            // -E because this tool advertises ripgrep-style patterns, and basic
            // grep reads `a|b` as the three literal characters. -H because GNU
            // grep drops the filename when it is given exactly one file, and
            // this tool promises `file:line` prefixes — BSD grep prints them
            // either way, which is why a macOS-only check would not see it.
            const { stdout } = await exec('grep', ['-rn', '-H', '-E', '-m', '200', args.pattern, where]);
            return clip(stdout) || NOTHING;
          } catch (err) {
            if (err.code === 1) return NOTHING;
            throw err;
          }
        }
      }

      case 'bash':
        return runBash(args.cmd, opts);

      case 'bash_output':
        return readJob(args.id, { kill: args.kill === true, waitMs: opts.waitMs ?? JOB_WAIT_MS, signal: opts.signal });

      case 'set_plan':
        return setPlan(args.items);

      default:
        return `error: unknown tool ${name}`;
    }
  } catch (e) {
    // Errors are data, not crashes — hand them back so the model can recover.
    return `error: ${e.message}${e.stdout ? `\n${e.stdout}` : ''}${e.stderr ? `\n${e.stderr}` : ''}`;
  }
}
