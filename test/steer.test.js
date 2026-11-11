import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { setImmediate as tickImmediate } from 'node:timers/promises';
import { drainSteering, isSteering } from '../src/steer.js';
import { deferredPrompt } from '../src/prompt.js';

const OPTS = { timeout: 5000 };

test('drainSteering appends user messages in order and empties the queue', OPTS, () => {
  const messages = [{ role: 'system', content: 's' }, { role: 'tool', tool_call_id: '1', content: 'ok' }];
  const queue = ['use tabs', '  and skip tests  '];
  assert.equal(drainSteering(messages, queue), 2);
  assert.deepEqual(queue, []);
  assert.equal(messages.length, 4);
  assert.equal(messages[2].role, 'user');
  assert.match(messages[2].content, /use tabs$/);
  assert.match(messages[3].content, /and skip tests$/);
});

test('drainSteering with nothing queued changes nothing', OPTS, () => {
  const messages = [{ role: 'system', content: 's' }];
  assert.equal(drainSteering(messages, []), 0);
  assert.equal(drainSteering(messages, null), 0);
  assert.equal(messages.length, 1);
});

test('drainSteering drops blank lines', OPTS, () => {
  const messages = [];
  assert.equal(drainSteering(messages, ['', '   ']), 0);
  assert.equal(messages.length, 0);
});

test('slash commands are not steering', OPTS, () => {
  assert.equal(isSteering('/clear'), false);
  assert.equal(isSteering('  '), false);
  assert.equal(isSteering('prefer the async API'), true);
});

function streams() {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  const output = new PassThrough();
  output.isTTY = true;
  output.resume();
  return { input, output };
}

test('a line typed mid-turn goes to the steerer; an open question wins over it', OPTS, async () => {
  const { input, output } = streams();
  const rl = deferredPrompt({ input, output });
  const taken = [];
  rl.steer((l) => { taken.push(l); return true; });

  const first = rl.question('› ');            // opens the interface
  input.write('go\n');
  assert.equal(await first, 'go');

  input.write('steer me\n');                  // nobody is asking
  await tickImmediate();
  assert.deepEqual(taken, ['steer me']);
  assert.equal(rl.pending, 0);

  const approval = rl.question('approve? [y/N] ');
  input.write('y\n');                         // an approval prompt is open
  assert.equal(await approval, 'y');
  assert.deepEqual(taken, ['steer me'], 'the answer was not queued as steering');
  rl.close();
});

test('a declined line, and lines after steer(null), are typed ahead as before', OPTS, async () => {
  const { input, output } = streams();
  const rl = deferredPrompt({ input, output });
  rl.steer((l) => l !== '/help');
  const first = rl.question('› ');
  input.write('go\n');
  await first;

  input.write('/help\n');
  await tickImmediate();
  rl.steer(null);
  rl.feed('leftover');
  input.write('later\n');
  await tickImmediate();
  assert.equal(await rl.question('› '), '/help');
  assert.equal(await rl.question('› '), 'leftover');
  assert.equal(await rl.question('› '), 'later');
  rl.close();
});
