import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasImage } from '../src/image.js';
import { modelSeesImages } from '../src/client.js';
import { runTool, session } from '../src/tools.js';
import { config } from '../src/config.js';
import { runTurn } from '../src/agent.js';
import { startStub } from './fixtures/kronk-stub.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const BLIND = 'stub/Blind-Q4/AGENT';
const SEES = 'stub/Seer-Q4/AGENT';
const modelList = [{ id: BLIND, has_projection: false }, { id: SEES, has_projection: true }];

async function inTemp(fn) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'novis-')));
  const saved = { ...session };
  session.root = dir;
  session.cwd = dir;
  writeFileSync(join(dir, 'shot.png'), PNG);
  try { return await fn(dir); } finally { Object.assign(session, saved); }
}

test('read_file does not attach an image for a model without vision, and says so', () => inTemp(async () => {
  const images = [];
  const r = await runTool('read_file', { path: 'shot.png' }, { images, vision: false });
  assert.match(r, /^image NOT shown: shot\.png/);
  assert.match(r, /Do not describe or guess/);
  assert.equal(images.length, 0);
  assert.match(await runTool('read_file', { path: 'shot.png' }, { images, vision: true }), /^image attached/);
  assert.match(await runTool('read_file', { path: 'shot.png' }, { images, vision: null }), /^image attached/);
}));

test('modelSeesImages reads the native list: true, false, or null when unlisted', async () => {
  const stub = await startStub({ ids: [BLIND, SEES], modelList });
  const saved = config.baseUrl;
  config.baseUrl = stub.url;
  try {
    assert.equal(await modelSeesImages(BLIND), false);
    assert.equal(await modelSeesImages(SEES), true);
    assert.equal(await modelSeesImages('stub/Other'), null);
  } finally { config.baseUrl = saved; stub.close(); }
});

test('runTurn warns once, withholds the image and tells the model it was not shown', () => inTemp(async () => {
  const stub = await startStub({ ids: [BLIND], modelList, turns: [{ calls: [{ name: 'read_file', args: { path: 'shot.png' } }] }, { calls: [{ name: 'read_file', args: { path: 'shot.png' } }] }] });
  const saved = { url: config.baseUrl, log: console.log };
  const lines = [];
  config.baseUrl = stub.url;
  console.log = (...a) => lines.push(a.join(' '));
  const messages = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'look' }];
  try {
    await runTurn({ messages, model: BLIND, approve: async () => true, auto: true });
  } finally { console.log = saved.log; config.baseUrl = saved.url; stub.close(); }
  const tools = messages.filter((m) => m.role === 'tool');
  assert.ok(tools.length >= 2);
  assert.ok(tools.every((m) => m.content.startsWith('image NOT shown:')));
  assert.ok(!messages.some(hasImage));
  assert.equal(lines.filter((l) => /has no vision support/.test(l)).length, 1);
}));
