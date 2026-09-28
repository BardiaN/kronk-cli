import { def, TOOLS } from './tools.js';
import { config } from './config.js';
import { c, elapsed } from './ui.js';
import { startRun } from './tasklog.js';
import { livePane } from './pane.js';
import { modelLimits as fetchModelLimits } from './client.js';
import { resolveModel } from './resolve.js';

/**
 * Sub-agents: one delegated task, one throwaway context.
 *
 * The point is the same one src/distill.js makes about command output, moved
 * up a level. A survey that reads thirty files to answer one question costs
 * the main conversation thirty files' worth of window, permanently, and it is
 * still paying for them ten turns later. Handing that survey to a sub-agent
 * costs the conversation exactly one tool result: the report. Everything the
 * sub-agent read is discarded with its context.
 *
 * So this is not parallelism — a local Kronk server has one resident copy of
 * the model and calls queue behind each other, so two sub-agents at once is
 * slower than two in sequence, not faster. It is context economy. Delegate
 * what is expensive to read and cheap to conclude.
 */

/** Look, never touch. Every sub-agent gets at least these. */
const READ_ONLY = ['read_file', 'list_dir', 'search'];

/**
 * Rules every sub-agent is held to, whatever it is allowed to touch.
 *
 * The first two carry the whole contract. A sub-agent that reports "I found
 * the bug" without saying where is a sub-agent whose entire context was spent
 * for nothing — the caller cannot go and look, because the files it read are
 * gone.
 */
const CONTRACT = `You are a sub-agent of kronk-cli, running fully offline on the user's machine.

You have been given one self-contained task and a context of your own.

- Nobody sees your work. The agent that delegated this cannot see the files you read, the commands you ran, or your reasoning — your final reply is the only thing it ever receives.
- So the reply has to stand alone: the answer, the exact paths and line numbers behind it, whatever failed, and whatever you had to assume. Quote the few lines that matter verbatim; never paste whole files, because not having to hold them is the reason you were given this task.
- Do not ask questions. There is nobody to answer one. Take the most reasonable reading of the task, act on it, and say what you assumed.
- Do not stop half way and report progress. Finish the task, then report.
- Keep the reply under about 30 lines.
- The working directory is the user's project root. Paths are relative to it. You are already inside it. Do not \`cd\` above it.`;

/**
 * The roles a sub-agent can be given.
 *
 * Two, not ten. Each one is a line the delegating model has to read and choose
 * between on every call, and a local model asked to pick between eight
 * near-synonyms picks badly — the split that actually changes what can happen
 * is "can it touch anything", so that is the split.
 */
export const AGENTS = {
  explore: {
    use: 'reading, searching, tracing how something works, answering a question about the code',
    tools: READ_ONLY,
    rules: '- You can only read: read_file, list_dir and search. You cannot run commands and you cannot change anything. If the task needs a command run or a file written, say so in your reply rather than trying.',
  },
  code: {
    use: 'making a change, running a build or a test suite, reproducing a failure',
    tools: [...READ_ONLY, 'write_file', 'bash'],
    rules: '- You can also write files and run commands. The user is still asked before each one, and a refusal is an answer: report it, do not look for a way around it.\n'
      + '- After you write code, RUN it and fix what breaks. Never report that something works unless you have executed it and seen the output.',
  },
};

const agentList = () => Object.entries(AGENTS)
  .map(([name, a]) => `"${name}" — ${a.use}`).join('; ');

/**
 * The ids a task's `model` parameter may name, or null when nobody has said.
 *
 * Set once at boot, from `chatModels(await listModels())` in src/boot.js, by
 * `setServedModels` below. A test that builds `runTask` by hand, as every
 * test in test/subagent.test.js does, never calls that setter, so this stays
 * null and the tool is offered exactly as it always was: no `model` property
 * at all, because an enum with no members is not a real choice, it is a tool
 * a model would call and then have no valid value to put in it.
 */
let servedModels = null;

/**
 * The instruction the delegating model actually reads.
 *
 * Same reasoning as set_plan's description in src/tools.js: a description is
 * the one place a small model reliably looks, so the whole protocol lives
 * here — what it is for, that the sub-agent starts blank, and that a vague
 * prompt is the failure mode.
 *
 * `model` is built from `servedModels` rather than written once: the whole
 * point of the enum is that the delegating model can only ever name a real
 * id, so the property has to be rebuilt whenever the served list changes,
 * and left off entirely when there is no list to build it from.
 */
