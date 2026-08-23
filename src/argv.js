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
 * The one place that knows how an option is spelled. It was implicit in the
 * flag() and opt() call sites before, which is no place for a list that
 * anything else might need to read.
 *
 * kind: 'flag' takes nothing, 'value' takes the next token, 'optional' takes
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
  { names: ['-m', '--model'], kind: 'value', key: 'model' },
  { names: ['--steps'], kind: 'value', key: 'steps' },
  { names: ['--mcp'], kind: 'optional', key: 'mcp' },
];

const BY_NAME = new Map(SPECS.flatMap((s) => s.names.map((n) => [n, s])));

const STEPS_WORDS = /^(0|off|none|inf|unlimited)$/i;

/**
 * Parse argv into a plain result. Never prints, never exits: the caller decides
 * what to do with what it finds, which is what makes this testable.
 */
export function parseArgv(argv) {
  const out = {
    help: false, models: false, mcpList: false,
    noContext: false, noCompact: false, noWarm: false, noThink: false,
    auto: false, yes: false,
    model: null,
    steps: null,
    mcp: false, mcpNames: null,
    words: [],
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];

    // Everything after a literal `--` is prompt text, dashes and all.
    if (token === '--') { out.words.push(...argv.slice(i + 1)); break; }

    const spec = BY_NAME.get(token);
    if (!spec) { out.words.push(token); continue; }

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

    if (next === undefined) continue;
    i++;
    if (spec.key === 'steps') out.steps = STEPS_WORDS.test(next) ? Infinity : Number(next);
    else out[spec.key] = next;
  }

  return out;
}
