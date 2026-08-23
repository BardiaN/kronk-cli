import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { runTurn } from '../src/agent.js';
import { TOOLS, NEEDS_APPROVAL, runTool } from '../src/tools.js';
import { clearPlan, isReminder, plan, MAX_ITEMS } from '../src/plan.js';
import { startStub } from './fixtures/kronk-stub.js';

const MODEL = 'stub/Model-Q4/AGENT';
const OPEN = [
  { text: 'keep the push trigger', status: 'todo' },
  { text: 'write the three docs', status: 'todo' },
  { text: 'run the static analysis', status: 'todo' },
];
const opener = { calls: [{ name: 'set_plan', args: { items: OPEN } }] };

const start = () => [
  { role: 'system', content: 'sys' },
  { role: 'user', content: 'do the whole ticket' },
];

/**
 * Drive one turn against a scripted stub and hand back what it received.
 *
 * The harness narrates every round to `console.log`, and every assertion here
 * is about the request bodies instead, so that narration is dropped for the
 * duration. Only `console.log`: the test reporter writes to the stdout stream
 * directly, and replacing that swallows the results too.
 */
async function turn({ turns = [], messages = start(), auto = false, maxSteps = Infinity } = {}) {
  const stub = await startStub({ ids: [MODEL], turns });
  const savedUrl = config.baseUrl;
  const savedLog = console.log;
  config.baseUrl = stub.url;
  console.log = () => {};
  try {
    await runTurn({ messages, model: MODEL, approve: async () => true, auto, maxSteps });
  } finally {
    console.log = savedLog;
    config.baseUrl = savedUrl;
    stub.close();
  }
  return { stub, messages, sent: stub.chat.map((b) => b.messages) };
}

const reminders = (msgs) => msgs.filter(isReminder);

/**
 * Walk a request body: an assistant message carrying tool_calls must be
 * followed immediately by one `role: 'tool'` reply per call, in order, with
 * nothing wedged in between — the ordering an OpenAI-compatible server and a
 * Qwen chat template both require.
 */
function assertToolPairing(msgs, where) {
  for (let i = 0; i < msgs.length; i += 1) {
    const calls = msgs[i].tool_calls;
    if (!calls?.length) continue;
    for (let n = 0; n < calls.length; n += 1) {
      const reply = msgs[i + 1 + n];
      assert.ok(reply, `${where}: tool call ${calls[n].id} has no reply`);
      assert.equal(reply.role, 'tool', `${where}: message ${i + 1 + n} broke the tool block`);
      assert.equal(reply.tool_call_id, calls[n].id, `${where}: tool replies out of order`);
    }
  }
}

/** No chat template has to guess what two adjacent user messages mean. */
function assertNoAdjacentUsers(msgs, where) {
  for (let i = 1; i < msgs.length; i += 1) {
    assert.ok(!(msgs[i].role === 'user' && msgs[i - 1].role === 'user'),
      `${where}: two consecutive user messages at ${i}`);
  }
}

// 1
test('set_plan is offered to the model and needs no approval', async () => {
  assert.ok(TOOLS.some((t) => t.function.name === 'set_plan'), 'missing from TOOLS');
  assert.ok(!NEEDS_APPROVAL.has('set_plan'), 'a checklist touches nothing');

  const { stub } = await turn();
  const offered = stub.chat[0].tools.map((t) => t.function.name);
  assert.ok(offered.includes('set_plan'), `runTurn offered ${offered.join(', ')}`);
});

// 2
test('a second set_plan replaces the first — it does not merge or append', async () => {
  clearPlan();
  await runTool('set_plan', { items: [{ text: 'first', status: 'doing' }] });
  const result = await runTool('set_plan', { items: [{ text: 'second', status: 'todo' }] });

  assert.deepEqual(plan(), [{ text: 'second', status: 'todo' }]);
  assert.match(result, /1\. \[todo\] second/);
  assert.doesNotMatch(result, /first/);
});

