import { config } from './config.js';

/**
 * Index of the last *real* user message, or -1 when there is none.
 *
 * Tool results are `role: 'tool'`, so they do not move it: one user prompt and
 * the whole tool loop it kicked off share a single boundary. That is the same
 * boundary the Qwen3.6 template computes as `ns.last_query_index`, on purpose —
 * see `forRequest` below.
 */
export function lastUserIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') return i;
  }
  return -1;
}

/**
 * Whether this request should carry the current task's reasoning back.
 *
 * `auto` is autonomous mode, the same flag `runTurn` already threads through
 * for the task-plan nudge — not a second source of truth for "am I
 * autonomous". The default this resolves to is autonomous-only: with no
 * override, `config.replayReasoning` is `undefined` and `auto` alone decides.
 * `config.replayReasoning` set to `true` or `false` overrides that default in
 * either direction — replay on in the REPL, or off in `--auto` — which is why
 * it is read as three states in src/config.js rather than coerced to a
 * boolean. See that default's rationale on `forRequest` below.
 *
 * Read per request, because `/think` flips `noThink` mid-session.
 *
 * Gated on `templatePreservesThinking` — the same startup detection the
 * `preserve_thinking` request field already uses — because a template that
 * does not declare the parameter is also not one that reads
 * `message.reasoning_content`: it drops the blocks on the floor and the replay
 * is pure prompt overhead for nothing.
 *
 * Deliberately *not* gated on `config.preserveThinking`. That flag only pins
 * the blocks at or before the boundary; everything after it renders under the
 * template's own `loop.index0 > ns.last_query_index` arm regardless. On the
 * fixture measured under `forRequest`, `preserve_thinking: false` still costs
 * the same +107 tokens for the current tool loop, and costs nothing at all for
 * the history the template throws away. The pin and the replay answer
 * different questions; turning one off must not silently turn the other off.
 */
export const shouldReplayReasoning = (auto = false) =>
  (config.replayReasoning ?? auto) && config.templatePreservesThinking && !config.noThink;

/**
 * The message list as it goes on the wire: reasoning is kept for the assistant
 * messages that belong to the current tool loop and stripped from every one at
 * or before the last real user message.
 *
 * ---- why this boundary and not another ----
 *
 * Within one task the model reasons about tool result N before it chooses tool
 * N+1. Dropping that, which is what this agent did before, makes it re-derive
 * its plan from the tool output alone at every step; that is the loss that
 * actually degrades agentic behaviour.
 *
 * Current-turn reasoning is append-only. Those tokens are new on every step
 * anyway, so they were never part of the cached prefix and replaying them
 * costs nothing in cache terms.
 *
 * Historical reasoning is prefix-resident. It inflates the cached prefix
 * permanently and eats window. This agent compacts at 85% of the window, every
 * compaction invalidates the cached prefix and forces a full prefill, so
 * replaying all of history would partly undo the prefix stability that sending
 * `preserve_thinking` bought.
 *
 * It also matches how the Messages API treats thinking alongside tool use:
 * thinking is passed back with the tool result inside the turn, while earlier
 * turns' blocks are stripped.
 *
 * Measured against Kronk 1.31.9 on the /AGENT profile, on a fixture of two
 * user turns and a two-call tool loop, `preserve_thinking: true`: dropping all
 * reasoning 207 prompt tokens, this policy 314 (+107), replaying all of
 * history 368 (+161). The +54 that separates the last two is the part that
 * would sit in the prefix for the rest of the session and grow with it.
 *
 * ---- why autonomous-only, not on everywhere ----
 *
 * The cost above lands at the *next* prompt, not this one: stripping the
 * previous task's blocks at the boundary rewrites the prefix a newer user
 * message sits after, which throws away the cached prefix and forces a full
 * re-prefill. Measured on a live server, first turn after a second prompt,
 * prompt tokens cached vs. re-prefilled:
 *
 *     never replay        cached 906, re-prefill  60
 *     replay current task cached 757, re-prefill 516   <- cache reset to the system prompt
 *     replay everything   cached 1827, re-prefill 367
 *
 * `--auto` runs exactly one user prompt through the whole tool loop, so that
 * boundary is never crossed in a run: this policy's within-task benefit is
 * free there, and the reset above never happens. The REPL is a user typing
 * repeatedly, so every prompt after the first pays it — measured 4.4-7.4 s to
 * first token against 0.7-1.2 s once cached. Hence the default: on for
 * `--auto`, off for the REPL. `config.replayReasoning` overrides it either way
 * — see `shouldReplayReasoning` above.
 *
 * The array is rebuilt but the untouched messages are shared, not copied: the
 * caller's history keeps its reasoning for the steps that come next.
 */
export function forRequest(messages, auto = false) {
  const boundary = lastUserIndex(messages);
  const replay = shouldReplayReasoning(auto);
  return messages.map((m, i) => {
    if (m.reasoning_content === undefined) return m;
    // An empty string is stripped as well as dropped history: the template
    // renders an empty <think> block for a message that carries no reasoning
    // either way, so sending the key buys nothing and only invites a server
    // that validates it more strictly than this one to reject the request.
    if (replay && i > boundary && m.reasoning_content) return m;
    const stripped = { ...m };
    delete stripped.reasoning_content;
    return stripped;
  });
}
