import { c } from './ui.js';

/**
 * The checklist for the task currently being run.
 *
 * Module state rather than a message, because `compactInto` splices the whole
 * transcript when the window fills — a plan that lived only in `messages`
 * would be summarised away on exactly the long runs that need it. What the
 * model sees each round is a reminder *message*, which is expendable: it is
 * rebuilt from here whenever it is missing.
 */

/** Long enough for any real ticket; short enough that a runaway list is caught. */
export const MAX_ITEMS = 40;

const STATUSES = ['todo', 'doing', 'done'];

/**
 * Every reminder message starts with this, so the one already in `messages`
 * can be found and replaced instead of a second copy being appended.
 */
export const REMINDER_TAG = 'CHECKLIST —';

let items = [];

export const plan = () => items;
export const openItems = () => items.filter((i) => i.status !== 'done');

/** Called at the start of every turn: a plan belongs to one task, not to a session. */
export function clearPlan() { items = []; }

/** The stored plan as text — what `set_plan` hands back, so the model sees what it committed to. */
export function render() {
  if (!items.length) return 'plan: (empty)';
  const done = items.length - openItems().length;
  const rows = items.map((i, n) => `${n + 1}. [${i.status}] ${i.text}`);
  return [`plan — ${done}/${items.length} done`, ...rows].join('\n');
}

/**
 * Replace the checklist wholesale.
 *
 * Full replacement, never a patch: partial-update semantics are where a small
 * model quietly drops half its list. Overlong lists are cut rather than
 * refused, and the loss is reported back in the result so it is not silent.
 */
export function setPlan(raw) {
  if (!Array.isArray(raw)) throw new Error('set_plan needs an "items" array of {text, status}');

  const kept = raw.slice(0, MAX_ITEMS).map((item, n) => {
    const text = String(item?.text ?? '').trim();
    if (!text) throw new Error(`set_plan: item ${n + 1} has no text`);
    const status = item.status ?? 'todo';
    if (!STATUSES.includes(status)) {
      throw new Error(`set_plan: item ${n + 1} has status "${status}" — use todo, doing or done`);
    }
    return { text, status };
  });

  items = kept;
  const dropped = raw.length - kept.length;
  if (!dropped) return render();
  return `${render()}\n\nnote: ${raw.length} items were sent and the list is capped at ${MAX_ITEMS}`
    + `, so the last ${dropped} were dropped. Send a shorter plan if they matter.`;
}

const MARK = { todo: '·', doing: '▸', done: '✓' };

/** The plan on screen: one line each, greyed except whatever is being worked on. */
export function planLines() {
  return items.map((i) => {
    const line = `    ${MARK[i.status]} ${i.text}`;
    return i.status === 'doing' ? line : c.grey(line);
  });
}

/** What was left unfinished, in yellow, when the turn ends anyway. */
export function outstandingLines() {
  const open = openItems();
  if (!open.length) return [];
  return [
    c.yellow(`  ⚠ ${open.length} of ${items.length} checklist items were not finished:`),
    ...open.map((i) => c.yellow(`    ${MARK[i.status]} ${i.text}`)),
  ];
}

const tally = () => `${items.length - openItems().length}/${items.length} items done`;
const openLines = () => openItems().map((i) => `- [${i.status}] ${i.text}`);

function reminderText() {
  return [
    `${REMINDER_TAG} ${tally()}. Still open:`,
    ...openLines(),
    'Keep working through them, and record each one with set_plan as it is finished.',
  ].join('\n');
}

function nudgeText() {
  return [
    `${REMINDER_TAG} you stopped with work outstanding. ${tally()}. Still open:`,
    ...openLines(),
    'Do not summarise yet. Carry on with the next open item. If one genuinely cannot be'
    + ' done, say in your reply why not, and only then mark it done with set_plan.',
  ].join('\n');
}

export const isReminder = (m) =>
  m?.role === 'user' && typeof m.content === 'string' && m.content.startsWith(REMINDER_TAG);

/** Remove the reminder wherever it sits. Safe to call when there is none. */
export function dropReminder(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (isReminder(messages[i])) messages.splice(i, 1);
  }
}

/**
 * Leave exactly one reminder, at the end of the round.
 *
 * The end is *after* the last `role: 'tool'` message, which is the only place
 * it can go: an assistant message carrying `tool_calls` and its tool replies
 * have to stay adjacent, or an OpenAI-compatible server rejects the request
 * and a Qwen-family chat template renders nonsense. The tail gives the same
 * recency with no ordering violation.
 *
 * Removed and re-pushed rather than edited in place, so the array can never
 * accumulate copies however many rounds run. `role: 'user'` because a local
 * model weights a second `system` message unpredictably.
 */
export function syncReminder(messages, { nudge = false } = {}) {
  dropReminder(messages);
  if (!openItems().length) return;
  messages.push({ role: 'user', content: nudge ? nudgeText() : reminderText() });
}
