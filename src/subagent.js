import { def, TOOLS } from './tools.js';
import { config } from './config.js';
import { c } from './ui.js';

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
 * The instruction the delegating model actually reads.
 *
 * Same reasoning as set_plan's description in src/tools.js: a description is
 * the one place a small model reliably looks, so the whole protocol lives
 * here — what it is for, that the sub-agent starts blank, and that a vague
 * prompt is the failure mode.
 */
export const TASK_TOOL = def('task',
  'Delegate one self-contained piece of work to a sub-agent that runs in its own context. '
  + 'Use it when getting the answer means reading or running a lot but the answer itself is '
  + 'small — surveys, searches across many files, reproducing a failure. What the sub-agent '
  + 'reads never enters this conversation; only its report does. The sub-agent cannot see this '
  + 'conversation and cannot ask you anything, so the prompt must carry everything it needs and '
  + 'must say exactly what to report back. It cannot delegate further. Prefer one well-scoped '
  + 'task over several vague ones.',
  {
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
  },
  ['agent', 'prompt']);

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
 * Run one delegated task to completion and hand back only its report.
 *
 * `run` is `runTurn` from src/agent.js, passed in rather than imported: the
 * dispatch for this tool lives in that loop, so importing it back would be a
 * cycle for nothing. `approve` and `grant` are the caller's own, unchanged —
 * delegation is not a way to get a command past the user.
 */
export async function runTask(args, {
  run, model, signal, approve, grant, out = console.log, maxSteps = config.subagentSteps,
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

  const done = await run({
    messages,
    // A smaller model for the grunt work is the whole reason this is a knob:
    // the survey is reading and grepping, the synthesis is not.
    model: config.subagentModel ?? model,
    signal,
    approve,
    grant,
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
    out: (line) => out(nest(line)),
    maxSteps,
    depth: 1,
  });

  const report = reportFrom(done);
  reportLines(report).forEach((l) => out(l));
  return report;
}