function buildTaskTool(models) {
  const properties = {
    agent: {
      type: 'string',
      enum: Object.keys(AGENTS),
      description: `Which sub-agent to run: ${agentList()}.`,
    },
    prompt: {
      type: 'string',
      description: 'The whole task, written for someone who knows nothing about this '
        + 'conversation: what to do, where to look, and exactly what to report back.',
    },
  };
  if (models?.length) {
    properties.model = {
      type: 'string',
      enum: models,
      description: 'Which model to run this task on, when the default is not the right size '
        + 'for it. A survey that reads a lot and concludes little wants a small, fast model; '
        + 'reproducing a failure or making a change wants a large one. Omit it to use the '
        + "session's own default. Naming a model that is not already loaded costs a real "
        + 'load — seconds, not instant — so only ask for a different one when the task actually '
        + 'needs it.',
    };
  }
  return def('task',
    'Delegate one self-contained piece of work to a sub-agent that runs in its own context. '
    + 'Use it when getting the answer means reading or running a lot but the answer itself is '
    + 'small — surveys, searches across many files, reproducing a failure. What the sub-agent '
    + 'reads never enters this conversation; only its report does. The sub-agent cannot see this '
    + 'conversation and cannot ask you anything, so the prompt must carry everything it needs and '
    + 'must say exactly what to report back. It cannot delegate further. Prefer one well-scoped '
    + 'task over several vague ones.',
    properties,
    ['agent', 'prompt']);
}

export let TASK_TOOL = buildTaskTool(servedModels);

/**
 * Tell src/subagent.js what Kronk is actually serving, so the task tool's
 * `model` parameter can only ever name something real.
 *
 * Called once at boot with `chatModels(ids)` from src/boot.js — never the
 * raw list from `listModels()`, so an embedding model, or a bare id sitting
 * next to its own /AGENT profile, can never appear as something a delegated
 * task is allowed to ask for. What it does keep is every chat model that has
 * no profile of its own; src/boot.js has the argument for why that matters
 * more here than it does when one default is being chosen. `null` (or an
 * empty list) puts the tool back to its no-`model` shape, which is also its
 * starting shape — nothing to degrade to, because nothing was ever added.
 */
export function setServedModels(ids) {
  servedModels = Array.isArray(ids) && ids.length ? [...ids] : null;
  TASK_TOOL = buildTaskTool(servedModels);
}

/**
 * The delegation tool, when it is allowed at all.
 *
 * Empty below the top level, and that is the recursion guard: a sub-agent is
 * never handed the tool that would let it spawn one. Nothing else enforces
 * depth, and nothing else needs to.
 */
export function taskTools(depth = 0) {
  return depth === 0 && config.subagents ? [TASK_TOOL] : [];
}

/** The built-ins this role is allowed, in the order src/tools.js defines them. */
export function subagentTools(agent) {
  const allowed = new Set(AGENTS[agent]?.tools ?? READ_ONLY);
  return TOOLS.filter((t) => allowed.has(t.function.name));
}

/**
 * The sub-agent's system prompt: the contract, its role's rules, and the same
 * project primer the main agent was given at startup.
 *
 * The primer is worth its tokens — without it every sub-agent spends its first
 * two steps working out what the project is, in a context it only gets one of.
 */
export function systemFor(agent) {
  const spec = AGENTS[agent];
  const primer = config.projectPrimer ? `\n\n---\n\n${config.projectPrimer}` : '';
  return `${CONTRACT}\n${spec.rules}${primer}`;
}

/** Nest one line of a sub-agent's output under the call that started it. */
const nest = (line) => String(line).split('\n')
  .map((l) => `${c.grey('   │')} ${l}`).join('\n');

/** How much of the prompt fits on the opening line. */
const GIST = 60;

/**
 * The tail of a model id — enough of it to actually distinguish one on screen.
 * A served id's own name is the second-to-last segment (`unsloth/Qwen3.6-…
 * /AGENT`); the last segment alone is often just `AGENT` or `base`, which
 * every profile of every model shares and which therefore says nothing.
 */
const short = (id) => String(id).split('/').slice(-2).join('/');

/**
 * The line that says a run has started.
 *
 * Without it a delegated run is an unlabelled block of nested tool calls, and
 * two of them in a row are indistinguishable in scrollback. The gist is the
 * prompt's first line, cut: enough to recognise which task this was, never
 * enough to be worth reading instead of the report.
 *
 * `model` is named here too, always, not only when it differs from the
 * session's own — residency is the real cost of letting a task pick one
 * (src/subagent.js's module comment on `setServedModels`), and "which model
 * just cost you a cold load" is a question this line should answer without
 * making anyone go read /agents first.
 */
export function openLine(agent, prompt, model) {
  const first = String(prompt).split('\n')[0].trim();
  const gist = first.length > GIST ? `${first.slice(0, GIST - 1)}…` : first;
  const tag = model ? c.grey(` · ${short(model)}`) : '';
  return `${c.grey('   ┌')} ${c.bold(agent)}${tag} ${c.grey(`· ${gist}`)}`;
}

