import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { config } from '../src/config.js';
import {
  AGENTS, TASK_TOOL, taskTools, subagentTools, systemFor, runTask,
} from '../src/subagent.js';
import { listRuns, readRun } from '../src/tasklog.js';

// Delegating writes a transcript now. Somewhere of our own, never the real one.
config.taskLogDir = mkdtempSync(join(tmpdir(), 'kronk-subagent-'));

const quiet = () => {};

/** A stand-in for runTurn: records how it was called, replies what it is told. */
function stubRun(reply = 'the report') {
  const calls = [];
  const run = async (opts) => {
    calls.push(opts);
    opts.messages.push({ role: 'assistant', content: reply });
    return opts.messages;
  };
  return { run, calls };
}

const names = (tools) => tools.map((t) => t.function.name);

test('the task tool exists only at the top level', () => {
  config.subagents = true;
  assert.deepEqual(names(taskTools(0)), ['task']);
  assert.deepEqual(taskTools(1), [], 'a sub-agent cannot be handed the tool that spawns one');
  assert.deepEqual(taskTools(2), []);
});

test('delegation can be turned off entirely', () => {
  config.subagents = false;
  assert.deepEqual(taskTools(0), []);
  config.subagents = true;
});

test('the task tool names every agent it will accept', () => {
  const { parameters } = TASK_TOOL.function;
  assert.deepEqual(parameters.properties.agent.enum, Object.keys(AGENTS));
  assert.deepEqual(parameters.required, ['agent', 'prompt']);
});

test('explore cannot touch anything', () => {
  const tools = names(subagentTools('explore'));
  assert.deepEqual(tools, ['read_file', 'list_dir', 'search']);
});

test('code can write and run, and neither agent can plan or delegate', () => {
  const code = names(subagentTools('code'));
  assert.ok(code.includes('write_file') && code.includes('bash'));
  for (const agent of Object.keys(AGENTS)) {
    const tools = names(subagentTools(agent));
    assert.ok(!tools.includes('set_plan'), `${agent} must not touch the caller's checklist`);
    assert.ok(!tools.includes('task'), `${agent} must not delegate further`);
  }
});

test('the system prompt carries the role rules and the project primer', () => {
  config.projectPrimer = 'PROJECT PRIMER HERE';
  const explore = systemFor('explore');
  assert.match(explore, /only read/);
  assert.match(explore, /PROJECT PRIMER HERE/);
  assert.match(systemFor('code'), /RUN it and fix what breaks/);
  config.projectPrimer = null;
  assert.doesNotMatch(systemFor('explore'), /PROJECT PRIMER HERE/);
});

test('an unknown agent is an error, and nothing runs', async () => {
  const { run, calls } = stubRun();
  const out = await runTask({ agent: 'architect', prompt: 'do a thing' }, { run, out: quiet });
  assert.match(out, /^error: unknown agent "architect"/);
  assert.match(out, /explore/);
  assert.equal(calls.length, 0);
});

test('a task with no prompt is an error, and nothing runs', async () => {
  const { run, calls } = stubRun();
  const out = await runTask({ agent: 'explore', prompt: '   ' }, { run, out: quiet });
  assert.match(out, /^error: task needs a prompt/);
  assert.equal(calls.length, 0);
});

test('only the report comes back — the transcript stays behind', async () => {
  const { run, calls } = stubRun('STATUS: found it in src/sse.js:12');
  const out = await runTask({ agent: 'explore', prompt: 'find the SSE parser' },
    { run, model: 'main-model', out: quiet });

  assert.equal(out, 'STATUS: found it in src/sse.js:12');
  assert.equal(calls.length, 1);
  const opts = calls[0];
  // Two messages in, one report out: whatever it read never reaches the caller.
  assert.equal(opts.messages[0].role, 'system');
  assert.equal(opts.messages[1].content, 'find the SSE parser');
});

test('a sub-agent runs quietly, in its own context, with the caller untouched', async () => {
  const { run, calls } = stubRun();
  config.subagentSteps = 40;
  await runTask({ agent: 'explore', prompt: 'look' }, { run, model: 'main-model', out: quiet });

  const opts = calls[0];
  assert.equal(opts.depth, 1, 'depth 1 is what removes the task tool below it');
  assert.equal(opts.plan, false, "the caller's checklist is not a sub-agent's to clear");
  assert.equal(opts.stream, false);
  assert.equal(opts.mcp, null);
  assert.equal(opts.maxSteps, 40, 'a finite cap: nobody is watching');
  assert.deepEqual(names(opts.tools), ['read_file', 'list_dir', 'search']);
});

test('approval is the caller’s, not the sub-agent’s', async () => {
  const { run, calls } = stubRun();
  const approve = async () => true;
  const grant = async () => 'no';
  await runTask({ agent: 'code', prompt: 'build it' }, { run, approve, grant, out: quiet });
  assert.equal(calls[0].approve, approve, 'delegation is not a way past the user');
  assert.equal(calls[0].grant, grant);
});

test('sub-agents can run on their own model', async () => {
  const { run, calls } = stubRun();
  config.subagentModel = 'small-model';
  await runTask({ agent: 'explore', prompt: 'look' }, { run, model: 'main-model', out: quiet });
  assert.equal(calls[0].model, 'small-model');

  config.subagentModel = null;
  await runTask({ agent: 'explore', prompt: 'look' }, { run, model: 'main-model', out: quiet });
  assert.equal(calls[1].model, 'main-model');
});

