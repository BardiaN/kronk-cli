import { streamChat } from './client.js';
import {
  TOOLS, NEEDS_APPROVAL, runTool, describe, preview, mcpNeedsApproval,
  grantsNeeded, rememberGrants, declineGrants, credentialMatches,
} from './tools.js';
import { config, shouldPreserveThinking } from './config.js';
import { forRequest } from './reasoning.js';
import { c, fmtUsage, spinner, liveLine, toolResultLines } from './ui.js';
import { compact, isOverflow, report } from './compact.js';
import { maybeDistill } from './distill.js';
import {
  carryChecklist, clearPlan, openItems, outstandingLines, planLines, pushNudge,
} from './plan.js';
import { runTask, taskTools, TASK_TOOL } from './subagent.js';

export const SYSTEM = `You are kronk-cli, a terse coding assistant running fully offline on the user's machine.

Rules:
- Inspect before you answer. Use read_file / list_dir / search rather than guessing at code.
- Prefer one decisive action over narrating options.
- Keep prose short. Code blocks should be complete and runnable.
- The working directory is the user's project root. Paths are relative to it. You are already inside it. Do not \`cd\` above it. If a command reports that this is not a git repository, you have left the project — return to it rather than searching elsewhere.`;

export const SYSTEM_AUTO = `${SYSTEM}

You are running autonomously on a whole task. Finish it before you stop.
- Before your first edit, call set_plan with one item per acceptance criterion, requirement or checkbox in the request. Copy the wording of the request; do not paraphrase it into something easier.
- If the request calls a step required, mandatory, or a first step, it is an item, and it is done before the work it gates.
- Update the plan with set_plan after each item. Record progress with the tool, not in prose.
- Do not ask the user questions. Make a reasonable choice and proceed.
- After you write code, RUN it with bash and fix whatever breaks.
- Never claim something works unless you have executed it and seen the output.
- Work in small steps: one file or one command per tool call.
- Do not reply with a summary while any item is not done. If an item cannot be completed, say in your reply why it was not possible, and only then mark it done — never silently.
- Before the final reply, re-read the original request and check every item against it.
- When every item is genuinely done, reply with a short summary of what you changed.`;

/**
 * The reasoning half of an assistant message, or nothing at all.
 *
 * A model that emitted no reasoning — `--no-think`, or a non-reasoning model —
 * must produce exactly the message this agent has always produced, so the key
 * is absent rather than empty.
 */
const thought = (reasoning) => (reasoning ? { reasoning_content: reasoning } : {});

/**
 * Compact in place, preserving the caller's array identity.
 *
 * `auto` is passed through so the summarizer sees the same reasoning-replay
 * view as the wire request that just overflowed — see `compact` in
 * src/compact.js.
 */
async function compactInto(messages, model, signal, auto, out = console.log) {
  const res = await compact(messages, { model, signal, auto });
  if (res.failed || res.skipped) { out(report(res)); return false; }
  messages.splice(0, messages.length, ...res.messages);
  out(report(res));
  return true;
}

/** How many times a premature "done" is handed back before the turn ends anyway. */
const MAX_NUDGES = 2;

/**
 * Say what was not finished, and hand the transcript back fit to be continued.
 *
 * Nothing is taken out of it on the way. A turn always ends on an assistant
 * message — the reply, or the step-cap note — so a nudge is never left sitting
 * directly before the next typed prompt.
 */
function endTurn(messages, { out = console.log, plan = true } = {}) {
  if (plan) outstandingLines().forEach((l) => out(l));
  return messages;
}

/**
 * Run one user turn to completion, looping while the model requests tools.
 *
 * `grant(binary, paths)` resolves to 'yes' | 'no' | 'always'; asked before a
 * command that needs a credential store the sandbox denies.
 * `approve(name, args)` returns a boolean; used for mutating tools. `auto` is
 * autonomous mode — the system prompt in force, not `--yes` — and decides
 * both whether a premature "done" is handed back or accepted, and (via
 * src/reasoning.js) whether the current task's reasoning defaults to being
 * replayed on the wire.
 */