/**
 * The line that closes one, and the only place the transcript is advertised.
 *
 * This is what makes `reportLines`' "…N more lines" actionable: the report on
 * screen is bounded, and now there is somewhere to go for the rest of it and
 * for everything the sub-agent read on the way. Once the pane erases itself it
 * carries more than that — it is all that is left of the run on screen.
 */
export function closeLine({ ms, steps, n, ok }) {
  // A run that threw or was interrupted is the one worth reading, so the line
  // that points at its transcript must not read like a clean finish.
  const bits = [`${steps} step${steps === 1 ? '' : 's'}`, elapsed(ms), ...(ok ? [] : ['stopped'])];
  // The command that reads the transcript, not the file it reads. The absolute
  // path under the temp dir is long, mostly noise, and not a thing anyone would
  // type; `/tasks 3` is both shorter and the answer to "how do I see it".
  if (n) bits.push(`/tasks ${n} for the transcript`);
  const line = `   └ ${bits.join(' · ')}`;
  return ok ? c.grey(line) : c.yellow(line);
}

const MAX_REPORT_LINES = 14;

/** The report on screen, dimmed and bounded — the caller received all of it. */
function reportLines(text) {
  const lines = text.split('\n');
  const shown = lines.slice(0, MAX_REPORT_LINES).map((l) => c.grey(`   ${l}`));
  const hidden = lines.length - shown.length;
  if (hidden > 0) {
    shown.push(c.grey(`   …${hidden} more line${hidden === 1 ? '' : 's'} (the agent received all of it)`));
  }
  return shown;
}

/**
 * The sub-agent's last word, which is the entire value of the call.
 *
 * A turn always ends on an assistant message — see `endTurn` in src/agent.js —
 * so the tail is the report. An empty one is reported as the error it is
 * rather than handed back as a blank tool result the caller would have to
 * interpret.
 */
function reportFrom(messages) {
  const last = [...messages].reverse().find((m) => m.role === 'assistant');
  const text = String(last?.content ?? '').trim();
  if (!text) return 'error: the sub-agent finished without reporting anything. Do the work here, or delegate again with a more specific prompt.';
  return text;
}

/**
 * One model's window and output cap, looked up once per distinct id and kept
 * for the rest of the session.
 *
 * Used to be a single field, `config.subagentLimits`, resolved once at boot
 * for the one id `KRONK_SUBAGENT_MODEL` named. Now that a task can name a
 * different model on every delegation, "once at boot for one id" is not
 * enough — but "once per delegation" is worse: a survey and a build fix
 * delegated back to back on the same small model would ask Kronk for the
 * same profile twice for no reason. A `Map` keyed by id is the middle
 * ground — paid once per model actually used, not once per model that exists
 * and not once per task that runs.
 */
const limitsCache = new Map();

/** Test-only: the cache is a session-lifetime optimisation, not a session. */
export function resetLimitsCache() { limitsCache.clear(); }

async function limitsFor(id, fetchLimits) {
  if (!limitsCache.has(id)) limitsCache.set(id, await fetchLimits(id));
  return limitsCache.get(id);
}

/**
 * Run one delegated task to completion and hand back only its report.
 *
 * `run` is `runTurn` from src/agent.js, passed in rather than imported: the
 * dispatch for this tool lives in that loop, so importing it back would be a
 * cycle for nothing. `approve` and `grant` are the caller's own, unchanged —
 * delegation is not a way to get a command past the user.
 */