// 3
test('an over-long plan is truncated and the loss is reported back', async () => {
  clearPlan();
  const items = Array.from({ length: 45 }, (_, n) => ({ text: `item ${n + 1}`, status: 'todo' }));
  const result = await runTool('set_plan', { items });

  assert.equal(plan().length, MAX_ITEMS);
  assert.equal(plan().at(-1).text, 'item 40');
  assert.match(result, /45 items were sent/);
  assert.match(result, /capped at 40/);
  assert.match(result, /last 5 were dropped/);
});

test('set_plan refuses input it cannot store, with a fixable message', async () => {
  clearPlan();
  assert.match(await runTool('set_plan', { items: 'the plan' }), /^error: set_plan needs an "items" array/);
  assert.match(await runTool('set_plan', { items: [{ status: 'todo' }] }), /^error: set_plan: item 1 has no text/);
  assert.match(await runTool('set_plan', { items: [{ text: 'a', status: 'in progress' }] }),
    /^error: set_plan: item 1 has status "in progress" — use todo, doing or done/);
  assert.deepEqual(plan(), [], 'a rejected call must not leave half a plan behind');
});

test('a plan is never distilled, however long it is', async () => {
  // Distillation is a second model call on any tool result over
  // config.distillAt, and the plan rendering easily passes that. It would be
  // paying the model to paraphrase text the harness wrote, so the stub must
  // see one request per round and no extra.
  const long = Array.from({ length: MAX_ITEMS }, (_, n) => ({
    text: `criterion ${n + 1}: ${'a requirement stated at length. '.repeat(10)}`,
    status: 'todo',
  }));
  assert.ok(JSON.stringify(long).length > config.distillAt, 'the fixture is too small to prove anything');

  const { sent } = await turn({ turns: [{ calls: [{ name: 'set_plan', args: { items: long } }] }] });
  assert.equal(sent.length, 2, 'one planning round and the reply — a distill pass would add a third');
});

// 4
test('exactly one reminder per round, after the tool results, gone when the plan is done', async () => {
  const half = OPEN.map((i, n) => ({ ...i, status: n === 0 ? 'done' : 'todo' }));
  const { sent } = await turn({
    turns: [
      opener,
      { calls: [{ name: 'set_plan', args: { items: half } }, { name: 'list_dir', args: { path: '.' } }] },
      { calls: [{ name: 'set_plan', args: { items: half } }] },
      { calls: [{ name: 'set_plan', args: { items: half } }] },
      { calls: [{ name: 'set_plan', args: { items: half } }] },
      { calls: [{ name: 'set_plan', args: { items: OPEN.map((i) => ({ ...i, status: 'done' })) } }] },
      { text: 'all of it is done' },
    ],
  });

  assert.equal(sent.length, 7, 'six scripted rounds and the closing reply');
  assert.equal(reminders(sent[0]).length, 0, 'nothing to remind anyone of before the first set_plan');

  for (const [n, msgs] of sent.entries()) {
    assertToolPairing(msgs, `round ${n + 1}`);
    assertNoAdjacentUsers(msgs, `round ${n + 1}`);
  }

  for (const n of [1, 2, 3, 4, 5]) {
    assert.equal(reminders(sent[n]).length, 1, `round ${n + 1} carried ${reminders(sent[n]).length} reminders`);
    const last = sent[n].at(-1);
    assert.ok(isReminder(last), `round ${n + 1}: the reminder is not last`);
    assert.equal(sent[n].at(-2).role, 'tool', `round ${n + 1}: the reminder is not after the tool results`);
    assert.match(last.content, /write the three docs/, 'open items are quoted verbatim');
    // Round 2 still carries the plan as first written; from round 3 the first
    // item has been marked done and must have dropped out of the open list.
    assert.match(last.content, n === 1 ? /0\/3 items done/ : /1\/3 items done/);
    if (n > 1) assert.doesNotMatch(last.content, /keep the push trigger/, 'a finished item is still listed as open');
  }

  assert.equal(reminders(sent[6]).length, 0, 'the reminder goes once every item is done');
});

