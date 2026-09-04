import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

// KRONK_CONFIG exists so tests never touch the real file. Everything here is
// read at module load, so a test that sets it must `await import()` rather than
// use a static import — a static one is hoisted and runs before the assignment.
const RC = process.env.KRONK_CONFIG ?? join(homedir(), '.kronk-cli.json');
const MODEL_CONFIG = join(homedir(), '.kronk', 'models', 'model_config.yaml');

function fileConfig() {
  try { return JSON.parse(readFileSync(RC, 'utf8')); } catch { return {}; }
}

const file = fileConfig();

/** Only ever used when neither the user nor the model's profile has a number. */
export const DEFAULT_MAX_TOKENS = 8192;

const maxTokensRaw = process.env.KRONK_MAX_TOKENS ?? file.maxTokens;

/** Used when nothing is passed on the command line or in the environment. */
export const DEFAULT_MODEL = 'unsloth/Qwen3.6-35B-A3B-UD-Q4_K_M/AGENT';

// Three states, not a boolean: unset means "no opinion, let src/reasoning.js
// pick the autonomous-only default"; set means "override it, in either
// direction". Collapsing unset into `true` or `false` here would make that
// distinction impossible to recover downstream.
const fileReplayReasoning = file.replayReasoning === undefined ? undefined : String(file.replayReasoning);
const replayReasoningRaw = process.env.KRONK_REPLAY_REASONING ?? fileReplayReasoning;

export const config = {
  baseUrl: process.env.KRONK_URL   ?? file.baseUrl ?? 'http://localhost:11435/v1',
  token:   process.env.KRONK_TOKEN ?? file.token   ?? 'kronk',
  model:   process.env.KRONK_MODEL ?? file.model   ?? null,   // null → DEFAULT_MODEL, then auto-pick
  maxTokens: Number(maxTokensRaw ?? DEFAULT_MAX_TOKENS),
  // Whether the number above is the user's answer or ours. When it is ours,
  // boot replaces it with whatever the chosen model's own /AGENT profile
  // allows — see applyLimits. Without this flag there is no way to tell a
  // deliberate 8192 from the default one, and the profile would silently
  // overrule a number the user typed.
  maxTokensExplicit: maxTokensRaw !== undefined,
  // Unlimited by default — a run stops when the model is done or you press Ctrl-C.
  // Set --steps / KRONK_MAX_STEPS to opt into a cap.
  maxSteps: Number(process.env.KRONK_MAX_STEPS ?? file.maxSteps ?? Infinity),
  showThinking: (process.env.KRONK_THINKING ?? String(file.showThinking ?? 'true')) !== 'false',
  noThink: (process.env.KRONK_NO_THINK ?? String(file.noThink ?? '')) === '1',
  // The chat template drops earlier <think> blocks once a newer user message
  // arrives, which rewrites the prefix and throws the whole session cache away.
  // Pinning them costs the tokens the blocks occupy and saves the re-prefill.
  preserveThinking:
    (process.env.KRONK_PRESERVE_THINKING ?? String(file.preserveThinking ?? 'true')) !== 'false',
  // Send the current task's own reasoning back with each tool-loop step, so
  // the model does not re-derive its plan from tool output alone every time.
  // Earlier turns are dropped at the boundary the template already uses —
  // src/reasoning.js has the full argument, including why the *default* for
  // this is computed there from `auto`, not here as a plain boolean.
  // `undefined` here means "no override": src/reasoning.js decides. `true`
  // or `false` here forces the answer regardless of autonomous vs. REPL.
  replayReasoning: replayReasoningRaw === undefined ? undefined : replayReasoningRaw !== 'false',
  // Kronk admits a model on its first inference request, not at server start.
  // Pay that cold load at boot rather than on the first typed prompt.
  warm: (process.env.KRONK_WARM ?? String(file.warm ?? 'true')) !== 'false',
  autoCompact: (process.env.KRONK_AUTO_COMPACT ?? String(file.autoCompact ?? 'true')) !== 'false',
  compactAt: Number(process.env.KRONK_COMPACT_AT ?? file.compactAt ?? 0.85),
  // Large tool output is summarized in a throwaway context so the raw text
  // never enters the conversation. Set KRONK_DISTILL=false to keep it whole.
  distill: (process.env.KRONK_DISTILL ?? String(file.distill ?? 'true')) !== 'false',
  distillAt: Number(process.env.KRONK_DISTILL_AT ?? file.distillAt ?? 8000),
  // Delegation. A sub-agent runs one task in a context of its own and hands
  // back only its report, so what it read never enters this conversation —
  // src/subagent.js has the argument. The step cap is finite where the main
  // one is not: nobody is watching a sub-agent, and its report is worth less
  // than the window it would spend earning it.
  subagents: (process.env.KRONK_SUBAGENTS ?? String(file.subagents ?? 'true')) !== 'false',
  subagentModel: process.env.KRONK_SUBAGENT_MODEL ?? file.subagentModel ?? null,
  subagentSteps: Number(process.env.KRONK_SUBAGENT_STEPS ?? file.subagentSteps ?? 40),
  // Kronk's per-model runtime settings. `setup` is the only thing that writes
  // it; the override exists so tests never go near the real one.
  modelConfigPath: process.env.KRONK_MODEL_CONFIG ?? file.modelConfigPath ?? MODEL_CONFIG,
  // Paths a previous session granted read-only to the sandbox, via `always` at
  // the credential prompt. Read-only is the whole point: KRONK_SANDBOX_ALLOW
  // grants writes as well, and these are credential stores.
  sandboxReadable: (Array.isArray(file.sandboxReadable) ? file.sandboxReadable : [])
    .filter((p) => typeof p === 'string' && p.trim())
    .map((p) => (p.startsWith('~/') ? join(homedir(), p.slice(2)) : p)),
  lastUsed: 0,
  // The startup scan of the working directory, kept so a sub-agent starts
  // knowing what the project is instead of spending its first two steps on it.
  projectPrimer: null,
  contextWindow: null,   // filled in at boot from the chosen model's profile
  nativeContext: null,
  // The sub-agent model's own limits, when one is configured. A sub-agent on
  // a 32k model must not compact against the main model's 131k window.
  subagentLimits: null,
  templatePreservesThinking: false,   // filled in at boot from the model's template
  samplingOverride: null,   // filled in at boot: params where the profile overrides the model's own
  rcPath: RC,
};

