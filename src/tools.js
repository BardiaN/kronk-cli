import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, relative, dirname, basename, isAbsolute, join } from 'node:path';
import { realpathSync, mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { detectBackend, sandboxArgv, cacheDirs } from './sandbox.js';
import { config } from './config.js';
import { setPlan, MAX_ITEMS } from './plan.js';
import { c } from './ui.js';

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
  try { return realpathSync(p); } catch { return p; }
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
    try { return tail.length ? resolve(realpathSync(cur), ...tail) : realpathSync(cur); }
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

const def = (name, description, properties, required) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
});

export const TOOLS = [
  def('read_file', 'Read a UTF-8 text file relative to the working directory.',
    { path: { type: 'string' } }, ['path']),

  def('write_file', 'Create or overwrite a text file. Requires user approval.',
    { path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']),

  def('list_dir', 'List entries in a directory. Defaults to the working directory.',
    { path: { type: 'string' } }, []),

  def('search', 'Search file contents with a regular expression (ripgrep-style). Returns matching lines with file:line prefixes.',
    { pattern: { type: 'string' }, path: { type: 'string' } }, ['pattern']),

  def('bash', 'Run a shell command in the working directory. Requires user approval.',
    { cmd: { type: 'string' } }, ['cmd']),

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
export const NEEDS_APPROVAL = new Set(['write_file', 'bash']);

/**
 * MCP tools are arbitrary third-party code, so anything that looks like it
 * writes gets gated. Read-only lookups stay frictionless — prompting for
 * `nx__nx_docs` would train you to hit `y` without reading.
 */
const MUTATING = /(^|_)(create|update|delete|remove|write|edit|apply|sync|run|exec|deploy|restart|scale|patch|set|add|move|rename|push|merge|close|assign)(_|$)/i;

export function mcpNeedsApproval(qualifiedName) {
  return MUTATING.test(qualifiedName.split('__').slice(1).join('__'));
}

export function preview(name, args) {
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
    case 'list_dir':   return `ls ${args.path ?? '.'}`;
    case 'search':     return `search /${args.pattern}/ in ${args.path ?? '.'}`;
    case 'bash':       return `bash: ${args.cmd}`;
    case 'set_plan':   return `plan: ${args.items?.length ?? 0} items`;
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
 * Run a shell command, streaming progress to `onProgress` as it goes.
 *
 * `execFile` buffers silently, so a ten-minute build looked identical to a
 * hang, and when it was killed the rejection carried `code: undefined` — the
 * infamous `exit code ?`. Spawning directly gives us live output, the real
 * signal, and whatever the command managed to print before it died.
 */
export function runBash(cmd, { onProgress, timeoutMs = TOOL_TIMEOUT } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
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

    let out = '';
    let err = '';
    let truncated = false;
    let lines = 0;
    let produced = 0;          // total bytes the command has emitted

    const take = (chunk, into) => {
      const text = chunk.toString();
      produced += text.length;
      lines += (text.match(/\n/g) ?? []).length;
      if (into === 'out') out += text; else err += text;
      if (out.length + err.length > MAX_CAPTURE) {
        truncated = true;
        if (out.length > MAX_CAPTURE) out = out.slice(-MAX_CAPTURE);
        if (err.length > MAX_CAPTURE) err = err.slice(-MAX_CAPTURE);
      }
      const lastLine = text.trimEnd().split('\n').pop() ?? '';
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
    const timer = setTimeout(() => { timedOut = true; killTree('SIGKILL'); }, timeoutMs);

    child.on('error', (e) => {
      clearTimeout(timer);
      // `cwd:`, not `ran in:` — this fires before any output exists, so nothing
      // ever ran and there is no final directory to report. Naming one would be
      // a worse lie than the stale cwd this file otherwise stopped printing.
      resolve(`error: could not start command — ${e.message}\ncwd: ${session.cwd}`);
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
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
        signal
          ? `error: killed by ${signal} after ${secs}s`
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
      case 'read_file':
        return clip(await readFile(safe(args.path), 'utf8'));

      case 'write_file':
        await writeFile(safe(args.path), args.content ?? '');
        return `wrote ${args.path} (${(args.content ?? '').length} bytes)`;

      case 'list_dir': {
        const dir = safe(args.path ?? '.');
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
        const where = safe(args.path ?? '.');
        try {
          const { stdout } = await exec('rg', ['-n', '--no-heading', '-m', '200', args.pattern, where]);
          return clip(stdout) || '(no matches)';
        } catch (e) {
          if (e.code === 1) return '(no matches)';
          const { stdout } = await exec('grep', ['-rn', '-m', '200', args.pattern, where]);
          return clip(stdout) || '(no matches)';
        }
      }

      case 'bash':
        return runBash(args.cmd, opts);

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
