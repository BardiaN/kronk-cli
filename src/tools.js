import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, relative, dirname, basename, isAbsolute } from 'node:path';
import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { detectBackend, sandboxArgv } from './sandbox.js';
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
export const session = { root: real(process.cwd()), cwd: real(process.cwd()) };

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
    default:           return `${name}(${JSON.stringify(args)})`;
  }
}

/** Strip the cwd marker off command output and record where we ended up. */
function applyCwd(out, mark) {
  const i = out.lastIndexOf(mark);
  if (i === -1) return out;
  const next = real(out.slice(i + mark.length).trim());
  const rel = relative(real(session.root), next);
  if (next && !rel.startsWith('..')) session.cwd = next;
  return out.slice(0, i).replace(/\n$/, '');
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

  const [bin, argv] = sandboxArgv('exit 0', {
    backend: wanted, root: session.root, home: homedir(), cwd: session.cwd, tmp: real(tmpdir()),
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
    // Capture the real status BEFORE the marker runs, then exit with it.
    // Appending `printf` naively made every command look successful, so
    // failures never reached the agent at all.
    const script = `${cmd}\n__kronk_st=$?\nprintf '\\n${MARK}%s' "$(pwd)"\nexit $__kronk_st`;

    const backend = resolveSandbox();
    if (backend === 'none' && (process.env.KRONK_SANDBOX ?? 'auto') === 'strict') {
      return resolve(`error: refusing to run unconfined — KRONK_SANDBOX=strict and ${sandbox.reason}.`);
    }

    const [bin, argv] = sandboxArgv(script, {
      backend, root: session.root, home: homedir(), cwd: session.cwd, tmp: real(tmpdir()),
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
      resolve(`error: could not start command — ${e.message}\ncwd: ${session.cwd}`);
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      const body = applyCwd(out, MARK);
      const tail = [
        body.trim() && `stdout:\n${body.trim()}`,
        err.trim() && `stderr:\n${err.trim()}`,
      ].filter(Boolean).join('\n\n');

      if (timedOut) {
        return resolve(clip([
          `error: killed after ${secs}s (timeout ${Math.round(timeoutMs / 1000)}s).`,
          'The command may simply be slow — re-run a narrower scope, or raise KRONK_TOOL_TIMEOUT.',
          `cwd: ${session.cwd}`,
          tail || '(no output before it was killed)',
        ].join('\n')));
      }
      if (code === 0) {
        const okBody = clip(body + err);
        return resolve(`${okBody.trim() || '(no output)'}${truncated ? '\n[earlier output dropped]' : ''}`);
      }
      return resolve(clip([
        signal
          ? `error: killed by ${signal} after ${secs}s`
          : `error: exit code ${code} after ${secs}s`,
        `cwd: ${session.cwd}`,
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

      default:
        return `error: unknown tool ${name}`;
    }
  } catch (e) {
    // Errors are data, not crashes — hand them back so the model can recover.
    return `error: ${e.message}${e.stdout ? `\n${e.stdout}` : ''}${e.stderr ? `\n${e.stderr}` : ''}`;
  }
}
