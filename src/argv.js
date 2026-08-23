/**
 * Command-line parsing, kept out of index.js so it can be imported and tested
 * without running the program.
 *
 * One left-to-right pass, each token consumed exactly once. The multi-pass
 * version this replaces spliced tokens out of argv in source order, so
 * `--model --no-think x` had already lost `--no-think` by the time the model
 * option looked at its neighbour and happily took the prompt as a model id.
 */

/**
 * The one place that knows how an option is spelled. Both the parser and the
 * "did you mean" suggestion read from it, so a new option cannot be understood
 * by one and unknown to the other.
 *
 * kind: 'flag' takes nothing, 'value' requires the next token, 'optional' takes
 * the next token only when it does not look like an option.
 */
const SPECS = [
  { names: ['-h', '--help'], kind: 'flag', key: 'help' },
  { names: ['-l', '--models', '--list'], kind: 'flag', key: 'models' },
  { names: ['--mcp-list'], kind: 'flag', key: 'mcpList' },
  { names: ['--no-context'], kind: 'flag', key: 'noContext' },
  { names: ['--no-compact'], kind: 'flag', key: 'noCompact' },
  { names: ['--no-warm'], kind: 'flag', key: 'noWarm' },
  { names: ['--no-think'], kind: 'flag', key: 'noThink' },
  { names: ['-a', '--auto'], kind: 'flag', key: 'auto' },
  { names: ['-y', '--yes'], kind: 'flag', key: 'yes' },
  { names: ['--dry-run'], kind: 'flag', key: 'dryRun' },
  { names: ['-m', '--model'], kind: 'value', key: 'model' },
  { names: ['--steps'], kind: 'value', key: 'steps' },
  { names: ['--context'], kind: 'value', key: 'context' },
  { names: ['--mcp'], kind: 'optional', key: 'mcp' },
];

const BY_NAME = new Map(SPECS.flatMap((s) => s.names.map((n) => [n, s])));

/** Every recognised spelling, sorted so suggestions break ties predictably. */
export const KNOWN = [...BY_NAME.keys()].sort();

/**
 * A leading dash with no whitespace after it. The no-whitespace part is what
 * keeps prose working: `kronk-cli "- fix the dashes bug"` is one argv token and
 * whoever typed it has no idea an escape hatch exists. A bare `-` is left alone
 * too — it is the conventional stdin placeholder.
 */
const OPTIONISH = /^-\S+$/;

const STEPS_WORDS = /^(0|off|none|inf|unlimited)$/i;

/** Plain Levenshtein distance. Small inputs, no dependency, no cleverness. */
function distance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const sub = prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      row[j] = Math.min(row[j - 1] + 1, prev[j] + 1, sub);
    }
    prev = row;
  }
  return prev[b.length];
}

/**
 * The flag an unknown token was probably meant to be, or null.
 *
 * A wrong suggestion is worse than none, so only two rules apply: one more dash
 * turns it into a known flag (`-auto` → `--auto`, the whole observed failure
 * mode), or it is within two edits of a known flag — nearest first, ties broken
 * alphabetically so the same typo always gets the same answer.
 */
export function suggest(token) {
  if (BY_NAME.has(`-${token}`)) return `-${token}`;
  let best = null;
  let bestAt = 3;
  for (const name of KNOWN) {           // sorted, so the first of a tie wins
    const d = distance(token, name);
    if (d < bestAt) { best = name; bestAt = d; }
  }
  return best;
}

const unknown = (token) => {
  const hint = suggest(token);
  return [
    `unknown option: ${token}`,
    ...(hint ? [`did you mean ${hint}?`] : []),
    'kronk-cli --help for the full list',
  ].map((l) => `  ${l}`).join('\n');
};

/**
 * Parse argv into a plain result. Never prints, never exits: the caller decides
 * what a usage error looks like, which is what makes this testable.
 *
 * On a usage error `error` is the message to print, and nothing else in the
 * result should be acted on.
 */
export function parseArgv(argv) {
  const out = {
    error: null,
    help: false, models: false, mcpList: false,
    noContext: false, noCompact: false, noWarm: false, noThink: false,
    auto: false, yes: false, dryRun: false,
    model: null,
    context: null,
    steps: null,
    mcp: false, mcpNames: null,
    words: [],
  };
  const fail = (message) => ({ ...out, error: message });

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];

    // Consumed here, before the unknown-option check below can ever see it.
    if (token === '--') { out.words.push(...argv.slice(i + 1)); break; }

    const spec = BY_NAME.get(token);
    if (!spec) {
      if (OPTIONISH.test(token)) return fail(unknown(token));
      out.words.push(token);            // prose, or a bare word for a subcommand
      continue;
    }

    if (spec.kind === 'flag') { out[spec.key] = true; continue; }

    const next = argv[i + 1];
    if (spec.kind === 'optional') {
      out.mcp = true;
      if (next !== undefined && !next.startsWith('-')) {
        out.mcpNames = next.split(',').map((x) => x.trim()).filter(Boolean);
        i++;
      }
      continue;
    }

    // 'value': the option must get one. `--steps -1` lands here rather than in
    // the value check below — one uniform rule, one predictable message.
    if (next === undefined || OPTIONISH.test(next)) {
      return fail(`  ${token} needs a value`);
    }
    i++;

    if (spec.key === 'steps') {
      // An unparseable cap used to become NaN, which read as "unlimited" — the
      // most permissive answer possible, in a tool that runs shell commands.
      if (STEPS_WORDS.test(next)) out.steps = Infinity;
      else if (/^\d+$/.test(next)) out.steps = Number(next);
      else {
        return fail('  --steps takes a non-negative integer, or one of: 0, off, none, inf, unlimited');
      }
      continue;
    }
    out[spec.key] = next;
  }

  return out;
}
