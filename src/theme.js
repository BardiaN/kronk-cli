/**
 * What colour to print in, given the terminal we were launched from.
 *
 * The status line, the context meter and every hint under it were bright black
 * (SGR 90). On a light background that is a readable grey; on a dark one most
 * terminals render it around #555, which is a few points of contrast away from
 * the background it sits on — the line the REPL shows before every prompt was
 * the hardest thing on screen to read. Bright black is the only grey the
 * sixteen-colour palette has, so the fix is not a different code but a
 * different palette per background, chosen from the 256-colour cube.
 *
 * Three ways to learn the background, in order of how much we trust them:
 * what the user said (`KRONK_THEME`, `theme` in ~/.kronk-cli.json), what the
 * terminal advertises (`COLORFGBG`), and what it answers when asked (OSC 11).
 * The last one is a round trip over the tty, so it happens once at startup and
 * never blocks for longer than a blink.
 */

/**
 * Palettes, as SGR parameters. Each is chosen for contrast against its own
 * background, not for fidelity to the sixteen-colour name it replaces: `red`
 * on a light background is a darker red than on a dark one, and both are still
 * unmistakably red.
 *
 * The `grey`/`dim` pair is the whole point. 245 on dark and 242 on light both
 * land near 4.5:1 against a typical terminal background, where 90 on dark is
 * closer to 1.9:1.
 */
export const PALETTES = {
  256: {
    dark: {
      dim: '38;5;244', bold: '1', italic: '3', strike: '9',
      red: '38;5;203', green: '38;5;114', yellow: '38;5;221', blue: '38;5;111',
      magenta: '38;5;176', cyan: '38;5;116', grey: '38;5;245',
    },
    light: {
      dim: '38;5;244', bold: '1', italic: '3', strike: '9',
      red: '38;5;160', green: '38;5;28', yellow: '38;5;136', blue: '38;5;26',
      magenta: '38;5;90', cyan: '38;5;30', grey: '38;5;242',
    },
  },
  // Sixteen colours: no cube to pick from, so the only lever is whether a hue
  // comes from the normal or the bright half. Light keeps exactly what this
  // program printed before the palettes existed.
  16: {
    dark: {
      dim: '37', bold: '1', italic: '3', strike: '9',
      red: '91', green: '92', yellow: '93', blue: '94',
      magenta: '95', cyan: '96', grey: '37',
    },
    light: {
      dim: '90', bold: '1', italic: '3', strike: '9',
      red: '31', green: '32', yellow: '33', blue: '34',
      magenta: '35', cyan: '36', grey: '90',
    },
  },
};

/** Anything we cannot classify is dark: it is what most terminals ship as. */
export const DEFAULT_THEME = 'dark';

const THEMES = new Set(['dark', 'light']);

/**
 * How many colours we may use. 0 means print no escapes at all, which is what
 * NO_COLOR, a dumb terminal, a redirected stdout and `FORCE_COLOR=0` each ask
 * for; any other FORCE_COLOR overrides the redirect, so a pipe into `less -R`
 * and the test suite can both see what a terminal would.
 */
export function colorDepth(env = process.env, stream = process.stdout) {
  if (env.NO_COLOR) return 0;
  if (env.TERM === 'dumb') return 0;
  if (env.FORCE_COLOR === '0') return 0;
  if (env.FORCE_COLOR === undefined && !stream?.isTTY) return 0;
  const term = env.TERM ?? '';
  if (env.COLORTERM || /-256(color)?\b/.test(term) || /^(alacritty|kitty|wezterm|xterm-ghostty)/.test(term)) {
    return 256;
  }
  return 16;
}

/**
 * The background as `COLORFGBG` describes it — `foreground;background`, or
 * `foreground;bold;background` from rxvt. The background is the last field,
 * as a palette index: the dark half of the sixteen, plus bright black, means
 * a dark terminal. `default` is the one honest answer some terminals give and
 * it tells us nothing, so it stays unclassified rather than guessed at.
 */
export function parseColorFgBg(value) {
  if (typeof value !== 'string') return null;
  const bg = value.split(';').pop()?.trim();
  if (!bg || !/^\d+$/.test(bg)) return null;
  const n = Number(bg);
  if (n > 15) return null;
  return [0, 1, 2, 3, 4, 5, 6, 8].includes(n) ? 'dark' : 'light';
}

/**
 * The reply to an OSC 11 query: `ESC ] 11 ; rgb:RRRR/GGGG/BBBB`, an optional
 * alpha component, then BEL or ST. Components are 1 to 4 hex digits wide
 * depending on the terminal — xterm answers in 16 bits, others in 8.
 */
