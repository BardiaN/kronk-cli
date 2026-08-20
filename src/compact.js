import { streamChat, tokenize } from './client.js';
import { config } from './config.js';
import { c } from './ui.js';

const PROMPT = `Summarize the conversation above so it can be continued in a fresh context.

Write it for your own future self, not for a human reader. Include, in this order:

1. What the user is trying to achieve, in their words where possible.
2. Decisions already made, and any the user explicitly rejected.
3. Files created or modified, with their paths and what each now does.
4. Commands that were run and what they showed — especially failures.
5. What is still outstanding.

Be specific: real paths, real function names, real error text. Omit pleasantries and
anything already superseded. Facts you drop are lost for good.`;

/**
 * Keep a transcript under `budget` tokens by removing the middle.
 *
 * The summarizer runs against the same context window that just overflowed, so
 * feeding it the whole transcript fails the same way. Head and tail are the
 * parts worth keeping: the goal is stated at the start, current state at the
 * end. ~4 chars per token is close enough for a safety margin.
 */
function fit(text, budgetTokens) {
  const cap = budgetTokens * 4;
  if (text.length <= cap) return { text, elided: 0 };
  const head = Math.floor(cap * 0.35);
  const tail = Math.floor(cap * 0.65);
  const dropped = text.length - head - tail;
  return {
    text: `${text.slice(0, head)}\n\n[…${dropped.toLocaleString()} characters elided…]\n\n${text.slice(-tail)}`,
    elided: dropped,
  };
}

/** Flatten a message list into something the model can read back. */
function transcript(messages) {
  return messages
    .filter((m) => m.role !== 'system')
    .map((m) => {
      if (m.role === 'tool') return `[tool result]\n${String(m.content).slice(0, 4000)}`;
      const calls = m.tool_calls?.length
        ? `\n[called ${m.tool_calls.map((t) => t.function.name).join(', ')}]`
        : '';
      return `${m.role}: ${m.content ?? ''}${calls}`;
    })
    .join('\n\n');
}

/**
 * Replace the conversation with a summary of itself, keeping the system message.
 *
 * Tool messages are dropped rather than carried over: they are only valid when
 * paired with the assistant tool_calls that produced them, and a partial carry
 * leaves orphaned tool_call_ids that the API rejects.
 */
export async function compact(messages, { model, signal } = {}) {
  const system = messages[0];
  const raw = transcript(messages);
  if (!raw.trim()) return { messages, before: 0, after: 0 };

  const before = await tokenize(model, [system.content, raw].join('\n'));

  // Leave room for the instruction and the summary itself.
  const window = config.contextWindow ?? 32768;
  const { text: body, elided } = fit(raw, Math.floor(window * 0.6));
  if (elided) console.log(c.grey(`  transcript too large for one pass — elided ${elided.toLocaleString()} chars from the middle`));

  let summary = '';
  for await (const ev of streamChat({
    model,
    messages: [
      { role: 'user', content: `${body}\n\n---\n\n${PROMPT}` },
    ],
    signal,
    maxTokens: Math.min(4096, config.maxTokens),
    noThink: true,
  })) {
    if (ev.type === 'text') summary += ev.value;
  }

  if (!summary.trim()) return { messages, before, after: before, failed: true };

  const next = [
    system,
    { role: 'user', content: `[context compacted — summary of the work so far]\n\n${summary.trim()}` },
    { role: 'assistant', content: 'Understood. Continuing from there.' },
  ];
  const after = await tokenize(model, next.map((m) => m.content).join('\n'));

  // A short conversation can summarize to something longer than itself. Keep
  // the original rather than paying tokens to lose detail.
  if (after >= before) return { messages, before, after, skipped: true };

  return { messages: next, before, after, summary: summary.trim() };
}

/** True when an API error is the context-window rejection. */
export const isOverflow = (e) =>
  /exceed(s)? context window|context window/i.test(e?.message ?? '');

export function report({ before, after, skipped }) {
  if (skipped) return c.grey(`  already compact (${before.toLocaleString()} tokens) — left as is`);
  const pct = Math.round((1 - after / before) * 100);
  return c.grey(`  compacted ${before.toLocaleString()} → ${after.toLocaleString()} tokens (−${pct}%)`);
}