export async function runTurn({
  messages, model, signal, approve, grant, mcp, auto = false, maxSteps = config.maxSteps,
  tools: toolset = TOOLS, plan: usePlan = true, out = console.log, stream = true, depth = 0,
}) {
  // `taskTools` is empty below the top level, which is the whole recursion
  // guard: a sub-agent is never handed the tool that spawns one.
  const tools = [...toolset, ...taskTools(depth), ...(mcp ? mcp.toolDefs() : [])];
  let totalUsage = null;
  let step = 0;
  let compacted = false;
  let nudges = 0;

  // A plan belongs to one task, not to a session. Only the store is cleared:
  // a checklist the previous turn left in the transcript is history, it is
  // already in the prompt prefix, and rewriting history is what evicts the
  // prompt cache — see `carryChecklist`.
  if (usePlan) clearPlan();

  for (;;) {
    step += 1;
    if (Number.isFinite(maxSteps) && step > maxSteps) {
      out(c.yellow(`  ⛔ step cap reached (${maxSteps}). Stopping.`));
      out(c.grey(depth
        ? '     raise it with KRONK_SUBAGENT_STEPS'
        : '     raise it with --steps N, or /steps N in the REPL'));
      messages.push({ role: 'assistant',
        content: depth
          ? `(stopped: the sub-agent reached its step cap of ${maxSteps} before finishing)`
          : '(stopped: step cap reached)' });
      return endTurn(messages, { out, plan: usePlan });
    }
    let sp = spinner(depth ? 'sub-agent' : 'thinking');
    let text = '';
    let reasoning = '';
    let calls = [];
    let wroteAnything = false;
    let inReasoning = false;

    try {
      for await (const ev of streamChat({
        model,
        // The history keeps every step's reasoning; only the current task's
        // share of it goes on the wire. See src/reasoning.js.
        messages: forRequest(messages, auto),
        tools,
        signal,
        maxTokens: config.maxTokens,
        noThink: config.noThink,
        // Re-read every step: this has to hold for the tool-loop follow-ups too,
        // and `/think` can flip the answer between one turn and the next.
        preserveThinking: shouldPreserveThinking(),
      })) {
        if (ev.type === 'reasoning') {
          // Accumulated before the display check: whether the user watches the
          // model think has nothing to do with whether the model gets it back.
          reasoning += ev.value;
          // A sub-agent's reasoning is not the answer, and a second stream
          // interleaved with the caller's is unreadable. See runTask.
          if (!stream || !config.showThinking) continue;
          if (sp) { sp.stop(); sp = null; }
          if (!inReasoning) { process.stdout.write(c.grey('\n  ┄ thinking ┄\n  ')); inReasoning = true; }
          process.stdout.write(c.grey(ev.value.replace(/\n/g, '\n  ')));
          wroteAnything = true;
        }

        else if (ev.type === 'text') {
          text += ev.value;
          if (!stream) continue;
          if (sp) { sp.stop(); sp = null; }
          if (inReasoning) { process.stdout.write(c.grey('\n  ┄─────────┄\n\n')); inReasoning = false; }
          process.stdout.write(ev.value);
          wroteAnything = true;
        }

        else if (ev.type === 'usage') {
          totalUsage = ev.value;
        }

        else if (ev.type === 'done') {
          calls = ev.calls;
        }
      }
    } catch (e) {
      if (sp) { sp.stop(); sp = null; }
      if (isOverflow(e) && !compacted) {
        compacted = true;
        out(c.yellow('\n  context full — compacting and retrying'));
        // The plan itself is module state, so compaction cannot reach it. The
        // snapshot it just summarised away is not put back: there is no tool
        // result left to carry one, and inserting a message here would be the
        // rewrite `carryChecklist` exists to avoid. The next round's tool
        // results carry the plan again.
        if (await compactInto(messages, model, signal, auto, out)) {
          step -= 1;
          continue;
        }
      }
      throw e;
    } finally {
      if (sp) sp.stop();
    }

    if (inReasoning) process.stdout.write(c.grey('\n  ┄─────────┄\n'));
    if (wroteAnything) process.stdout.write('\n');
    if (totalUsage) {
      out(fmtUsage(totalUsage, config.contextWindow));
      // The status line reports the conversation the user is typing into. A
      // sub-agent's window is its own and is thrown away with it.
      if (!depth) {
        config.lastUsed = (totalUsage.prompt_tokens ?? 0) + (totalUsage.completion_tokens ?? 0);
      }
    }

    if (config.autoCompact && config.contextWindow && totalUsage) {
      const used = (totalUsage.prompt_tokens ?? 0) + (totalUsage.completion_tokens ?? 0);
      if (used / config.contextWindow >= config.compactAt) {
        out(c.yellow(`  context ${Math.round((used / config.contextWindow) * 100)}% full — compacting`));
        if (!await compactInto(messages, model, signal, auto, out)) config.autoCompact = false;
      }
    }

    // No tools requested → the turn is finished.
    if (calls.length === 0) {
      if (!text.trim()) {
        // Reasoning models sometimes spend the whole budget thinking and emit no
        // answer. Say so rather than returning silence.
        out(c.yellow('  (model produced no answer — raise KRONK_MAX_TOKENS or /thinking off)'));
        messages.push({ role: 'assistant', content: '(no answer produced)', ...thought(reasoning) });
      } else {
        messages.push({ role: 'assistant', content: text, ...thought(reasoning) });
      }

      // A plan with open items means it stopped early. Hand the list back and
      // keep going — but only when nobody is watching, and only twice: past
      // that the model is not going to finish, and looping is worse than
      // reporting what is left.
      if (usePlan && auto && openItems().length && nudges < MAX_NUDGES) {
        nudges += 1;
        pushNudge(messages);
        out(c.yellow(`  ⚠ ${openItems().length} checklist items still open — continuing`));
        continue;
      }
      return endTurn(messages, { out, plan: usePlan });
    }

    messages.push({
      role: 'assistant',
      content: text,
      ...thought(reasoning),
      tool_calls: calls.map((t) => ({
        id: t.id, type: 'function',
        function: { name: t.name, arguments: t.args || '{}' },
      })),
    });

    for (const call of calls) {
      if (signal?.aborted) {
        messages.push({ role: 'tool', tool_call_id: call.id, content: 'error: interrupted by user' });
        continue;
      }
      let args;
      try { args = JSON.parse(call.args || '{}'); }
      catch {
        messages.push({ role: 'tool', tool_call_id: call.id,
          content: `error: arguments were not valid JSON: ${call.args}` });
        continue;
      }

      const at = Number.isFinite(maxSteps) ? `${step}/${maxSteps}` : `${step}`;
      const isMcp = Boolean(mcp?.has(call.name));
      // The same list the model was offered, not just the name it used: with
      // delegation off, or below the top level, a `task` call is a call to a
      // tool that does not exist and falls through to runTool saying so.
      const isTask = !isMcp && call.name === 'task' && tools.includes(TASK_TOOL);
      const label = isMcp
        ? `${c.magenta('⚙')} ${call.name} ${c.grey(JSON.stringify(args).slice(0, 120))}`
        : `${c.blue(`⚙ ${describe(call.name, args)}`)}`;
      out(`${c.grey(`  ${at}`)} ${label}`);

      if (isMcp ? mcpNeedsApproval(call.name) : NEEDS_APPROVAL.has(call.name)) {
        const body = preview(call.name, args);
        if (body) out(body.split('\n').map((l) => `    ${l}`).join('\n'));
        const ok = await approve(call.name, args);
        if (!ok) {
          out(c.red('  ✗ denied'));
          messages.push({ role: 'tool', tool_call_id: call.id,
            content: 'error: the user denied this action. Ask what to do instead.' });
          continue;
        }
      }

      // Ask here, not in the tool layer, and not after this point.
      //
      // `liveLine()` below starts a 120 ms interval that rewrites the current
      // line with `\r…\x1b[K` unconditionally, so a question printed once it is
      // running gets overwritten between the asking and the answering. This is
      // the last moment at which stdout belongs to us, and it is next door to
      // the approval prompt the user already expects, which is where a second
      // question belongs anyway.
      if (call.name === 'bash' && grant) {
        const needed = grantsNeeded(args.cmd);
        if (needed.length) {
          // Name the tool the user recognises, from the same scan that found
          // the paths — so the question cannot name one binary while granting
          // for another.
          const binary = credentialMatches(args.cmd)
            .find((m) => m.paths.some((p) => needed.includes(p)))?.bin ?? 'this command';
          const answer = await grant(binary, needed);
          if (answer === 'yes' || answer === 'always') {
            try {
              const wrote = rememberGrants(needed, { persist: answer === 'always' });
              if (wrote) out(c.grey(`  remembered in ${wrote}`));
            } catch (e) {
              // Failing to persist must not fail the command. The grant is
              // already in force for this session either way.
              out(c.yellow(`  ${e.message}`));
            }
          } else {
            declineGrants(needed);
          }
        }
      }

      let result;
      if (isTask) {
        // No `liveLine` around this one. It rewrites the current line every
        // 120 ms, which would erase the sub-agent's own output as fast as it
        // is printed.
        try {
          result = await runTask(args, { run: runTurn, model, signal, approve, grant, out });
        } catch (e) {
          // Errors are data here exactly as they are in `runTool`: a
          // sub-agent that died does not take the turn that delegated to it
          // down with it.
          result = `error: the sub-agent failed — ${e.message}`;
        }
      } else {
        const live = liveLine();
        try {
          result = isMcp
            ? await mcp.call(call.name, args)
            : await runTool(call.name, args, {
                onProgress: (info) => live.update({ ...info, window: config.contextWindow }),
              });
        } finally {
          live.done();
        }
      }

      // set_plan hands back a rendering of what the harness just stored; paying a
      // second model call to paraphrase our own text would be pure waste.
      // A sub-agent's report is already the distillation of everything it
      // read; paying a second model call to summarise a summary is waste.
      if (call.name !== 'set_plan' && !isTask) {
        result = await maybeDistill(result, {
          model, signal, out, command: args.cmd ?? describe(call.name, args),
        });
      }
      const failed = result.startsWith('error:');
      if (failed) toolResultLines(result).forEach((l) => out(l));
      else if (call.name === 'set_plan') planLines().forEach((l) => out(l));
      else out(c.grey(`  ✓ ${result.split('\n').length} lines`));
      messages.push({ role: 'tool', tool_call_id: call.id, content: result });
    }

    // On the last tool result rather than in a message of its own, so the
    // round only ever adds to the prompt. Nothing already sent is touched.
    if (usePlan) carryChecklist(messages);
    // loop: the model now sees the tool output
  }
}
