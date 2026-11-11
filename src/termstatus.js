/**
 * Tell the terminal what this process is doing — working, waiting on you, or
 * done — so a tab you are not looking at can say so.
 *
 * Three channels, all out-of-band: the window title (OSC 0), a taskbar/tab
 * progress indicator (OSC 9;4, Windows Terminal, Ghostty, iTerm2, ConEmu), and
 * a single BEL for "come back". None of them moves the cursor or prints a
 * cell, which is the property that matters here: the status line, the live
 * pane and the readline prompt all track the cursor by row arithmetic, and a
 * sequence that disturbed it would corrupt every one of them. A terminal that
 * does not know an OSC drops it silently, so there is nothing to detect.
 */

const ESC = '\x1b';
const BEL = '\x07';

const NAME = 'kronk-cli';

/** The title shown for each state. */
export const TITLES = {
  working: `${NAME} · working`,
  approval: `${NAME} · needs approval`,
  ready: `${NAME} · ready`,
};

/** OSC 0 sets icon name and window title together, which is what a tab shows. */
const printable = (text) => [...String(text)]
  .map((ch) => { const n = ch.codePointAt(0); return n < 0x20 || n === 0x7f ? ' ' : ch; })
  .join('');
export const titleSeq = (text) => `${ESC}]0;${printable(text)}${BEL}`;

/** OSC 9;4;3 — progress with no known end. */
export const progressSeq = () => `${ESC}]9;4;3${BEL}`;

/** OSC 9;4;0 — remove the indicator. */
export const clearProgressSeq = () => `${ESC}]9;4;0${BEL}`;

/** XTWINOPS 22/23: push and pop the title, so exit can hand back the user's own. */
export const pushTitleSeq = () => `${ESC}[22;0t`;
export const popTitleSeq = () => `${ESC}[23;0t`;

export const bellSeq = () => BEL;

/**
 * Whether to emit anything at all. A pipe or file would receive the raw
 * escapes as text; `dumb` terminals print them as garbage.
 */
export function termStatusEnabled({ stream = process.stdout, env = process.env, enabled = true } = {}) {
  if (!enabled) return false;
  if (!stream?.isTTY) return false;
  const term = env.TERM;
  return !(term !== undefined && term.toLowerCase() === 'dumb');
}

/**
 * The state machine. `working()` begins a turn, `approval()` marks a prompt
 * waiting on the user, `ready()` ends the turn and `restore()` leaves the
 * terminal as found. All idempotent, all cheap to call when disabled.
 *
 * BEL rings when a turn ran at least `bellAfterMs` — the only proxy available
 * for "the person has probably looked away" — either as it finishes or when an
 * approval prompt appears in such a turn. Once per transition, never in a loop.
 */
export function termStatus({
  stream = process.stdout, env = process.env, enabled = true,
  bellAfterMs = 10000, now = Date.now,
} = {}) {
  if (!termStatusEnabled({ stream, env, enabled })) {
    return { active: false, working() {}, approval() {}, ready() {}, restore() {} };
  }

  let pushed = false;
  let startedAt = null;
  let state = null;

  const emit = (s) => { try { stream.write(s); } catch { /* a closed stream is not worth dying for */ } };
  const long = () => startedAt !== null && now() - startedAt >= bellAfterMs;

  const enter = (next, title, progress) => {
    if (!pushed) { emit(pushTitleSeq()); pushed = true; }
    state = next;
    emit(titleSeq(title) + (progress ? progressSeq() : clearProgressSeq()));
  };

  return {
    active: true,
    working() {
      if (state === 'working') return;
      if (startedAt === null) startedAt = now();
      enter('working', TITLES.working, true);
    },
    approval() {
      if (state === 'approval') return;
      const ring = long();
      enter('approval', TITLES.approval, false);
      if (ring) emit(bellSeq());
    },
    ready() {
      if (state === 'ready' || state === null) return;
      const ring = long();
      startedAt = null;
      enter('ready', TITLES.ready, false);
      if (ring) emit(bellSeq());
    },
    restore() {
      if (!pushed) return;
      pushed = false;
      state = null;
      startedAt = null;
      emit(clearProgressSeq() + popTitleSeq());
    },
  };
}
