import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { imageMessage, imagePart, textOf, forWire, hasImage } from '../src/image.js';
import { runTool, session } from '../src/tools.js';
import { config } from '../src/config.js';
import { runTurn } from '../src/agent.js';
import { startStub } from './fixtures/kronk-stub.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const MODEL = 'stub/Model-Q4/AGENT';

test('imageMessage: null without images, otherwise one user message with a caption', () => {
  assert.equal(imageMessage([]), null);
  assert.equal(imageMessage(undefined), null);
  const m = imageMessage([imagePart(PNG, 'image/png', 'a.png'), imagePart(PNG, 'image/png', 'b')]);
  assert.equal(m.role, 'user');
  assert.equal(m.content[0].text, '[image from read_file: a.png, b]');
  assert.equal(m.content.filter((p) => p.type === 'image_url').length, 2);
  assert.ok(hasImage(m));
  assert.equal(textOf(m.content), '[image from read_file: a.png, b]\n[image: a.png]\n[image: b]');
  assert.ok(!JSON.stringify(forWire(m)).includes('"name"'));
});

function inTemp(fn) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'rfi-')));
  const saved = { ...session };
  session.root = dir;
  session.cwd = dir;
  writeFileSync(join(dir, 'Screenshot test'), PNG);
  writeFileSync(join(dir, 'note.txt'), 'plain text');
  return fn(dir).finally(() => Object.assign(session, saved));
}

test('read_file hands an image to the caller, and still reads text', () => inTemp(async () => {
  const images = [];
  const r = await runTool('read_file', { path: 'Screenshot test' }, { images });
  assert.match(r, /^image attached: Screenshot test \(image\/png/);
  assert.equal(images.length, 1);
  assert.equal(images[0].name, 'Screenshot test');
  assert.equal(await runTool('read_file', { path: 'note.txt' }, { images }), 'plain text');
  assert.equal(images.length, 1);
  assert.match(await runTool('read_file', { path: '../x' }, { images }), /^error:.*outside/);
}));

async function turn(calls) {
  const stub = await startStub({ ids: [MODEL], turns: [{ calls }] });
  const saved = { url: config.baseUrl, log: console.log };
  config.baseUrl = stub.url;
  console.log = () => {};
  const messages = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'go' }];
  try {
    await runTurn({ messages, model: MODEL, approve: async () => true, auto: true });
  } finally {
    console.log = saved.log;
    config.baseUrl = saved.url;
    stub.close();
  }
  return messages;
}

test('runTurn follows the tool results with one user message carrying the image', () => inTemp(async () => {
  const messages = await turn([{ name: 'read_file', args: { path: 'Screenshot test' } }]);
  const at = messages.findIndex((m) => m.role === 'tool');
  assert.match(messages[at].content, /image attached/);
  assert.equal(messages[at + 1].role, 'user');
  assert.ok(hasImage(messages[at + 1]));
}));

test('batched reads: all tool results first, then a single image message', () => inTemp(async () => {
  const messages = await turn([
    { name: 'read_file', args: { path: 'Screenshot test' } },
    { name: 'read_file', args: { path: 'note.txt' } },
    { name: 'read_file', args: { path: 'Screenshot test' } },
  ]);
  const roles = messages.slice(2).map((m) => m.role);
  assert.deepEqual(roles.slice(0, 5), ['assistant', 'tool', 'tool', 'tool', 'user']);
  assert.equal(messages[6].content.filter((p) => p.type === 'image_url').length, 2);
}));
