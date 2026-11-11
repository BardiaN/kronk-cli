import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { runTurn } from '../src/agent.js';
import { parseHooks } from '../src/hooks.js';
import { startStub } from './fixtures/kronk-stub.js';

const MODEL = 'stub/Model-Q4/AGENT';
const node = (js) => `${JSON.stringify(process.execPath)} -e ${JSON.stringify(js)}`;

async function turn(hooks, calls) {
  const stub = await startStub({ ids: [MODEL], turns: [{ calls }] });
  const saved = { url: config.baseUrl, hooks: config.hooks, log: console.log };
  config.baseUrl = stub.url;
  config.hooks = parseHooks(hooks);
  console.log = () => {};
  const messages = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'go' }];
  try {
    await runTurn({ messages, model: MODEL, approve: async () => true, auto: true });
  } finally {
    console.log = saved.log;
    config.baseUrl = saved.url;
    config.hooks = saved.hooks;
    stub.close();
  }
  return messages.filter((m) => m.role === 'tool').map((m) => m.content);
}

test('a pre-hook blocks a read-only call that was batched, and order is kept', async () => {
  const hooks = { pre: [{ match: 'search', command: node('console.error("no searching");process.exit(2)') }] };
  const results = await turn(hooks, [
    { name: 'list_dir', args: { path: '.' } },
    { name: 'search', args: { pattern: 'kronk' } },
    { name: 'list_dir', args: { path: '.' } },
  ]);
  assert.equal(results.length, 3);
  assert.equal(results[1], 'error: blocked by a pre-tool hook: no searching');
  assert.ok(!results[0].startsWith('error:'));
  assert.ok(!results[2].startsWith('error:'));
});

test('a post-hook note reaches a batched call', async () => {
  const hooks = { post: [{ match: 'list_dir', command: node('console.error("seen");process.exit(2)') }] };
  const results = await turn(hooks, [
    { name: 'list_dir', args: { path: '.' } },
    { name: 'list_dir', args: { path: '.' } },
  ]);
  assert.equal(results.length, 2);
  for (const r of results) assert.match(r, /seen/);
});
