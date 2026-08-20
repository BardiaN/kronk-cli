/**
 * A minimal stand-in for a Kronk server, used to prove the CLI needs nothing
 * but the host you point it at. Speaks just enough of the API: model discovery,
 * a streamed completion, and tokenisation.
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.STUB_PORT ?? 11435);
const MODEL = 'stub/Model-Q4/AGENT';
const send = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

createServer((req, res) => {
  const url = req.url.split('?')[0];

  if (req.method === 'GET' && url === '/v1/models') {
    return send(res, 200, { object: 'list', data: [{ id: MODEL, object: 'model', owned_by: 'stub' }] });
  }
  if (req.method === 'GET' && url.startsWith('/v1/kronk/models')) {
    return send(res, 200, {
      id: MODEL, model_config: { 'context-window': 4096 },
      metadata: { 'stub.context_length': '8192' }, data: [],
    });
  }
  if (req.method === 'POST' && url === '/v1/tokenize') {
    return send(res, 200, { tokens: 7 });
  }
  if (req.method === 'POST' && url === '/v1/chat/completions') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunk = (delta, finish = null) => JSON.stringify({
      id: 'chatcmpl-stub', object: 'chat.completion.chunk', model: MODEL,
      choices: [{ index: 0, delta, finish_reason: finish }], usage: null,
    });
    res.write(`data: ${chunk({ role: 'assistant', content: 'EGRESS' })}\n`);
    res.write(`data: ${chunk({ content: '_OK' })}\n`);
    res.write(`data: ${chunk({}, 'stop')}\n`);
    res.write('data: [DONE]\n');
    return res.end();
  }
  return send(res, 404, { error: { message: `stub has no route for ${url}` } });
}).listen(PORT, '127.0.0.1', () => console.error(`stub listening on 127.0.0.1:${PORT}`));