/**
 * Point the session's limits at one model's profile.
 *
 * Every one of these was resolved once at boot and then treated as a property
 * of the program rather than of the model, so `/model` could move the session
 * to a 32k model while compaction still aimed at 131k and `preserve_thinking`
 * was still sent to a template that does not declare it. They are properties
 * of whichever model is selected now.
 */
export function applyLimits({
  configured, native, preserveThinking, samplingDiff, maxTokens,
} = {}) {
  config.contextWindow = configured ?? null;
  config.nativeContext = native ?? null;
  config.templatePreservesThinking = Boolean(preserveThinking);
  config.samplingOverride = samplingDiff ?? null;
  if (!config.maxTokensExplicit) config.maxTokens = maxTokens ?? DEFAULT_MAX_TOKENS;
  return config;
}

/**
 * Whether this request should pin the earlier think blocks: the user wants it,
 * the model's template declares the parameter, and reasoning is on at all —
 * with `--no-think` there is nothing to preserve. Read per request, because
 * `/think` flips `noThink` in the middle of a session.
 */
export const shouldPreserveThinking = () =>
  config.preserveThinking && config.templatePreservesThinking && !config.noThink;

/**
 * File contents and command output leave this process in request bodies, which
 * is the whole job. Over loopback that is fine. Pointed at a remote host over
 * plain HTTP it is not, so say so once rather than letting it pass silently.
 */
export function warnIfInsecure(warn = console.error) {
  let url;
  try { url = new URL(config.baseUrl); } catch { return false; }

  const local = ['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(url.hostname)
    || url.hostname.endsWith('.local')
    || url.hostname === 'host.docker.internal';

  if (url.protocol === 'https:' || local) return false;

  warn(`  warning: ${config.baseUrl} is remote and unencrypted.`);
  warn('  File contents and command output will cross the network in clear text.');
  warn('  Use https, or an SSH tunnel to keep the endpoint on localhost.');
  return true;
}

export const headers = () => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${config.token}`,
});
