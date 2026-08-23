import { c } from './ui.js';

/**
 * The checklist for the task currently being run.
 *
 * Module state rather than a message, because `compactInto` splices the whole
 * transcript when the window fills — a plan that lived only in `messages`
 * would be summarised away on exactly the long runs that need it. What the
 * model sees each round is a snapshot of this store, appended to the tool
 * result that round produced; see `carryChecklist` for why it is appended and
 * never moved.
 */

/** Long enough for any real ticket; short enough that a runaway list is caught. */
export const MAX_ITEMS = 40;

const STATUSES = ['todo', 'doing', 'done'];

/** Every checklist snapshot and every nudge opens with this, so both are greppable. */
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

/**
 * The snapshot appended to a round's last tool result.
 *
 * Phrased as a point in time on purpose: earlier rounds keep the snapshot they
 * were given, so several sit in the history at once and only the last one is
 * current. Saying so is what stops a stale one being read as the truth.
 */
function snapshotText() {
  return [
    `${REMINDER_TAG} where the plan stands at this step. ${tally()}. Still open:`,
    ...openLines(),
    'An earlier snapshot above is out of date — this is the current one.',
    'Keep working through the open items, and record each one with set_plan as it is finished.',
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

/** A nudge is the only checklist text that is a message of its own. */
export const isNudge = (m) =>
  m?.role === 'user' && typeof m.content === 'string' && m.content.startsWith(REMINDER_TAG);

/** Tool results already carrying a snapshot, held by identity. */
const carried = new WeakSet();

/**
 * Append the checklist to the last tool result of the round that just ran.
 *
 * Append-only, and that is the entire point. This used to be a `user` message
 * of its own, spliced out of the middle of `messages` and re-pushed at the end
 * every round. Removing a message changes the rendered prompt from that point
 * on, and Kronk's incremental prompt cache cannot recover past the change: it
 * keeps the longest common prefix and re-prefills the rest. Measured over four
 * rounds against Kronk 1.31.9 with preserve_thinking on, moving the message
 * gave cached 0 / 607 / 607 / 607 with re-prefill 724 / 193 / 269 / 345 —
 * pinned at the first reminder and growing without bound — where appending
 * gives cached 607 / 715 / 814 / 913 with re-prefill 113 / 104 / 104 / 104.
 * In the field that was a median 14.3s to first token against 0.5s.
 *
 * So: never remove or move anything already in `messages`. Only append. A tool
 * result created this round has not been sent yet, so growing it extends the
 * prefix instead of rewriting it, and it is still the last thing the model
 * reads. Older rounds keep their own snapshot; going back to strip them is the
 * very edit that costs the cache.
 */
export function carryChecklist(messages) {
  if (!openItems().length) return;

  // The tail only. A `role: 'tool'` message further back belongs to a round
  // that has already gone out, and editing that is the eviction described
  // above. A round that produced no tool result has nowhere to put this.
  const last = messages.at(-1);
  if (last?.role !== 'tool') return;

  // Identity, not a search for the tag in the text: a tool result can hold the
  // tag legitimately — a grep of this file does — and appending twice to one
  // message is a bug, not a second snapshot.
  if (carried.has(last)) return;
  carried.add(last);
  last.content = `${last.content}\n\n${snapshotText()}`;
}

/**
 * Hand the open items back as a `user` message when the model stops early.
 *
 * This one stays a message, because a new message on the end is exactly what
 * the cache tolerates: everything before it is untouched. It is pushed and
 * never removed again.
 */
export function pushNudge(messages) {
  if (!openItems().length) return;
  messages.push({ role: 'user', content: nudgeText() });
}
