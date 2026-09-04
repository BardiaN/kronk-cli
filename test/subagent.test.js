import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import {
  AGENTS, TASK_TOOL, taskTools, subagentTools, systemFor, runTask,
} from '../src/subagent.js';

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