test('a sub-agent that reports nothing says so', async () => {
  const { run } = stubRun('   ');
  const out = await runTask({ agent: 'explore', prompt: 'look' }, { run, out: quiet });
  assert.match(out, /^error: the sub-agent finished without reporting anything/);
});

test('the report is printed, bounded, and handed back whole', async () => {
  const body = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n');
  const { run } = stubRun(body);
  const lines = [];
  const out = await runTask({ agent: 'explore', prompt: 'look' },
    { run, out: (l) => lines.push(l) });

  assert.equal(out, body, 'the model receives every line');
  assert.ok(lines.length < 40, 'the screen does not');
  assert.ok(lines.some((l) => l.includes('more lines')), 'and says how many it hid');
});

test('a sub-agent on another model gets that model’s window, not the session’s', async () => {
  const { run, calls } = stubRun();
  config.contextWindow = 131072;
  config.maxTokens = 16384;
  config.subagentModel = 'small-model';
  config.subagentLimits = { configured: 32768, contextWindow: 32768, maxTokens: 4096 };
  await runTask({ agent: 'explore', prompt: 'look' }, { run, model: 'main-model', out: quiet });
  assert.equal(calls[0].window, 32768, 'compacting a 32k sub-agent at 85% of 131k never fires');
  assert.equal(calls[0].maxTokens, 4096);

  // No sub-agent model: it is the session's model, so the session's limits.
  config.subagentModel = null;
  config.subagentLimits = null;
  await runTask({ agent: 'explore', prompt: 'look' }, { run, model: 'main-model', out: quiet });
  assert.equal(calls[1].window, 131072);
  assert.equal(calls[1].maxTokens, 16384);
});

test('a run is framed on screen: which agent, and what it cost', async () => {
  const { run } = stubRun('found it');
  const lines = [];
  await runTask({ agent: 'explore', prompt: 'which tools need approval, and where is that decided' },
    { run, out: (l) => lines.push(l) });

  const open = lines[0];
  assert.match(open, /explore/, 'two delegated runs in a row are otherwise indistinguishable');
  assert.match(open, /which tools need approval/);

  const close = lines.at(-1);
  assert.match(close, /step/);
  assert.match(close, /s$|json$/);
  assert.match(close, /task-\d+\.json/, 'the report on screen is bounded — this is where the rest is');
});

test('a long prompt is cut on the opening line and whole in the transcript', async () => {
  const prompt = `trace ${'x'.repeat(200)} home`;
  const { run } = stubRun('done');
  const lines = [];
  await runTask({ agent: 'explore', prompt }, { run, out: (l) => lines.push(l) });

  assert.ok(lines[0].length < 120, 'the line stays a line');
  assert.match(lines[0], /…/);
  assert.equal(listRuns().at(-1).prompt, prompt, 'nothing is lost on disk');
});

test('the transcript holds what the caller never sees', async () => {
  const calls = [];
  const run = async (opts) => {
    calls.push(opts);
    opts.messages.push({ role: 'assistant', content: '', tool_calls: [{ function: { name: 'read_file', arguments: '{"path":"src/sse.js"}' } }] });
    opts.messages.push({ role: 'tool', content: 'THE WHOLE FILE' });
    opts.onStep?.(opts.messages, 1);
    opts.messages.push({ role: 'assistant', content: 'it is at src/sse.js:12' });
    return opts.messages;
  };

  const report = await runTask({ agent: 'explore', prompt: 'find the parser' }, { run, out: quiet });
  assert.equal(report, 'it is at src/sse.js:12', 'one report to the caller');

  const saved = readRun(listRuns().at(-1).n);
  assert.equal(saved.steps, 1);
  assert.ok(JSON.stringify(saved.messages).includes('THE WHOLE FILE'),
    'and everything it read on the file, where the window does not pay for it');
  assert.equal(saved.report, 'it is at src/sse.js:12');
});

test('a sub-agent that throws still leaves its transcript and still says where', async () => {
  const run = async (opts) => {
    opts.messages.push({ role: 'assistant', content: '', tool_calls: [{ function: { name: 'bash', arguments: '{}' } }] });
    opts.messages.push({ role: 'tool', content: 'got this far' });
    opts.onStep?.(opts.messages, 1);
    throw new Error('connection reset');
  };
  const lines = [];
  await assert.rejects(
    () => runTask({ agent: 'code', prompt: 'reproduce it' }, { run, out: (l) => lines.push(l) }),
    /connection reset/);

  const saved = readRun(listRuns().at(-1).n);
  assert.equal(saved.steps, 1);
  assert.ok(JSON.stringify(saved.messages).includes('got this far'), 'the run that died is the one worth reading');
  assert.match(lines.at(-1), /task-\d+\.json/, 'and the user is told where it is');
});

test('with transcripts off the run is still framed, just not recorded', async () => {
  config.taskLog = false;
  const { run } = stubRun('done');
  const lines = [];
  await runTask({ agent: 'explore', prompt: 'look' }, { run, out: (l) => lines.push(l) });
  config.taskLog = true;

  assert.match(lines[0], /explore/);
  assert.doesNotMatch(lines.at(-1), /\.json/, 'nothing to point at');
  assert.match(lines.at(-1), /step/, 'but still what it cost');
});
