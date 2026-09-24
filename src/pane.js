import readline from 'node:readline';
import { c, elapsed } from './ui.js';

/**
 * The transient pane a delegated run draws in while it is running.
 *
 * A sub-agent's tool calls used to go straight into the conversation, nested
 * under `   │`, and stayed there. That is the wrong trade in both directions.
 * While the run is going a live view is the only sign the thing is alive, and
 * it is where you notice a sub-agent thrashing; once it has finished, almost
 * none of it is worth keeping, because the question you asked and the report
 * you got are now forty lines apart. The window never paid for any of it —
 * that is the point of delegating — but the screen paid for all of it.
 *
 * So: draw it in a box that redraws in place, and erase the box when the run
 * ends. Nothing is lost by erasing it. Every line the pane shows was already
 * written to the run's transcript as it happened (src/tasklog.js), so the pane
 * is a view of a file that outlives it, and `/tasks <n>` is how you get it
 * back. That is what makes discarding the pane safe.
 *
 * Scrollback, not the alternate screen. A full takeover would be easier to
 * draw and worse to live with, because it hides the conversation you are in
 * the middle of. A fixed block redrawn in place keeps the history above it.
 */

/** Rows of sub-agent activity kept on screen. The box is bounded; the file is not. */
const BODY_ROWS = 6;

const MIN_WIDTH = 40;
const MAX_WIDTH = 100;

// eslint-disable-next-line no-control-regex -- matching the escapes is the point
const SGR = /\x1b\[[0-9;]*m/g;

/** How wide a string prints, once its colour escapes are discounted. */
export const visibleWidth = (s) => String(s).replace(SGR, '').length;

/** The box's outer width for a terminal this wide, clamped both ways. */
export const paneWidth = (columns) => Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, (columns || 80) - 2));

/**
 * Cut a coloured string to `width` printed characters.
 *
 * Escapes are copied through without being counted — cutting in the middle of
 * one would leave the rest of the terminal painted in whatever colour the
 * fragment happened to open. The trailing reset is only added when something
 * was actually opened, so a no-colour terminal still gets no escapes at all.
 */
export function clip(line, width) {
  const s = String(line);
  if (visibleWidth(s) <= width) return s;
  if (width <= 0) return '';
  let out = '';
  let seen = 0;
  let i = 0;
  while (i < s.length && seen < width - 1) {
    if (s[i] === '\x1b') {
      SGR.lastIndex = i;
      const m = SGR.exec(s);
      if (m && m.index === i) { out += m[0]; i += m[0].length; continue; }
    }
    out += s[i];
    i += 1;
    seen += 1;
  }
  return `${out}…${out.includes('\x1b') ? '\x1b[0m' : ''}`;
}

/** Right-pad to `width` printed characters, so every row ends on the same column. */
export const pad = (line, width) => `${line}${' '.repeat(Math.max(0, width - visibleWidth(line)))}`;

const rule = (n) => '─'.repeat(Math.max(1, n));

/**
 * One frame of the box, as lines — pure, so the geometry is testable without a
 * terminal. Every line it returns is exactly `width` printed characters wide;
 * `test/pane.test.js` asserts that, because an off-by-one in the arithmetic
 * below is invisible in a diff and unmissable on screen.
 */
export function renderPane({ agent, rows = [], status = '', hint = '', width = 60 }) {
  const inner = Math.max(4, width - 4);
  // Printed width, not string length: the status and the hint arrive coloured,
  // and counting their escapes would pull the right-hand corner off the edge.
  const w = (s) => (s ? visibleWidth(s) + 1 : 0);

  // `┌─ agent ──…── 6/40 · 48s ─┐`
  const headFixed = 3 + w(agent) + 1 + w(status) + 2;
  const top = c.grey('┌─ ') + c.bold(agent) + c.grey(` ${rule(width - headFixed)} ${status ? `${status} ` : ''}─┐`);

  // `└─ esc to collapse · ctrl-c to stop ───┘`
  const footFixed = 3 + w(hint) + 2;
  const bottom = c.grey(`└─ ${hint ? `${hint} ` : ''}${rule(width - footFixed)}─┘`);

  const body = rows.map((r) => `${c.grey('│')} ${pad(clip(r, inner), inner)} ${c.grey('│')}`);
  return [top, ...body, bottom];
}

/**
 * Watch for a bare `esc` while the pane is up.
 *
 * Deliberately not `setRawMode`. The REPL's readline already owns stdin and
 * already holds it in raw mode, and it is still reading during a turn — that
 * is how typing ahead survives (see src/prompt.js). Taking the mode away from
 * it and handing back what we swallowed is the kind of thing that eats a
 * user's typing when it goes wrong, and there is no need: readline has already
 * made stdin emit `keypress`, so a listener is purely additive. Ctrl-C keeps
 * working because we never intercepted it.
 *
 * Armed only when stdin is *already* raw, which is exactly "a readline is
 * open and reading". In one-shot and `--auto` runs it is not, nobody is
 * watching, and the footer does not offer a key that would do nothing.
 */