// 5
test('the plan survives compaction and the reminder is re-injected after it', async () => {
  const { sent, messages } = await turn({
    turns: [
      opener,
      { status: 400, message: 'prompt exceeds context window (4096)' },
      { text: 'a summary of the work so far' },   // the compaction pass
      { text: 'carrying on' },
    ],
  });

  assert.equal(sent.length, 4);
  assert.equal(reminders(sent[1]).length, 1, 'the overflowing request carried the reminder');
  assert.deepEqual(plan().map((i) => i.text), OPEN.map((i) => i.text),
    'module state, so compaction cannot reach it');

  const after = sent[3];
  assert.ok(!after.some((m) => m.content === 'do the whole ticket'),
    'compaction really did replace the transcript');
  assert.equal(reminders(after).length, 1, 'and the reminder came back');
  assert.ok(isReminder(after.at(-1)));
  assert.equal(reminders(messages).length, 0, 'nothing left dangling once the turn returns');
});

// 6
test('autonomously, a premature summary is handed back — twice, then it stops', async () => {
  const { sent, messages } = await turn({
    auto: true,
    turns: [opener, { text: 'done!' }, { text: 'really, done!' }, { text: 'done, honestly' }],
  });

  assert.equal(sent.length, 4, 'one planning round plus three replies, two of them nudged');
  for (const [n, msgs] of sent.entries()) {
    assertToolPairing(msgs, `round ${n + 1}`);
    assertNoAdjacentUsers(msgs, `round ${n + 1}`);
    assert.ok(reminders(msgs).length <= 1, `round ${n + 1} carried two reminders`);
  }
  for (const n of [2, 3]) {
    assert.match(sent[n].at(-1).content, /stopped with work outstanding/, `round ${n + 1} was not nudged`);
    assert.equal(sent[n].at(-2).content, n === 2 ? 'done!' : 'really, done!',
      'the nudge replaced the previous reminder rather than joining it');
  }
  assert.equal(messages.at(-1).content, 'done, honestly', 'the third reply is accepted');
  assert.equal(reminders(messages).length, 0);
});

// 7
test('the step cap still wins over the nudge', async () => {
  const { sent, messages } = await turn({
    auto: true,
    maxSteps: 3,
    turns: [opener, { text: 'done!' }, { text: 'done!' }, { text: 'done!' }],
  });

  assert.equal(sent.length, 3, '--steps 3 means three requests, nudges or not');
  assert.equal(messages.at(-1).content, '(stopped: step cap reached)');
  assert.equal(reminders(messages).length, 0);
});

// 8
test('outside autonomous mode a no-tool-call reply ends the turn at once', async () => {
  const { sent, messages } = await turn({
    turns: [opener, { text: 'done!' }, { text: 'this must never be asked for' }],
  });

  assert.equal(sent.length, 2, 'the same script that nudged twice must not nudge at all here');
  assert.equal(messages.at(-1).content, 'done!');
});

// 9
test('with no plan the turn runs exactly as it did before', async () => {
  const { sent, messages } = await turn({
    turns: [{ calls: [{ name: 'list_dir', args: { path: '.' } }] }, { text: 'there you go' }],
  });

  assert.equal(sent.length, 2);
  for (const msgs of sent) assert.equal(msgs.filter(isReminder).length, 0);
  assert.deepEqual(messages.map((m) => m.role),
    ['system', 'user', 'assistant', 'tool', 'assistant']);
  assert.equal(messages.at(-1).content, 'there you go');
});

// 10
test('a plan does not leak into the next turn', async () => {
  await turn({ turns: [opener, { text: 'stopping here' }] });
  assert.equal(plan().length, 3, 'the plan outlives the turn that made it');

  const { sent } = await turn({ turns: [{ text: 'a different question entirely' }] });
  assert.equal(plan().length, 0, 'runTurn starts every turn with a clean sheet');
  assert.equal(reminders(sent[0]).length, 0);
});
