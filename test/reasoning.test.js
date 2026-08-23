import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { config } from '../src/config.js';
import { forRequest, lastUserIndex } from '../src/reasoning.js';
import { runTurn } from '../src/agent.js';
import { compact } from '../src/compact.js';

const run = promisify(execFile);
const CLI = new URL('../src/index.js', import.meta.url).pathname;
const MODEL = 'stub/Other-Q4/AGENT';

/** The conditional the Qwen3.6 template guards its think blocks with. */
const SUPPORTS = '{%- if (preserve_thinking is defined and preserve_thinking is true) %}';
const NO_SUPPORT = '{%- for message in messages %}{{ message.content }}{%- endfor %}';

/**
 * A Kronk stand-in that can stream reasoning.
 *
 * Same shape as the stub in test/boot.test.js — every request body is recorded
 * so a test can prove what went on the wire — with one addition: a scripted
 * turn may carry `reasoning`, and `interleave` emits it in alternating
 * reasoning/content deltas instead of reasoning first, which is how a real
 * server behaves when the model starts answering and thinks again mid-reply.
 */
function startStub({ turns = [], template = SUPPORTS } = {}) {
  const chat = [];
  let turn = 0;
  const send = (res, code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server = createServer((req, res) => {
    const url = req.url.split('?')[0];

    if (url === '/v1/models') {
      return send(res, 200, { object: 'list', data: [{ id: MODEL, object: 'model' }] });
    }
    if (url === '/v1/kronk/models/ps') {
      return send(res, 200, [{ id: MODEL, status: 'loaded', vram_total: 1e9 }]);
    }
    if (url.startsWith('/v1/kronk/models')) {
      return send(res, 200, {
        model_config: { 'context-window': 4096 },
        metadata: {
          'stub.context_length': '8192',
          ...(template ? { 'tokenizer.chat_template': template } : {}),
        },
        data: [],
      });
    }
    if (url === '/v1/tokenize') {
      // Length-based rather than a constant: compaction compares before
      // against after and keeps the original when it did not shrink, so a
      // constant would make every compaction a no-op.
      let raw = '';
      req.on('data', (d) => { raw += d; });
      return req.on('end', () => send(res, 200,
        { tokens: Math.ceil(JSON.parse(raw).input.length / 4) }));
    }

    if (url === '/v1/chat/completions') {
      let raw = '';
      req.on('data', (d) => { raw += d; });
      return req.on('end', () => {
        const body = JSON.parse(raw);
        chat.push(body);
        if (!body.stream) {
          return send(res, 200, {
            id: 'chatcmpl-stub',
            choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'length' }],
          });
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const chunk = (delta, finish = null) => JSON.stringify({
          choices: [{ index: 0, delta, finish_reason: finish }],
        });
        const script = turns[turn++] ?? { text: 'STUB_OK' };
        const think = (v) => res.write(`data: ${chunk({ reasoning_content: v })}\n`);
        const say = (v) => res.write(`data: ${chunk({ role: 'assistant', content: v })}\n`);

        if (script.interleave) {
          for (const [kind, v] of script.interleave) (kind === 'r' ? think : say)(v);
        } else if (script.reasoning) {
          // Split so the test also proves the deltas are concatenated, not
          // that the last one wins.
          think(script.reasoning.slice(0, 3));
          think(script.reasoning.slice(3));
        }

        if (script.tool) {
          const [name, args] = script.tool;
          res.write(`data: ${chunk({
            role: 'assistant',
            tool_calls: [{
              index: 0, id: `call_${turn}`, type: 'function',
              function: { name, arguments: JSON.stringify(args) },
            }],
          })}\n`);
          res.write(`data: ${chunk({}, 'tool_calls')}\n`);
        } else {
          if (!script.interleave) say(script.text ?? 'STUB_OK');
          res.write(`data: ${chunk({}, 'stop')}\n`);
        }
        res.write('data: [DONE]\n');
        res.end();
      });
    }
    return send(res, 404, { error: { message: `stub has no route for ${url}` } });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}/v1`,
      chat,
      close: () => { server.closeAllConnections(); server.close(); },
    }));
  });
}

/** Run the CLI itself against a stub, with a throwaway HOME. */
async function cli(stub, args, { env: extra = {}, rc = null } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'kronk-home-'));
  if (rc) writeFileSync(join(home, '.kronk-cli.json'), JSON.stringify(rc));
  const env = { ...process.env, KRONK_URL: stub.url, HOME: home, NO_COLOR: '1' };
  delete env.KRONK_MODEL;
  delete env.KRONK_WARM;
  delete env.KRONK_THINKING;
  delete env.KRONK_NO_THINK;
  delete env.KRONK_PRESERVE_THINKING;
  delete env.KRONK_REPLAY_REASONING;
  Object.assign(env, extra);
  return run(process.execPath, [CLI, '--no-context', '--no-warm', ...args],
    { env, timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
}

const turnsOf = (stub) => stub.chat.filter((b) => b.stream);
/** The assistant messages of a request body, in order. */
const assistants = (body) => body.messages.filter((m) => m.role === 'assistant');

// ---- the boundary, as a pure function ---------------------------------

test('lastUserIndex ignores tool results: a tool loop shares one boundary', () => {
  const messages = [
    { role: 'system', content: 's' },
    { role: 'user', content: 'first' },
    { role: 'assistant', content: '', tool_calls: [] },
    { role: 'tool', tool_call_id: 'a', content: 'out' },
    { role: 'assistant', content: '', tool_calls: [] },
    { role: 'tool', tool_call_id: 'b', content: 'out' },
  ];
  assert.equal(lastUserIndex(messages), 1);
  assert.equal(lastUserIndex([{ role: 'system', content: 's' }]), -1);
  assert.equal(lastUserIndex([]), -1);
});

/** A two-user-prompt history with reasoning on every assistant message. */
const HISTORY = () => [
  { role: 'system', content: 's' },
  { role: 'user', content: 'first prompt' },
  { role: 'assistant', content: 'old answer', reasoning_content: 'OLD_THOUGHT' },
  { role: 'user', content: 'second prompt' },
  { role: 'assistant', content: '', reasoning_content: 'STEP_ONE', tool_calls: [] },
  { role: 'tool', tool_call_id: 'a', content: 'out' },
  { role: 'assistant', content: '', reasoning_content: 'STEP_TWO', tool_calls: [] },
  { role: 'tool', tool_call_id: 'b', content: 'out' },
];

test('forRequest keeps the current tool loop and strips everything before it', () => {
  const saved = { ...config };
  Object.assign(config, { replayReasoning: true, templatePreservesThinking: true, noThink: false });
  try {
    const wire = forRequest(HISTORY());
    assert.deepEqual(wire.map((m) => m.reasoning_content),
      [undefined, undefined, undefined, undefined, 'STEP_ONE', undefined, 'STEP_TWO', undefined]);
  } finally { Object.assign(config, saved); }
});

test('forRequest strips everything when the key, the template, or thinking is off', () => {
  const saved = { ...config };
  const only = (m) => m.reasoning_content;
  try {
    for (const off of [{ replayReasoning: false }, { templatePreservesThinking: false }, { noThink: true }]) {
      Object.assign(config,
        { replayReasoning: true, templatePreservesThinking: true, noThink: false }, off);
      assert.deepEqual(forRequest(HISTORY()).filter(only), [], JSON.stringify(off));
    }
  } finally { Object.assign(config, saved); }
});

test('forRequest never mutates the caller history, and drops an empty string', () => {
  const saved = { ...config };
  Object.assign(config, { replayReasoning: true, templatePreservesThinking: true, noThink: false });
  try {
    const messages = HISTORY();
    messages.push({ role: 'assistant', content: 'x', reasoning_content: '' });
    const wire = forRequest(messages);
    assert.equal(messages[2].reasoning_content, 'OLD_THOUGHT', 'the history keeps its own copy');
    assert.ok(!('reasoning_content' in wire[2]), 'the wire copy does not carry it');
    assert.ok(!('reasoning_content' in wire[8]), 'an empty string is a key not worth sending');
    assert.equal(wire[4], messages[4], 'a message that needs no change is shared, not copied');
  } finally { Object.assign(config, saved); }
});

// ---- the tri-state default: unset follows `auto`, set overrides it --------

test('with replayReasoning unset, the auto argument alone decides', () => {
  const saved = { ...config };
  Object.assign(config, { replayReasoning: undefined, templatePreservesThinking: true, noThink: false });
  try {
    assert.deepEqual(forRequest(HISTORY(), true).map((m) => m.reasoning_content),
      [undefined, undefined, undefined, undefined, 'STEP_ONE', undefined, 'STEP_TWO', undefined],
      'auto: true replays the current task, same as the explicit-on case above');
    assert.deepEqual(forRequest(HISTORY(), false).filter((m) => m.reasoning_content), [],
      'auto: false (or omitted) replays nothing');
    assert.deepEqual(forRequest(HISTORY()).filter((m) => m.reasoning_content), [],
      'and that is also the default when auto is not passed at all');
  } finally { Object.assign(config, saved); }
});

test('replayReasoning: true forces replay on even when auto is false', () => {
  const saved = { ...config };
  Object.assign(config, { replayReasoning: true, templatePreservesThinking: true, noThink: false });
  try {
    assert.deepEqual(forRequest(HISTORY(), false).map((m) => m.reasoning_content),
      [undefined, undefined, undefined, undefined, 'STEP_ONE', undefined, 'STEP_TWO', undefined]);
  } finally { Object.assign(config, saved); }
});

test('replayReasoning: false forces replay off even when auto is true', () => {
  const saved = { ...config };
  Object.assign(config, { replayReasoning: false, templatePreservesThinking: true, noThink: false });
  try {
    assert.deepEqual(forRequest(HISTORY(), true).filter((m) => m.reasoning_content), []);
  } finally { Object.assign(config, saved); }
});

// ---- what actually goes on the wire ------------------------------------
//
// Replay now defaults on for `--auto` and off otherwise (see the tri-state
// tests above), so the mechanics tests here — which are about how reasoning
// is captured and joined, not about the default itself — run autonomous to
// put replay in its on state.

test('1. streamed reasoning comes back on the next request, and only then', async () => {
  const stub = await startStub({
    turns: [
      { reasoning: 'I should list the directory first.', tool: ['list_dir', { path: '.' }] },
      { reasoning: 'That is enough to answer.', text: 'STUB_OK' },
    ],
  });
  const out = await cli(stub, ['--auto', 'look around']);
  stub.close();

  assert.match(out.stdout, /STUB_OK/);
  const turns = turnsOf(stub);
  assert.equal(turns.length, 2);
  assert.deepEqual(assistants(turns[0]), [], 'the first request has no assistant message yet');
  assert.deepEqual(assistants(turns[1]).map((m) => m.reasoning_content),
    ['I should list the directory first.'], 'exactly the deltas, concatenated');
});

test('2. a model that emits no reasoning produces the message it always did', async () => {
  const stub = await startStub({
    turns: [{ tool: ['list_dir', { path: '.' }] }, { text: 'STUB_OK' }],
  });
  const out = await cli(stub, ['look around']);
  stub.close();

  assert.match(out.stdout, /STUB_OK/);
  const [, second] = turnsOf(stub);
  assert.deepEqual(assistants(second), [{
    role: 'assistant',
    content: '',
    tool_calls: [{
      id: 'call_1', type: 'function',
      function: { name: 'list_dir', arguments: '{"path":"."}' },
    }],
  }], 'no reasoning_content key at all, not an empty one');
});

test('3. reasoning interleaved with content assembles into one well-formed message', async () => {
  const stub = await startStub({
    turns: [
      { interleave: [['r', 'first '], ['c', 'Hello '], ['r', 'second'], ['c', 'world.']],
        tool: ['list_dir', { path: '.' }] },
      { text: 'STUB_OK' },
    ],
  });
  const out = await cli(stub, ['--auto', 'hello']);
  stub.close();

  assert.match(out.stdout, /STUB_OK/);
  const [assistant] = assistants(turnsOf(stub)[1]);
  assert.equal(assistant.reasoning_content, 'first second', 'reasoning joins reasoning');
  assert.equal(assistant.content, 'Hello world.', 'content joins content — the two never mix');
});

test('4. tool_calls and reasoning coexist in the replayed message', async () => {
  const stub = await startStub({
    turns: [
      { reasoning: 'list_dir on src is the cheapest next move.', tool: ['list_dir', { path: 'src' }] },
      { text: 'STUB_OK' },
    ],
  });
  const out = await cli(stub, ['--auto', 'look at src']);
  stub.close();

  assert.match(out.stdout, /STUB_OK/);
  const [assistant] = assistants(turnsOf(stub)[1]);
  assert.deepEqual(assistant, {
    role: 'assistant',
    content: '',
    reasoning_content: 'list_dir on src is the cheapest next move.',
    tool_calls: [{
      id: 'call_1', type: 'function',
      function: { name: 'list_dir', arguments: '{"path":"src"}' },
    }],
  });
  const body = turnsOf(stub)[1];
  assert.equal(body.messages.at(-1).role, 'tool', 'the tool result still follows its call');
});

test('6. the config key off, by env and by file, overrides the autonomous default to off', async () => {
  // Autonomous, so the default here is on: this proves the override beats it,
  // not merely that it agrees with an already-off default.
  for (const how of [{ env: { KRONK_REPLAY_REASONING: 'false' } }, { rc: { replayReasoning: false } }]) {
    const stub = await startStub({
      turns: [
        { reasoning: 'thinking about it', tool: ['list_dir', { path: '.' }] },
        { reasoning: 'and again', text: 'STUB_OK' },
      ],
    });
    const out = await cli(stub, ['--auto', 'look around'], how);
    stub.close();

    assert.match(out.stdout, /STUB_OK/, JSON.stringify(how));
    for (const body of stub.chat) {
      for (const m of body.messages) {
        assert.ok(!('reasoning_content' in m), `${JSON.stringify(how)}: ${JSON.stringify(m)}`);
      }
    }
  }
});

test('KRONK_REPLAY_REASONING=true overrides the interactive default to on', async () => {
  // Non-autonomous, so the default here is off: this proves the override
  // beats it, not merely that it agrees with an already-on default.
  const stub = await startStub({
    turns: [
      { reasoning: 'thinking about it', tool: ['list_dir', { path: '.' }] },
      { reasoning: 'and again', text: 'STUB_OK' },
    ],
  });
  const out = await cli(stub, ['look around'], { env: { KRONK_REPLAY_REASONING: 'true' } });
  stub.close();

  assert.match(out.stdout, /STUB_OK/);
  const [, second] = turnsOf(stub);
  assert.deepEqual(assistants(second).map((m) => m.reasoning_content), ['thinking about it']);
});

test('interactive (non-autonomous) run replays no reasoning, even though the template supports it', async () => {
  const stub = await startStub({
    turns: [
      { reasoning: 'thinking about it', tool: ['list_dir', { path: '.' }] },
      { reasoning: 'and again', text: 'STUB_OK' },
    ],
  });
  const out = await cli(stub, ['look around']);
  stub.close();

  assert.match(out.stdout, /STUB_OK/);
  for (const body of stub.chat) {
    for (const m of body.messages) assert.ok(!('reasoning_content' in m));
  }
});

test('a template that does not declare preserve_thinking gets no reasoning either', async () => {
  const stub = await startStub({
    template: NO_SUPPORT,
    turns: [
      { reasoning: 'thinking about it', tool: ['list_dir', { path: '.' }] },
      { text: 'STUB_OK' },
    ],
  });
  // Autonomous, so the template gate is what has to do the work here — the
  // auto-only default would otherwise be enough on its own to explain a
  // request with no reasoning_content.
  const out = await cli(stub, ['--auto', 'look around']);
  stub.close();

  assert.match(out.stdout, /STUB_OK/);
  for (const body of stub.chat) {
    for (const m of body.messages) assert.ok(!('reasoning_content' in m));
  }
});

test('--no-think leaves nothing to replay', async () => {
  const stub = await startStub({
    turns: [
      { reasoning: 'thinking about it', tool: ['list_dir', { path: '.' }] },
      { text: 'STUB_OK' },
    ],
  });
  // Autonomous, so --no-think is what has to do the work here — see above.
  const out = await cli(stub, ['--auto', '--no-think', 'look around']);
  stub.close();

  assert.match(out.stdout, /STUB_OK/);
  for (const body of stub.chat) {
    for (const m of body.messages) assert.ok(!('reasoning_content' in m));
  }
});

// ---- 5. the boundary, end to end ---------------------------------------
//
// This one needs two user prompts in a single session, which the CLI's
// one-shot path cannot produce and its interactive path cannot be fed: with
// stdin a pipe, the CLI reads all of it as the prompt before the REPL starts.
// So the agent loop is driven directly here instead of through a subprocess —
// still a real HTTP stub and still asserting on the recorded request bodies,
// which is what the case is actually about.

test('5. a second user prompt strips the previous task, and only the previous task (autonomous)', async () => {
  const stub = await startStub({
    turns: [
      { reasoning: 'FIRST_STEP_ONE', tool: ['list_dir', { path: '.' }] },
      { reasoning: 'FIRST_STEP_TWO', tool: ['list_dir', { path: 'src' }] },
      { reasoning: 'FIRST_ANSWER', text: 'done with the first task' },
      { reasoning: 'SECOND_STEP_ONE', tool: ['list_dir', { path: 'test' }] },
      { reasoning: 'SECOND_ANSWER', text: 'done with the second task' },
    ],
  });
  const saved = { ...config };
  // replayReasoning left unset: the boundary behaviour below has to come from
  // the autonomous default (auto: true on both calls), not from an override.
  Object.assign(config, {
    baseUrl: stub.url,
    showThinking: false,
    templatePreservesThinking: true,
    replayReasoning: undefined,
    noThink: false,
  });

  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'first task' },
  ];
  try {
    await runTurn({ messages, model: MODEL, approve: async () => true, auto: true });
    messages.push({ role: 'user', content: 'second task' });
    await runTurn({ messages, model: MODEL, approve: async () => true, auto: true });
  } finally {
    Object.assign(config, saved);
    stub.close();
  }

  const turns = turnsOf(stub);
  assert.equal(turns.length, 5, 'three steps for the first task, two for the second');

  // Mid-first-task: the loop's own reasoning is there, because no new user
  // message has arrived to end the task.
  assert.deepEqual(assistants(turns[1]).map((m) => m.reasoning_content), ['FIRST_STEP_ONE']);
  assert.deepEqual(assistants(turns[2]).map((m) => m.reasoning_content),
    ['FIRST_STEP_ONE', 'FIRST_STEP_TWO']);

  // The final request. Everything at or before the second user prompt has
  // been stripped; everything after it is intact.
  const last = turns.at(-1);
  const cut = last.messages.findIndex((m) => m.content === 'second task');
  assert.ok(cut > 0, 'the second prompt is in the body');
  for (const m of last.messages.slice(0, cut + 1)) {
    assert.ok(!('reasoning_content' in m), `stale reasoning survived: ${JSON.stringify(m)}`);
  }
  assert.deepEqual(last.messages.slice(cut + 1).filter((m) => m.role === 'assistant')
    .map((m) => m.reasoning_content), ['SECOND_STEP_ONE']);

  // And the first task's reasoning really did exist to be stripped.
  assert.deepEqual(assistants(last).map((m) => m.content),
    ['', '', 'done with the first task', '']);
});

// ---- compaction ---------------------------------------------------------

test('compaction summarizes the live reasoning and leaves none of it behind', async () => {
  const stub = await startStub({ turns: [{ text: 'The user asked twice; both tasks are done.' }] });
  const saved = { ...config };
  Object.assign(config, {
    baseUrl: stub.url, templatePreservesThinking: true, replayReasoning: true, noThink: false,
  });

  let res;
  try {
    res = await compact(HISTORY(), { model: MODEL });
  } finally {
    Object.assign(config, saved);
    stub.close();
  }

  for (const m of res.messages) {
    assert.ok(!('reasoning_content' in m), `compacted history kept ${JSON.stringify(m)}`);
  }
  assert.deepEqual(res.messages.map((m) => m.role), ['system', 'user', 'assistant']);

  // What the summarizer was shown: the current task's reasoning is in the
  // transcript, the previous task's — which the model could no longer see
  // anyway — is not, so compaction cannot smuggle it back into the prefix.
  const [{ messages: [prompt] }] = stub.chat;
  assert.match(prompt.content, /STEP_ONE/);
  assert.match(prompt.content, /STEP_TWO/);
  assert.doesNotMatch(prompt.content, /OLD_THOUGHT/);
});
