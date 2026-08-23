import { createServer } from 'node:http';

/**
 * A Kronk stand-in with a controllable pool. `resident` is what
 * /v1/kronk/models/ps reports; `fail` maps a model id to the status its
 * admission should refuse with, which is how a model too large to fit
 * announces itself. Every completion request is recorded so a test can prove
 * what the CLI asked for — and, just as usefully, what it did not.
 *
 * `template` is served as the model's chat template, `modelInfoStatus` breaks
 * that route, and `turns` scripts the streamed replies one per request, so a
 * test can drive a real multi-step tool loop instead of a single answer. Each
 * entry is `{ text }`, `{ tool: [name, args] }` for one call, or
 * `{ calls: [{ name, args, id? }] }` for several in the same turn — or
 * `{ status, message }` to make that request fail outright, the shape a
 * context-overflow rejection needs to take. A turn the script does not cover
 * falls back to the plain `STUB_OK` answer with no tool calls, so a test that
 * does not care about the model's side need not pass `turns` at all.
 *
 * `samplingMetadata` and `samplingParameters` feed the same `/kronk/models/{id}`
 * response: the model's own GGUF sampling values (strings, as Kronk reports
 * them) and the effective `sampling-parameters` block after the profile is
 * applied (numbers). Both default to absent, matching a model that ships no
 * sampling metadata at all.
 *
 * Lives in a fixture rather than in one test file because two suites drive it,
 * and importing a `*.test.js` file would run its tests a second time.
 */
export function startStub({
  ids = [], resident = [], fail = {}, template = null, modelInfoStatus = 200, turns = [],
  samplingMetadata = null, samplingParameters = null,
} = {}) {
  const chat = [];
  const queue = [...turns];
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
      if (modelInfoStatus !== 200) {
        return send(res, modelInfoStatus, { error: { message: 'model info unavailable' } });
      }
      return send(res, 200, {
        model_config: {
          'context-window': 4096,
          ...(samplingParameters ? { 'sampling-parameters': samplingParameters } : {}),
        },
        metadata: {
          'stub.context_length': '8192',
          ...(template ? { 'tokenizer.chat_template': template } : {}),
          ...(samplingMetadata ?? {}),
        },
        data: [],
      });
    }
    // Roughly four characters per token, as the real tokenizer is: a constant
    // would make every compaction look like it saved nothing and be skipped.
    if (url === '/v1/tokenize') {
      let raw = '';
      req.on('data', (d) => { raw += d; });
      return req.on('end', () => send(res, 200,
        { tokens: Math.ceil((JSON.parse(raw).input ?? '').length / 4) }));
    }

    if (url === '/v1/chat/completions') {
      let raw = '';
      req.on('data', (d) => { raw += d; });
      return req.on('end', () => {
        const body = JSON.parse(raw);
        chat.push(body);
        if (fail[body.model]) {
          return send(res, fail[body.model], { error: { message: 'insufficient VRAM for admission' } });
        }
        // A scripted rejection, so a test can drive the paths that only open
        // when the server refuses a prompt — an overflowing context above all.
        if (queue[0]?.status) {
          const { status, message } = queue.shift();
          return send(res, status, { error: { message } });
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

        const script = queue.shift() ?? {};
        const text = script.text ?? '';
        const calls = script.calls ?? (script.tool ? [{ name: script.tool[0], args: script.tool[1] }] : []);
        // Nothing scripted at all — the plain default a test that does not
        // care about the model's side can rely on.
        const finalText = text || (calls.length ? '' : 'STUB_OK');

        if (finalText) res.write(`data: ${chunk({ role: 'assistant', content: finalText })}\n`);
        calls.forEach((call, index) => {
          res.write(`data: ${chunk({
            tool_calls: [{
              index,
              id: call.id ?? `call-${chat.length}-${index}`,
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
            }],
          })}\n`);
        });
        res.write(`data: ${chunk({}, calls.length ? 'tool_calls' : 'stop')}\n`);
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
