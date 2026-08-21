import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { config, DEFAULT_MODEL } from '../src/config.js';
import { pickDefault, ensureLoaded } from '../src/boot.js';

const run = promisify(execFile);
const CLI = new URL('../src/index.js', import.meta.url).pathname;
const OTHER = 'stub/Other-Q4/AGENT';

/**
 * A Kronk stand-in with a controllable pool. `resident` is what
 * /v1/kronk/models/ps reports; `fail` maps a model id to the status its
 * admission should refuse with, which is how a model too large to fit
 * announces itself. Every completion request is recorded so a test can prove
 * what the CLI asked for — and, just as usefully, what it did not.
 */
function startStub({ ids, resident = [], fail = {} } = {}) {
  const chat = [];
  const send = (res, code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server = createServer((req, res) => {
    const url = req.url.split('?')[0];

    if (url === '/v1/models') {
      return send(res, 200, { object: 'list', data: ids.map((id) => ({ id, object: 'model' })) });
    }
    if (url === '/v1/kronk/models/ps') {
      return send(res, 200, resident.map((id) => ({ id, status: 'loaded', vram_total: 1e9 })));
    }
    if (url.startsWith('/v1/kronk/models')) {
      return send(res, 200, {
        model_config: { 'context-window': 4096 },
        metadata: { 'stub.context_length': '8192' },
        data: [],
      });
    }
    if (url === '/v1/tokenize') return send(res, 200, { tokens: 7 });

    if (url === '/v1/chat/completions') {
      let raw = '';
      req.on('data', (d) => { raw += d; });
      return req.on('end', () => {
        const body = JSON.parse(raw);
        chat.push(body);
        if (fail[body.model]) {
          return send(res, fail[body.model], { error: { message: 'insufficient VRAM for admission' } });
        }
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
        res.write(`data: ${chunk({ role: 'assistant', content: 'STUB_OK' })}\n`);
        res.write(`data: ${chunk({}, 'stop')}\n`);
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
      // undici keeps the socket alive, so a plain close() would leave the test
      // process holding an open handle long after the assertions are done.
      close: () => { server.closeAllConnections(); server.close(); },
    }));
  });
}

/** Point the module-level config at a stub for one test, then put it back. */
async function against(stub, model, fn) {
  const saved = { baseUrl: config.baseUrl, model: config.model };
  config.baseUrl = stub.url;
  config.model = model;
  const log = [];
  try {
    const id = await ensureLoaded(await modelsOf(stub), (m) => log.push(m));
    return { id, log: log.join('\n') };
  } finally {
    Object.assign(config, saved);
    stub.close();
    if (fn) fn();
  }
}

const modelsOf = async (stub) =>
  (await (await fetch(`${stub.url}/models`)).json()).data.map((m) => m.id);

test('pickDefault prefers an /AGENT profile and ignores non-chat models', () => {
  assert.equal(pickDefault(['a/b', 'a/b/AGENT']), 'a/b/AGENT');
  assert.equal(pickDefault(['x/Qwen3-Embedding-0.6B', 'x/chat']), 'x/chat');
  assert.equal(pickDefault([]), null);
});

test('a resident model is left alone — no load request at all', async () => {
  const stub = await startStub({ ids: [DEFAULT_MODEL], resident: [DEFAULT_MODEL] });
  const { id } = await against(stub, DEFAULT_MODEL);
  assert.equal(id, DEFAULT_MODEL);
  assert.deepEqual(stub.chat, [], 'a model already in the pool must not be reloaded');
});

test('a cold model is admitted with the cheapest possible completion', async () => {
  const stub = await startStub({ ids: [DEFAULT_MODEL], resident: [] });
  const { id, log } = await against(stub, DEFAULT_MODEL);

  assert.equal(id, DEFAULT_MODEL);
  assert.equal(stub.chat.length, 1, 'exactly one warm-up request');
  const [warmUp] = stub.chat;
  assert.equal(warmUp.model, DEFAULT_MODEL);
  assert.equal(warmUp.max_completion_tokens, 1, 'the reply is discarded, so ask for one token');
  assert.equal(warmUp.enable_thinking, false, 'reasoning would only slow the load down');
  assert.ok(!warmUp.stream, 'nothing is rendered, so nothing needs streaming');
  assert.match(log, /loaded/);
});

test('a model that will not fit falls back to the default', async () => {
  const stub = await startStub({
    ids: [OTHER, DEFAULT_MODEL],
    fail: { [OTHER]: 507 },
  });
  const { id, log } = await against(stub, OTHER);

  assert.equal(id, DEFAULT_MODEL, 'the fallback must be the one left selected');
  assert.match(log, /failed to load/);
  assert.match(log, /fallback/);
  assert.deepEqual(stub.chat.map((c) => c.model), [OTHER, DEFAULT_MODEL]);
});

test('a fallback already in the pool is used without loading anything', async () => {
  const stub = await startStub({
    ids: [OTHER, DEFAULT_MODEL],
    resident: [DEFAULT_MODEL],
    fail: { [OTHER]: 507 },
  });
  const { id } = await against(stub, OTHER);

  assert.equal(id, DEFAULT_MODEL);
  assert.deepEqual(stub.chat.map((c) => c.model), [OTHER], 'only the doomed first attempt');
});

test('every candidate is tried once, and a total failure is not fatal', async () => {
  const stub = await startStub({
    ids: [OTHER, DEFAULT_MODEL],
    fail: { [OTHER]: 507, [DEFAULT_MODEL]: 507 },
  });
  const { id } = await against(stub, OTHER);

  assert.equal(id, OTHER, 'the original pick stands so the first turn reports the real error');
  const tried = stub.chat.map((c) => c.model);
  assert.deepEqual(tried, [...new Set(tried)], 'no id is attempted twice');
  assert.deepEqual(new Set(tried), new Set([OTHER, DEFAULT_MODEL]));
});

/** Run the CLI itself against a stub, with a throwaway HOME so ~/.kronk-cli.json cannot interfere. */
async function cli(stub, args) {
  const env = { ...process.env, KRONK_URL: stub.url, HOME: mkdtempSync(join(tmpdir(), 'kronk-home-')), NO_COLOR: '1' };
  delete env.KRONK_MODEL;
  delete env.KRONK_WARM;
  // stdin must be closed, not merely idle: with an open pipe the CLI waits on
  // it for piped context and the test would hang instead of failing.
  return run(process.execPath, [CLI, '--no-context', ...args],
    { env, timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
}

test('the CLI preloads before the first turn, and --no-warm skips it', async (t) => {
  const ids = [OTHER];

  const warms = await startStub({ ids });
  const on = await cli(warms, ['hello']);
  warms.close();
  assert.match(on.stdout, /STUB_OK/);
  assert.match(on.stderr, /loaded/, 'the wait is announced rather than silent');
  assert.deepEqual(warms.chat.map((c) => Boolean(c.stream)), [false, true],
    'a warm-up, then the real streamed turn');

  const cold = await startStub({ ids });
  const off = await cli(cold, ['--no-warm', 'hello']);
  cold.close();
  assert.match(off.stdout, /STUB_OK/, '--no-warm still answers');
  assert.doesNotMatch(off.stderr, /loaded/);
  assert.deepEqual(cold.chat.map((c) => Boolean(c.stream)), [true],
    'no warm-up: the first real turn pays the load');
  t.diagnostic(`with warm-up: ${warms.chat.length} requests, without: ${cold.chat.length}`);
});
