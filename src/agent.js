import { streamChat } from './client.js';
import { TOOLS, NEEDS_APPROVAL, runTool, describe, preview, mcpNeedsApproval } from './tools.js';
import { config, shouldPreserveThinking } from './config.js';
import { c, fmtUsage, spinner, liveLine, toolResultLines } from './ui.js';
import { compact, isOverflow, report } from './compact.js';
import { maybeDistill } from './distill.js';
import {
  carryChecklist, clearPlan, openItems, outstandingLines, planLines, pushNudge,
} from './plan.js';

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

/** Compact in place, preserving the caller's array identity. */
async function compactInto(messages, model, signal) {
  const res = await compact(messages, { model, signal });
  if (res.failed || res.skipped) { console.log(report(res)); return false; }
  messages.splice(0, messages.length, ...res.messages);
  console.log(report(res));
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
function endTurn(messages) {
  outstandingLines().forEach((l) => console.log(l));
  return messages;
}

/**
 * Run one user turn to completion, looping while the model requests tools.
 *
 * `approve(name, args)` returns a boolean; used for mutating tools. `auto` is
 * autonomous mode — the system prompt in force, not `--yes` — and is what
 * decides whether a premature "done" is handed back or accepted.
 */
export async function runTurn({
  messages, model, signal, approve, mcp, auto = false, maxSteps = config.maxSteps,
}) {
  const tools = mcp ? [...TOOLS, ...mcp.toolDefs()] : TOOLS;
  let totalUsage = null;
  let step = 0;
  let compacted = false;
  let nudges = 0;

  // A plan belongs to one task, not to a session. Only the store is cleared:
  // a checklist the previous turn left in the transcript is history, it is
  // already in the prompt prefix, and rewriting history is what evicts the
  // prompt cache — see `carryChecklist`.
  clearPlan();

  for (;;) {
    step += 1;
    if (Number.isFinite(maxSteps) && step > maxSteps) {
      console.log(c.yellow(`  ⛔ step cap reached (${maxSteps}). Stopping.`));
      console.log(c.grey('     raise it with --steps N, or /steps N in the REPL'));
      messages.push({ role: 'assistant', content: '(stopped: step cap reached)' });
      return endTurn(messages);
    }
    let sp = spinner('thinking');
    let text = '';
    let calls = [];
    let wroteAnything = false;
    let inReasoning = false;

    try {
      for await (const ev of streamChat({
        model, messages, tools, signal, maxTokens: config.maxTokens, noThink: config.noThink,
        // Re-read every step: this has to hold for the tool-loop follow-ups too,
        // and `/think` can flip the answer between one turn and the next.
        preserveThinking: shouldPreserveThinking(),
      })) {
        if (ev.type === 'reasoning') {
          if (!config.showThinking) continue;
          if (sp) { sp.stop(); sp = null; }
          if (!inReasoning) { process.stdout.write(c.grey('\n  ┄ thinking ┄\n  ')); inReasoning = true; }
          process.stdout.write(c.grey(ev.value.replace(/\n/g, '\n  ')));
          wroteAnything = true;
        }

        else if (ev.type === 'text') {
          if (sp) { sp.stop(); sp = null; }
          if (inReasoning) { process.stdout.write(c.grey('\n  ┄─────────┄\n\n')); inReasoning = false; }
          text += ev.value;
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
        console.log(c.yellow('\n  context full — compacting and retrying'));
        // The plan itself is module state, so compaction cannot reach it. The
        // snapshot it just summarised away is not put back: there is no tool
        // result left to carry one, and inserting a message here would be the
        // rewrite `carryChecklist` exists to avoid. The next round's tool
        // results carry the plan again.
        if (await compactInto(messages, model, signal)) {
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
      console.log(fmtUsage(totalUsage, config.contextWindow));
      config.lastUsed = (totalUsage.prompt_tokens ?? 0) + (totalUsage.completion_tokens ?? 0);
    }

    if (config.autoCompact && config.contextWindow && totalUsage) {
      const used = (totalUsage.prompt_tokens ?? 0) + (totalUsage.completion_tokens ?? 0);
      if (used / config.contextWindow >= config.compactAt) {
        console.log(c.yellow(`  context ${Math.round((used / config.contextWindow) * 100)}% full — compacting`));
        if (!await compactInto(messages, model, signal)) config.autoCompact = false;
      }
    }

    // No tools requested → the turn is finished.
    if (calls.length === 0) {
      if (!text.trim()) {
        // Reasoning models sometimes spend the whole budget thinking and emit no
        // answer. Say so rather than returning silence.
        console.log(c.yellow('  (model produced no answer — raise KRONK_MAX_TOKENS or /thinking off)'));
        messages.push({ role: 'assistant', content: '(no answer produced)' });
      } else {
        messages.push({ role: 'assistant', content: text });
      }

      // A plan with open items means it stopped early. Hand the list back and
      // keep going — but only when nobody is watching, and only twice: past
      // that the model is not going to finish, and looping is worse than
      // reporting what is left.
      if (auto && openItems().length && nudges < MAX_NUDGES) {
        nudges += 1;
        pushNudge(messages);
        console.log(c.yellow(`  ⚠ ${openItems().length} checklist items still open — continuing`));
        continue;
      }
      return endTurn(messages);
    }

    messages.push({
      role: 'assistant',
      content: text,
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
      const label = isMcp
        ? `${c.magenta('⚙')} ${call.name} ${c.grey(JSON.stringify(args).slice(0, 120))}`
        : `${c.blue(`⚙ ${describe(call.name, args)}`)}`;
      console.log(`${c.grey(`  ${at}`)} ${label}`);

      if (isMcp ? mcpNeedsApproval(call.name) : NEEDS_APPROVAL.has(call.name)) {
        const body = preview(call.name, args);
        if (body) console.log(body.split('\n').map((l) => `    ${l}`).join('\n'));
        const ok = await approve(call.name, args);
        if (!ok) {
          console.log(c.red('  ✗ denied'));
          messages.push({ role: 'tool', tool_call_id: call.id,
            content: 'error: the user denied this action. Ask what to do instead.' });
          continue;
        }
      }

      const live = liveLine();
      let result;
      try {
        result = isMcp
          ? await mcp.call(call.name, args)
          : await runTool(call.name, args, {
              onProgress: (info) => live.update({ ...info, window: config.contextWindow }),
            });
      } finally {
        live.done();
      }

      // set_plan hands back a rendering of what the harness just stored; paying a
      // second model call to paraphrase our own text would be pure waste.
      if (call.name !== 'set_plan') {
        result = await maybeDistill(result, {
          model, signal, command: args.cmd ?? describe(call.name, args),
        });
      }
      const failed = result.startsWith('error:');
      if (failed) toolResultLines(result).forEach((l) => console.log(l));
      else if (call.name === 'set_plan') planLines().forEach((l) => console.log(l));
      else console.log(c.grey(`  ✓ ${result.split('\n').length} lines`));
      messages.push({ role: 'tool', tool_call_id: call.id, content: result });
    }

    // On the last tool result rather than in a message of its own, so the
    // round only ever adds to the prompt. Nothing already sent is touched.
    carryChecklist(messages);
    // loop: the model now sees the tool output
  }
}
