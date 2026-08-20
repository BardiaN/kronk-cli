import { streamChat, tokenize } from './client.js';
import { config } from './config.js';
import { c } from './ui.js';

const PROMPT = `You are reading the raw output of a command another agent just ran.
Condense it into the smallest report that keeps every fact the agent needs.

Structure your reply exactly like this:

STATUS: one line — did it succeed or fail, and the headline numbers.
FAILURES: every error and warning, quoted verbatim, one per line. Write "none" if there were none.
NOTES: anything else that changes what the agent should do next. Usually empty.

Rules:
- Never soften or summarize an error. Copy the text, file paths, line numbers and codes exactly.
- Collapse repeated progress lines into a single count: "built 400 packages" — never list them.
- Drop progress bars, spinners, timings, dependency resolution noise, decorative output.
- If anything failed, STATUS must say so. Do not lead with partial success.
- Report only. No causes, no fixes, no suggestions.`;

/** Lines that almost always matter, whatever the summarizer decides. */
const SIGNAL = new RegExp([
  '\\berror\\b', '\\bfailed?\\b', '\\bfailure\\b', '\\bwarn(ing)?\\b',
  '\\bexception\\b', '\\btraceback\\b', '\\bpanic\\b', '\\bfatal\\b',
  '\\bassert', '\\bcannot\\b', '\\bunable to\\b', '\\bnot found\\b',
  '\\bdenied\\b', '\\btimed? ?out\\b', '\\bECONN', '\\bENOENT',
  'TS\\d{4}', '\\b[A-Z]{2,}\\d{3,}\\b',            // TS2345, ESLint-ish codes
  '^\\s*[✗✘×]', '\\bexit code\\b',
].join('|'), 'i');

const NOISE = /^\s*(\[[\d/ ]+\]|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]|\d+%|\s*$)/;

/**
 * Pull the lines that carry a failure straight out of the raw text.
 *
 * A summarizer reading ten thousand tokens of build chatter can miss three
 * error lines at the end — it did, and confidently reported "FAILURES: none".
 * Grep is not clever but it does not overlook things, so the needles are
 * extracted deterministically and the model's prose is what gets appended.
 */
export function keyLines(raw, limit = 60) {
  const hits = [];
  const seen = new Set();
  for (const line of raw.split('\n')) {
    const t = line.trimEnd();
    if (!t || NOISE.test(t) || !SIGNAL.test(t)) continue;
    const key = t.trim();
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push(t.length > 500 ? `${t.slice(0, 500)}…` : t);
    if (hits.length >= limit) { hits.push(`…(more matches suppressed)`); break; }
  }
  return hits;
}

/**
 * Summarize a large tool result in a throwaway context.
 *
 * The point is what does NOT happen: the raw output never enters the main
 * conversation, so a 40k-token build log costs the agent a few hundred tokens
 * instead of a third of its window. This call's own context is discarded.
 */
export async function distill(raw, { command, model, signal } = {}) {
  const tailKeep = 2000;
  let summary = '';

  for await (const ev of streamChat({
    model,
    messages: [{
      role: 'user',
      content: `Command: ${command ?? '(unknown)'}\n\n--- raw output ---\n${raw}\n--- end ---\n\n${PROMPT}`,
    }],
    signal,
    maxTokens: 1500,
    noThink: true,
  })) {
    if (ev.type === 'text') summary += ev.value;
  }

  const signals = keyLines(raw);
  const tail = raw.length > tailKeep ? raw.slice(-tailKeep) : raw;

  return [
    `[output distilled — ${raw.length.toLocaleString()} chars summarized in a separate context]`,
    '',
    signals.length
      ? `--- error/warning lines, extracted verbatim (authoritative) ---\n${signals.join('\n')}`
      : '--- no error or warning lines matched ---',
    '',
    summary.trim() ? `--- summary ---\n${summary.trim()}` : '',
    '',
    '--- last lines, verbatim ---',
    tail.trim(),
    '',
    'Trust the extracted lines over the summary if they disagree.',
  ].filter(Boolean).join('\n');
}

/** Worth distilling? Small results are cheaper left alone. */
export function shouldDistill(result) {
  return config.distill && typeof result === 'string' && result.length >= config.distillAt;
}

export async function maybeDistill(result, opts) {
  if (!shouldDistill(result)) return result;
  const before = await tokenize(opts.model, result);
  const digest = await distill(result, opts);
  if (!digest || digest.length >= result.length) return result;
  const after = await tokenize(opts.model, digest);
  console.log(c.grey(`    distilled ${before.toLocaleString()} → ${after.toLocaleString()} tokens (separate context)`));
  return digest;
}
