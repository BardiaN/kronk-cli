import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { runTurn } from '../src/agent.js';
import { startStub } from './fixtures/kronk-stub.js';

const MODEL = 'stub/Model-Q4/AGENT';
const OVERFLOW = { status: 400, message: 'prompt exceeds context window (4096)' };

async function run(autoCompact) {
  const stub = await startStub({ ids: [MODEL], turns: [OVERFLOW, { text: 'a summary' }, { text: 'done' }] });
  const saved = { url: config.baseUrl, auto: config.autoCompact, log: console.log };
  config.baseUrl = stub.url;
  config.autoCompact = autoCompact;
  console.log = () => {};
  try {
    const messages = [{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }];
    await runTurn({ messages, model: MODEL, approve: async () => true, auto: false });
  } finally {
    config.baseUrl = saved.url;
    config.autoCompact = saved.auto;
    console.log = saved.log;
    await stub.close?.();
  }
}

test('--no-compact: an overflow from the server surfaces instead of compacting', { timeout: 10000 }, async () => {
  await assert.rejects(run(false), /context window.*auto-compaction is off/);
});
