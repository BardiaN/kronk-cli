/**
 * Steering: guidance typed while a turn is running.
 *
 * The REPL collects lines into a plain array while the agent works (see the
 * `steer` hook in src/prompt.js); `runTurn` empties it into the transcript at
 * the one point where that is safe — after every tool result of a round is in,
 * before the next request goes out. Anywhere earlier would put a user message
 * between a tool call and its result, which the chat template rejects.
 */

/** Marks the message as guidance for the work in progress, not a new task. */
const PREFIX = 'The user added this while you were working. Take it into account and carry on:\n\n';

/**
 * Move every queued line into `messages` as user messages, oldest first.
 * Mutates both arguments and returns how many were injected. Blank lines are
 * dropped rather than injected.
 */
export function drainSteering(messages, queue) {
  if (!queue?.length) return 0;
  let n = 0;
  for (const line of queue.splice(0)) {
    const text = String(line).trim();
    if (!text) continue;
    messages.push({ role: 'user', content: PREFIX + text });
    n += 1;
  }
  return n;
}

/**
 * Whether a line typed mid-turn is guidance. A slash command is not: running
 * `/clear` under a live turn would pull the transcript out from under it, so
 * those wait for the prompt like any other typed-ahead line.
 */
export function isSteering(line) {
  const t = String(line).trim();
  return t !== '' && !t.startsWith('/');
}
