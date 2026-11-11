import { spawn } from 'node:child_process';

// User-configured commands that run around a tool call. They are the user's own
// code, so they run through the user's shell with no sandbox, and they run only
// after the approval prompt has been answered: a hook can refuse a call but can
// never approve one.

const DEFAULT_TIMEOUT_S = 10;
const MAX_CAPTURE = 8_000;

/**
 * Turn the config file's `hooks` value into a list we can trust. A malformed
 * entry is dropped rather than thrown on: a typo in a config file must not stop
 * the program from starting, and `dropped` lets the caller say so once.
 */
export function parseHooks(raw) {
  const out = { pre: [], post: [], dropped: 0 };
  if (!raw || typeof raw !== 'object') return out;
  for (const phase of ['pre', 'post']) {
    const list = Array.isArray(raw[phase]) ? raw[phase] : [];
    for (const h of list) {
      let re = null;
      try { re = new RegExp(h?.match ?? ''); } catch { /* counted below */ }
      if (!h || typeof h.command !== 'string' || !h.command.trim() || !re) { out.dropped++; continue; }
      const timeout = Number(h.timeout);
      out[phase].push({
        re,
        command: h.command,
        timeoutMs: (Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_S) * 1000,
        onFailure: h.onFailure === 'block' ? 'block' : 'allow',
      });
    }
  }
  return out;
}

/** The hooks of one phase whose `match` hits this tool name, in config order. */
export const matching = (hooks, phase, tool) => (hooks?.[phase] ?? []).filter((h) => h.re.test(tool));

const text = (s) => String(s ?? '').trim();

/**
 * What a finished hook means. Exit 0 continues; exit 2 is a deliberate verdict
 * from the hook; anything else (non-zero, killed, never started, timed out) is
 * the hook itself being broken, and `onFailure` decides what that costs.
 */
export function decide(run, onFailure = 'allow') {
  if (!run.timedOut && !run.error && run.code === 0) return { action: 'continue' };
  if (!run.timedOut && !run.error && run.code === 2) {
    return { action: 'block', message: text(run.stderr) || 'blocked by a hook with no message' };
  }
  const why = run.timedOut ? 'timed out'
    : run.error ? `could not start: ${run.error}`
    : `exited with code ${run.code ?? run.signal}`;
  const detail = text(run.stderr);
  return onFailure === 'block'
    ? { action: 'block', message: `hook ${why}${detail ? `: ${detail}` : ''}` }
    : { action: 'continue', warning: `hook ${why}` };
}

/** Run one hook command with `payload` as JSON on stdin. Never rejects. */
export function runHook(hook, payload, { env = process.env, cwd = process.cwd() } = {}) {
  return new Promise((done) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (r) => { if (!settled) { settled = true; clearTimeout(timer); done({ stdout, stderr, ...r }); } };

    let child;
    try {
      child = spawn(hook.command, {
        shell: true, cwd, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...env, KRONK_TOOL: payload.tool },
      });
    } catch (e) { return done({ stdout, stderr, error: e.message }); }

    // Kill the whole group, not just the shell: a grandchild (`a | b`, `npx`)
    // would otherwise keep the pipes open and 'close' would never fire. The
    // timer also settles the promise itself, so nothing can hang past it.
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
      finish({ timedOut: true });
    }, hook.timeoutMs);
    const keep = (cur, d) => (cur.length < MAX_CAPTURE ? cur + d : cur);
    child.stdout.on('data', (d) => { stdout = keep(stdout, d); });
    child.stderr.on('data', (d) => { stderr = keep(stderr, d); });
    child.on('error', (e) => finish({ error: e.message }));
    // A hook that never reads stdin closes it early; that is its right.
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
    child.on('close', (code, signal) => finish({ code, signal, timedOut }));
  });
}

/**
 * Run every matching pre-hook in order. The first to block ends the chain and
 * its message becomes the tool result. Returns `{ blocked, message, warnings }`.
 */
export async function runPre(hooks, tool, args, opts = {}) {
  const warnings = [];
  const payload = { tool, args, cwd: opts.cwd ?? process.cwd() };
  for (const h of matching(hooks, 'pre', tool)) {
    const d = decide(await runHook(h, payload, opts), h.onFailure);
    if (d.warning) warnings.push(d.warning);
    if (d.action === 'block') return { blocked: true, message: d.message, warnings };
  }
  return { blocked: false, warnings };
}

/**
 * Run every matching post-hook. Output is dropped unless a hook exits 2, in
 * which case its stderr is collected into `note` for the caller to append to
 * the result. A post-hook cannot undo the call, so `onFailure` does not apply.
 */
export async function runPost(hooks, tool, args, result, opts = {}) {
  const warnings = [];
  const notes = [];
  const payload = { tool, args, cwd: opts.cwd ?? process.cwd(), result, ok: !String(result).startsWith('error:') };
  for (const h of matching(hooks, 'post', tool)) {
    const run = await runHook(h, payload, opts);
    const d = decide(run, 'allow');
    if (d.action === 'block') notes.push(d.message);
    else if (d.warning) warnings.push(d.warning);
  }
  return { note: notes.length ? `[hook] ${notes.join('\n[hook] ')}` : '', warnings };
}
