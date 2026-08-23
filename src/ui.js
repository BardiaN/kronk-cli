const on = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code) => (s) => (on ? `\x1b[${code}m${s}\x1b[0m` : s);

export const c = {
  dim: wrap('2'),
  bold: wrap('1'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  blue: wrap('34'),
  magenta: wrap('35'),
  cyan: wrap('36'),
  grey: wrap('90'),
};

export const banner = (model, url) => `
${c.cyan('  ██ kronk-cli')}  ${c.grey('· local agent, no network')}
  ${c.grey('model')}  ${c.bold(model)}
  ${c.grey('server')} ${url}
  ${c.grey('/help for commands · Ctrl-C to interrupt · /exit to quit')}
`;

const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));

/** `18k/131k 14% ▓▓░░░░░░░░` — how full the window is after this turn. */
export function fmtContext(used, window) {
  if (!window || !used) return '';
  const pct = used / window;
  const filled = Math.min(10, Math.round(pct * 10));
  const bar = '▓'.repeat(filled) + '░'.repeat(10 - filled);
  const label = `${k(used)}/${k(window)} ${Math.round(pct * 100)}% ${bar}`;
  if (pct >= 0.9) return c.red(label);
  if (pct >= 0.7) return c.yellow(label);
  return c.grey(label);
}

export function fmtUsage(u, window) {
  if (!u) return '';
  const bits = [`${u.prompt_tokens ?? 0}→${u.completion_tokens ?? 0} tok`];
  if (u.tokens_per_second) bits.push(`${u.tokens_per_second.toFixed(1)} tok/s`);
  if (u.time_to_first_token_ms) bits.push(`ttft ${Math.round(u.time_to_first_token_ms)}ms`);
  const cached = u.prompt_tokens_details?.cached_tokens;
  if (cached) bits.push(`${cached} cached`);
  const reasoning = u.completion_tokens_details?.reasoning_tokens;
  if (reasoning) bits.push(`${reasoning} thinking`);
  const ctx = fmtContext((u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0), window);
  return `${c.grey(`  ${bits.join(' · ')}`)}${ctx ? `  ${ctx}` : ''}`;
}

/**
 * The line that sits directly above the prompt: what mode you are in, what is
 * attached, and how full the window is. Rendered fresh before every prompt so
 * it always reflects the current state rather than the state at startup.
 */
export function statusLine({ model, auto, yes, noThink, noPreserve, mcp, steps, used, window }) {
  const bits = [];
  bits.push(c.grey(model.split('/').pop()));
  if (auto) bits.push(c.magenta('auto'));
  else if (yes) bits.push(c.yellow('yes'));
  if (noThink) bits.push(c.grey('no-think'));
  if (noPreserve) bits.push(c.grey('no-preserve'));
  if (mcp) bits.push(c.cyan(`mcp ${mcp}`));
  if (Number.isFinite(steps)) bits.push(c.grey(`steps ${steps}`));
  const ctx = fmtContext(used, window);
  if (ctx) bits.push(ctx);
  return `${c.grey('⏵')} ${bits.join(c.grey(' · '))}`;
}

/**
 * Live progress for a running command: elapsed time, line count, and the last
 * line it printed. Redraws in place so a long build shows movement instead of
 * looking like a hang.
 */
export function liveLine() {
  if (!process.stdout.isTTY) {
    let warned = false;
    return {
      update({ seconds }) {
        if (!warned && seconds > 10) { warned = true; process.stdout.write(c.grey('    …running\n')); }
      },
      done() {},
    };
  }
  const frames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
  let i = 0;
  let last = { seconds: 0, lines: 0, kept: 0, capped: false, lastLine: '' };
  const draw = () => {
    const { seconds, lines, kept, capped, lastLine, window } = last;
    const parts = [`${seconds.toFixed(0)}s`, `${lines.toLocaleString()} lines`];

    // What this output will actually cost the conversation, live. ~4 chars per
    // token is rough but the point is the order of magnitude, not the digit.
    if (kept && window) {
      const tok = Math.ceil(kept / 4);
      const pct = Math.round((tok / window) * 100);
      parts.push(`→${k(tok)} ctx ${pct}%${capped ? ' capped' : ''}`);
    }
    const head = `    ${c.cyan(frames[i++ % frames.length])} ${c.grey(parts.join(' · '))}`;
    const tail = lastLine ? `  ${c.grey(lastLine)}` : '';
    process.stdout.write(`\r${head}${tail}\x1b[K`);
  };
  const timer = setInterval(() => { last.seconds += 0.12; draw(); }, 120);
  return {
    update(info) { last = { ...last, ...info }; draw(); },
    done() { clearInterval(timer); process.stdout.write('\r\x1b[K'); },
  };
}

/**
 * Render a failed tool result for the screen: the first line whole (however
 * long), the rest indented four spaces and capped, so one runaway command
 * cannot scroll the actionable part — the `stderr:` block — off the top of
 * the terminal. Pure: `src/agent.js` prints whatever comes back. The model's
 * own copy in `messages` is never touched; only the screen is bounded.
 */
export function toolResultLines(result, { maxLines = 20, maxWidth = 200 } = {}) {
  const [first, ...rest] = result.split('\n');
  const lines = [c.red(`  ✗ ${first}`)];

  const shown = rest.slice(0, maxLines);
  for (const line of shown) {
    const body = line.length > maxWidth ? `${line.slice(0, maxWidth)}…` : line;
    lines.push(c.grey(`    ${body}`));
  }

  const hidden = rest.length - shown.length;
  if (hidden > 0) {
    const noun = hidden === 1 ? 'line' : 'lines';
    lines.push(c.grey(`    …${hidden} more ${noun} (the model received all of it)`));
  }

  return lines;
}

/** A one-line spinner that does not fight with streamed output. */
export function spinner(label) {
  if (!process.stdout.isTTY) return { stop() {} };
  const frames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
  let i = 0;
  const t = setInterval(() => {
    process.stdout.write(`\r${c.cyan(frames[i++ % frames.length])} ${c.grey(label)}\x1b[K`);
  }, 80);
  return {
    stop() { clearInterval(t); process.stdout.write('\r\x1b[K'); },
  };
}