// eslint-disable-next-line no-control-regex -- ESC is what the reply starts with
const OSC11 = /\x1b\]11;rgba?:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})(?:\/[0-9a-f]{1,4})?(?:\x07|\x1b\\)?/i;

/**
 * The reply found in `buf`: its relative luminance, and where it sat, so the
 * caller can hand back whatever else was in the buffer. Each component is
 * scaled by its own width — a short reply is not a near-black one.
 */
function matchOsc11(buf) {
  const m = typeof buf === 'string' ? OSC11.exec(buf) : null;
  if (!m) return null;
  const [r, g, b] = m.slice(1, 4).map((h) => parseInt(h, 16) / (16 ** h.length - 1));
  return {
    luminance: 0.2126 * r + 0.7152 * g + 0.0722 * b,
    rest: buf.slice(0, m.index) + buf.slice(m.index + m[0].length),
  };
}

/** The relative luminance of an OSC 11 reply, or null if this is not one. */
export function parseOsc11(reply) {
  return matchOsc11(reply)?.luminance ?? null;
}

/** Mid-grey is the boundary; a terminal sitting exactly on it reads as light. */
export const themeForLuminance = (lum) => (lum >= 0.5 ? 'light' : 'dark');

/**
 * A theme somebody named, or null for "work it out". `auto` is spelled out
 * rather than left to an empty value so a config file can turn a forced theme
 * back off without deleting the key, and a typo falls through to detection
 * rather than pinning the wrong palette.
 */
export const namedTheme = (value) => {
  const asked = String(value ?? '').trim().toLowerCase();
  return THEMES.has(asked) ? asked : null;
};

/** What the environment alone can tell us, or null for "ask the terminal". */
export function detectTheme(env = process.env) {
  return namedTheme(env.KRONK_THEME) ?? parseColorFgBg(env.COLORFGBG);
}

/**
 * Ask the terminal for its background colour and wait, briefly.
 *
 * This puts stdin in raw mode for as long as the answer takes, so it runs
 * once, before the REPL's readline exists, and only when both ends are a tty.
 * A terminal that does not implement OSC 11 says nothing at all, which is why
 * there is a timeout rather than a sentinel to wait for; 100 ms is far longer
 * than a local round trip and short enough to be invisible.
 *
 * Anything read that is not part of the reply is somebody typing ahead, and it
 * is pushed back onto stdin before this resolves. Without that, a fast typist
 * — or a script piping commands in — loses whatever landed in the window, and
 * loses it silently.
 */
export function probeBackground({ input = process.stdin, output = process.stdout, timeoutMs = 100 } = {}) {
  if (!input?.isTTY || !output?.isTTY || typeof input.setRawMode !== 'function') {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const wasRaw = input.isRaw;
    let buf = '';
    let settled = false;
    const finish = (value, rest) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      input.off('data', onData);
      if (!wasRaw) input.setRawMode(false);
      input.pause();
      if (rest) input.unshift?.(Buffer.from(rest, 'latin1'));
      resolve(value);
    };
    const onData = (chunk) => {
      buf += chunk.toString('latin1');
      const hit = matchOsc11(buf);
      if (hit) finish(themeForLuminance(hit.luminance), hit.rest);
      // Whatever this is, it is not the reply and no longer plausibly the
      // start of one. Stop reading and give it back.
      else if (buf.length > 64) finish(null, buf);
    };
    const timer = setTimeout(() => finish(null, buf), timeoutMs);
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
    output.write('\x1b]11;?\x07');
  });
}

let depth = colorDepth();
let active = detectTheme() ?? DEFAULT_THEME;

/** Which palette is in force. Read by the tests and by `/theme`. */
export const theme = () => active;

/** Depth 0 means every colour helper is the identity function. */
export const colorsOn = () => depth > 0;

/** Set both explicitly. Tests use it; nothing in the program has to guess. */
export function useTheme({ name, colors } = {}) {
  if (THEMES.has(name)) active = name;
  if (colors !== undefined) depth = colors ? (colors === true ? 256 : colors) : 0;
  return active;
}

/**
 * Settle the palette for this session: what the user asked for, what the
 * environment said, or failing both what the terminal answers. Startup awaits this once; everything that
 * prints reads `ansi` per call, so the banner and every later line agree.
 */
export async function resolveTheme({ prefer, ...options } = {}) {
  const known = namedTheme(prefer) ?? detectTheme();
  if (known) { active = known; return active; }
  if (depth === 0) return active;              // nothing to colour, don't touch the tty
  active = (await probeBackground(options)) ?? DEFAULT_THEME;
  return active;
}

/** The SGR parameters for a palette entry, or null when colour is off. */
export function ansi(name) {
  if (depth === 0) return null;
  return PALETTES[depth === 256 ? 256 : 16][active][name] ?? null;
}