export function watchEsc({ input = process.stdin, onEsc } = {}) {
  if (!onEsc || !input?.isTTY || !input.isRaw) return null;
  // Idempotent in Node: it returns early if the stream already has a decoder.
  readline.emitKeypressEvents(input);
  // `meta` is true on a bare esc and false on `esc [ A`, because node cannot
  // know which it has until the next byte arrives or `escapeCodeTimeout`
  // (500 ms) expires — so this is the key, and an arrow key is not. That half
  // second of lag is invisible next to a run that takes tens of seconds.
  const onKey = (_s, key) => { if (key?.name === 'escape' && !key.ctrl) onEsc(); };
  input.on('keypress', onKey);
  return () => input.off('keypress', onKey);
}

/**
 * Whether to draw at all.
 *
 * `node src/index.js "hello" | grep` and every CI run land here with a pipe,
 * and a pipe must get exactly what it got before the pane existed: the nested
 * lines, in order, with no cursor control in them. A dumb terminal cannot move
 * a cursor either, so it takes the same path.
 */
export const paneUsable = (stream = process.stdout, env = process.env) =>
  Boolean(stream?.isTTY) && env.TERM !== 'dumb';

/** The inert pane: every call a no-op, so the caller needs no branch of its own. */
const OFF = {
  enabled: false,
  open() {}, line() {}, step() {}, close() {}, collapse() {},
  shield: (fn) => fn,
};

/**
 * The live pane. `open` draws it, `line` feeds it, `close` erases it.
 *
 * `shield(fn)` is how the approval prompt stays readable: it wipes the box
 * before `fn` runs and redraws it after. An approval prompt has to be exactly
 * as visible and as blocking as it is without a pane, so it gets the terminal
 * to itself rather than competing with a redraw every 250 ms.
 */
export function livePane({
  agent = 'agent', maxSteps, rows: keep = BODY_ROWS, signal,
  stream = process.stdout, input = process.stdin, env = process.env,
  now = Date.now, tickMs = 250,
} = {}) {
  if (!paneUsable(stream, env)) return OFF;

  const started = now();
  const fed = [];
  let steps = 0;
  let height = 0;            // rows the box currently occupies on screen
  let collapsed = false;
  let timer = null;
  let unwatch = null;
  let unabort = null;

  const status = () => {
    const at = Number.isFinite(maxSteps) ? `${steps}/${maxSteps}` : String(steps);
    return c.grey(`${at} · ${elapsed(now() - started)}`);
  };

  const paint = () => {
    if (collapsed) return;
    const width = paneWidth(stream.columns);
    const hint = c.grey(unwatch ? 'esc to collapse · ctrl-c to stop' : 'ctrl-c to stop');
    const frame = renderPane({ agent, rows: fed, status: status(), hint, width });
    // Up to the top of the old box, then repaint row by row. `\x1b[K` on each
    // row so a shorter line does not leave the tail of a longer one behind.
    let buf = height ? `\r\x1b[${height}A` : '';
    for (const l of frame) buf += `${l}\x1b[K\n`;
    // The box only ever grows, but a narrower terminal can shorten it; clear
    // whatever the previous frame left below this one.
    if (height > frame.length) buf += '\x1b[J';
    stream.write(buf);
    height = frame.length;
  };

  const erase = () => {
    if (!height) return;
    stream.write(`\r\x1b[${height}A\x1b[J`);
    height = 0;
  };

  const tick = () => {
    if (timer) return;
    timer = setInterval(paint, tickMs);
    // Never a reason to keep the process alive: the run is what we are waiting on.
    timer.unref?.();
  };
  const untick = () => { clearInterval(timer); timer = null; };

  const stop = () => {
    untick();
    unwatch?.();
    unwatch = null;
    unabort?.();
    unabort = null;
  };

  return {
    enabled: true,

    open() {
      unwatch = watchEsc({ input, onEsc: () => this.collapse() });
      // Ctrl-C aborts the run and then prints `interrupted` — which would land
      // on top of the box, leaving the next repaint counting rows from the
      // wrong place and erasing lines of the conversation above. Abort fires
      // this listener synchronously, so the box is gone before that line
      // prints. Nothing is lost: the transcript has everything it showed.
      const onAbort = () => this.collapse();
      signal?.addEventListener('abort', onAbort, { once: true });
      // Released with everything else: one turn can delegate several times, and
      // a listener left on that turn's signal each time is a leak node warns about.
      unabort = () => signal?.removeEventListener('abort', onAbort);
      paint();
      tick();
    },

    /** One line of sub-agent activity. Only the last `keep` survive. */
    line(text) {
      if (collapsed) return;
      for (const l of String(text).split('\n')) fed.push(l);
      if (fed.length > keep) fed.splice(0, fed.length - keep);
      paint();
    },

    step(n) { steps = n; },

    /** `esc`: give the screen back now. The run carries on into the transcript. */
    collapse() {
      if (collapsed) return;
      erase();
      collapsed = true;
      stop();
    },

    close() {
      erase();
      collapsed = true;
      stop();
    },

    shield(fn) {
      if (!fn) return fn;
      return async (...args) => {
        const wasUp = !collapsed && height > 0;
        erase();
        untick();
        try {
          return await fn(...args);
        } finally {
          if (wasUp && !collapsed) { paint(); tick(); }
        }
      };
    },
  };
}
