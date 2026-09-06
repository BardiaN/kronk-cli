/**
 * Markdown, rendered for the terminal as it streams.
 *
 * The models write markdown whether or not anything is going to render it, so
 * an answer arrived as `### The letter is a notification` and `**binding**`
 * with the punctuation left in the reader's way. This turns the handful of
 * constructs that actually show up in an answer — headings, emphasis, code,
 * lists, quotes, rules, links — into the attributes a terminal already has.
 *
 * Deliberately not a markdown parser. It is a line renderer with one bit of
 * state, whether a fenced code block is open, which is all that spans lines in
 * the subset above. Anything it does not recognise is left exactly as written,
 * which is the only safe answer for text that was never markdown to begin with.
 *
 * Line-buffered, because inline emphasis cannot be decided until the line is
 * whole: `**` is bold or two asterisks depending on what comes next. Output
 * therefore appears a line at a time rather than a token at a time. With colour
 * off — piped, redirected, NO_COLOR — nothing is rewritten at all and the bytes
 * are the model's own.
 */
import { c } from './ui.js';
import { colorsOn } from './theme.js';

const FENCE = /^\s*(?:```|~~~)\s*([\w+-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,9})([.)])\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const RULE = /^\s*([-*_])(?:\s*\1){2,}\s*$/;

/** How wide a `---` is drawn. Narrow enough to sit inside any terminal. */
const RULE_WIDTH = 40;

/**
 * Inline spans, in one pass over the parts that are not code.
 *
 * Code first and separately: whatever is between backticks is content, not
 * markup, and running the emphasis rules over it would eat the asterisks in a
 * `**kwargs` or a glob.
 */
export function renderInline(text) {
  return text
    .split(/(`[^`]+`)/)
    .map((part, i) => {
      if (i % 2) return c.cyan(part.slice(1, -1));
      return part
        // Links before emphasis: the label can contain either.
        .replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, label, url) => `${c.blue(label)} ${c.grey(url)}`)
        .replace(/\*\*([^\s*][^*]*?)\*\*/g, (_, s) => c.bold(s))
        .replace(/__([^\s_][^_]*?)__/g, (_, s) => c.bold(s))
        .replace(/~~([^\s~][^~]*?)~~/g, (_, s) => c.strike(s))
        // Emphasis last, and only where the marker is not part of a word:
        // snake_case identifiers and 3 * 4 must survive unchanged.
        .replace(/(^|[\s(])\*([^\s*][^*]*?)\*(?=$|[\s).,;:!?])/g, (_, pre, s) => `${pre}${c.italic(s)}`)
        .replace(/(^|[\s(])_([^\s_][^_]*?)_(?=$|[\s).,;:!?])/g, (_, pre, s) => `${pre}${c.italic(s)}`);
    })
    .join('');
}

/**
 * One line, given the state carried from the lines before it. Mutates `state`,
 * which is what a fenced block needs and the only reason state exists.
 */
export function renderLine(line, state) {
  const fence = FENCE.exec(line);
  if (fence) {
    if (state.fence) { state.fence = null; return c.grey('  ╰────'); }
    state.fence = fence[1] || 'code';
    return c.grey(`  ╭─ ${state.fence}`);
  }
  // Inside a fence every character is the code's own — no emphasis, no
  // reflowing, just a gutter to show where the block runs.
  if (state.fence) return `${c.grey('  │ ')}${line}`;

  if (RULE.test(line)) return c.grey('─'.repeat(RULE_WIDTH));

  const heading = HEADING.exec(line);
  if (heading) {
    const [, hashes, body] = heading;
    const text = c.bold(renderInline(body));
    return hashes.length <= 2 ? c.cyan(text) : text;
  }

  const quote = QUOTE.exec(line);
  if (quote) return `${c.grey('│ ')}${c.grey(renderInline(quote[1]))}`;

  const bullet = BULLET.exec(line);
  if (bullet) return `${bullet[1]}${c.grey('•')} ${renderInline(bullet[2])}`;

  const ordered = ORDERED.exec(line);
  if (ordered) {
    const [, indent, n, , rest] = ordered;
    return `${indent}${c.grey(`${n}.`)} ${renderInline(rest)}`;
  }

  return renderInline(line);
}

/**
 * A renderer for streamed text: feed it deltas, write what comes back, and
 * call `flush` when the stream ends to get the last partial line.
 *
 * `enabled` defaults to whether colour is on at all, so the piped and
 * NO_COLOR paths hand back exactly what the model wrote.
 */
export function markdownStream({ enabled = colorsOn() } = {}) {
  const state = { fence: null };
  let held = '';
  return {
    write(chunk) {
      if (!enabled) return chunk;
      held += chunk;
      let out = '';
      let at;
      while ((at = held.indexOf('\n')) !== -1) {
        out += `${renderLine(held.slice(0, at), state)}\n`;
        held = held.slice(at + 1);
      }
      return out;
    },
    flush() {
      if (!enabled || !held) { const rest = enabled ? '' : held; held = ''; return rest; }
      const out = renderLine(held, state);
      held = '';
      return out;
    },
    /** Whether a fenced block is still open — the tail of a truncated answer. */
    get inCode() { return state.fence !== null; },
  };
}

/** The whole thing at once. The streaming path is the one the REPL uses. */
export function renderMarkdown(text, options) {
  const md = markdownStream(options);
  return md.write(text) + md.flush();
}
