/**
 * What happens when a gated tool call needs approval — as a pure decision, so
 * the three places that answer it (the REPL, one-shot, a rescue worker) cannot
 * drift apart and the rule is testable without a terminal.
 *
 * Three modes, not two. `ask` is "put the question to whoever is here", which
 * in one-shot and rescue already means refusing because nobody is. `deny` is
 * the same refusal made on purpose and *said so to the model*: a plain "no"
 * reads as a person who might change their mind, so the model asks again or
 * stalls, where "your settings deny this" tells it to take another route.
 */

/** What `approve()` resolves to when settings, not a person, said no. */
export const DENIED_BY_SETTINGS = 'deny';

/**
 * Pick the mode from the flags and the configured default.
 *
 * `--deny` with `--yes`/`--auto` is a contradiction on the command line and an
 * error. A configured default (`denyUnapproved`, KRONK_DENY_UNAPPROVED) is not
 * a flag the user typed this time, so an explicit `--yes`/`--auto` overrides
 * it — otherwise setting it once would make those flags unusable.
 */
export function resolveApprovalMode({ yes = false, auto = false, deny = false, denyDefault = false } = {}) {
  if (deny && (yes || auto)) {
    return {
      mode: null,
      error: `  --deny cannot be combined with ${auto ? '--auto' : '--yes'}: one approves every tool, the other refuses them`,
    };
  }
  if (yes || auto) return { mode: 'allow', error: null };
  if (deny || denyDefault) return { mode: 'deny', error: null };
  return { mode: 'ask', error: null };
}

/**
 * The verdict for one call that needs approval. `ask` is not decided here: it
 * returns null and the caller prompts (or refuses, when it has no one to ask).
 */
export function decideApproval(mode) {
  if (mode === 'allow') return true;
  if (mode === 'deny') return DENIED_BY_SETTINGS;
  return null;
}

/** The tool result the model gets for a call settings refused. */
export function deniedBySettingsMessage(name) {
  return `error: the user's settings deny ${name} without approval, and nobody is available to approve it. `
    + 'Do not retry it; continue another way with the tools that are allowed, or report what you could not do.';
}