export async function runTask(args, {
  run, model, signal, approve, grant, out = console.log, maxSteps = config.subagentSteps,
  // Injected the same way `run` and `out` are, and for the same reason: the
  // pane's behaviour is a screen behaviour, and a test has no screen.
  pane: makePane = livePane,
  // Real Kronk by default; a test hands in a stub so resolving a named
  // model's limits never touches a network nobody promised would be there.
  modelLimits: fetchLimits = fetchModelLimits,
}) {
  const agent = args?.agent ?? 'explore';
  const prompt = String(args?.prompt ?? '').trim();
  if (!AGENTS[agent]) {
    return `error: unknown agent "${agent}" — use one of: ${Object.keys(AGENTS).join(', ')}`;
  }
  if (!prompt) return 'error: task needs a prompt saying what to do and what to report back';

  const messages = [
    { role: 'system', content: systemFor(agent) },
    { role: 'user', content: prompt },
  ];

  // The model this task actually runs on: what it asked for, else the
  // session's configured default for delegation, else the session's own.
  let taskModel = config.subagentModel ?? model;
  const wanted = args?.model ? String(args.model).trim() : '';
  // A note for the tool result, not a return in itself — a task that asked
  // for a model that turns out not to be served still runs, on the fallback
  // above, because there is nothing the delegating model can do to fix an id
  // that came straight out of the enum it was offered. Failing the whole
  // delegation over it would only cost a retry with the same bad value; a
  // note it can read and carry forward is strictly more useful.
  let modelNote = null;
  if (wanted) {
    if (servedModels) {
      const resolved = resolveModel(wanted, servedModels);
      if (resolved) taskModel = resolved;
      else modelNote = `note: "${wanted}" is not being served right now — ran on ${short(taskModel)} instead.`;
    } else {
      // Nothing to check the name against — a unit test that built `runTask`
      // by hand, or a session where `setServedModels` was never called. The
      // id is trusted exactly as `model` and `config.subagentModel` already
      // are in that situation: a plain string, handed to `run` unvalidated.
      taskModel = wanted;
    }
  }

  // A sub-agent on another model gets that model's window and output cap, not
  // the session's. Compacting a 32k sub-agent at 85% of the main model's 131k
  // means never compacting it at all. The session's own model needs no
  // lookup — config.contextWindow and config.maxTokens already are its
  // limits, kept current by applyLimits whenever the session switches models.
  const limits = taskModel === model ? null : await limitsFor(taskModel, fetchLimits);

  // Recorded from here, not from the first step: a run that dies in its first
  // model call still leaves a file saying which task was asked for.
  const log = startRun({ agent, prompt, model: taskModel });
  const started = Date.now();

  // On a terminal the run is drawn in a box that erases itself; on a pipe, a
  // dumb terminal or an `--auto` run nobody is watching, `livePane` hands back
  // an inert one and everything below takes exactly the path it took before
  // the pane existed. The transcript is written either way, which is what
  // makes erasing the box safe — see src/pane.js.
  const pane = makePane({ agent, model: taskModel, maxSteps, signal });
  if (pane.enabled) pane.open();
  else out(openLine(agent, prompt, taskModel));
  if (modelNote) out(c.yellow(`   ${modelNote}`));

  let steps = 0;
  let report;
  try {
    const done = await run({
      messages,
      // A smaller model for the grunt work is the whole reason this is a knob:
      // the survey is reading and grepping, the synthesis is not.
      model: taskModel,
      window: limits ? limits.configured : config.contextWindow,
      maxTokens: limits?.maxTokens ?? config.maxTokens,
      signal,
      // Wrapped, not replaced: delegation is still not a way to get a command
      // past the user. The wrapper only wipes the box first, so the question is
      // asked on a clear screen and nothing redraws over it while it waits.
      approve: pane.shield(approve),
      grant: pane.shield(grant),
      // No MCP: a local model already struggles past ~25 tools, and the
      // sub-agent's list is meant to be the short one.
      mcp: null,
      tools: subagentTools(agent),
      // The checklist is module state belonging to the task the user asked for.
      // A sub-agent that called set_plan would clear it out from under the agent
      // that delegated to it.
      plan: false,
      // Its reasoning and prose are not printed: they are not the answer, and a
      // second stream interleaved with the caller's is unreadable. Tool calls
      // still show, indented, so the run is not a black box.
      stream: false,
      out: pane.enabled ? (line) => pane.line(line) : (line) => out(nest(line)),
      // The pane is already the live view, and the spinner and the per-command
      // live line both rewrite the current line with `\r` — which is the last
      // row of the box. Two things redrawing the same row is the one way this
      // can look broken, so below a pane there is only one of them.
      quiet: pane.enabled,
      maxSteps,
      depth: 1,
      // Written as it goes rather than at the end. The runs worth reading are
      // the ones that were interrupted, threw, or ran out of steps, and none
      // of those reach the line below.
      onStep: (msgs, n) => { steps = n; pane.step(n); log?.step(msgs, n); },
    });

    report = reportFrom(done);
    // The delegating model reads the tool result, not the scrollback, so the
    // note about a model it asked for and did not get belongs in both —
    // printed above when the run started, and carried in what it gets back.
    if (modelNote) report = `${modelNote}\n\n${report}`;
    // Before the report, so the box is gone by the time the answer lands in
    // the scrollback it is keeping clean.
    pane.close();
    reportLines(report).forEach((l) => out(l));
    return report;
  } finally {
    // In `finally` so an abort or a throw still closes the record and still
    // tells the user where the partial transcript is — that is the case the
    // transcript exists for. `close` is idempotent; the success path already
    // called it above.
    pane.close();
    log?.finish({ report, steps });
    out(closeLine({ ms: Date.now() - started, steps, n: log?.n, ok: report !== undefined }));
  }
}
