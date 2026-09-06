import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { setImmediate as tickImmediate } from 'node:timers/promises';
import { deferredPrompt, PromptClosed } from '../src/prompt.js';

/** A pipe that readline will treat as a terminal, which is how it is used. */
function streams() {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  const output = new PassThrough();
  output.isTTY = true;
  output.resume();
  return { input, output };
}

const tick = () => tickImmediate();
const OPTS = { timeout: 5000 };

test('no interface exists until the first question', OPTS, () => {
  const { input, output } = streams();
  const rl = deferredPrompt({ input, output });
  assert.equal(rl.open, false);
  rl.close();                                  // closing an unopened one is a no-op
  assert.equal(rl.open, false);
});

test('a line typed before the first question is answered by it, not lost', OPTS, async () => {
  const { input, output } = streams();
  const rl = deferredPrompt({ input, output });

  // Startup: the model list, a cold load, the project scan. Somebody types.
  input.write('/context\n');
  await tick();
  assert.equal(rl.open, false, 'still nothing consuming stdin');

  assert.equal(await rl.question('› '), '/context');
  rl.close();
});

test('everything typed ahead is kept, in order', OPTS, async () => {
  const { input, output } = streams();
  const rl = deferredPrompt({ input, output });
  input.write('first\nsecond\n');
  await tick();

  assert.equal(await rl.question('› '), 'first');
  assert.equal(await rl.question('› '), 'second');
  rl.close();
});

test('the same interface serves every later question', OPTS, async () => {
  const { input, output } = streams();
  const rl = deferredPrompt({ input, output });

  const first = rl.question('› ');
  assert.equal(rl.open, true);
  input.write('one\n');
  assert.equal(await first, 'one');

  const second = rl.question('approve bash? [y/N] ');
  input.write('y\n');
  assert.equal(await second, 'y');
  rl.close();
});

test('Ctrl-C is handled from the moment the interface exists', OPTS, async () => {
  const { input, output } = streams();
  let interrupts = 0;
  const rl = deferredPrompt({ input, output, onSigint: () => { interrupts += 1; } });

  const asked = rl.question('› ');
  await tick();
  input.write('\x03');                          // Ctrl-C
  await tick();
  assert.equal(interrupts, 1);

  input.write('still here\n');
  assert.equal(await asked, 'still here');
  rl.close();
});

test('a paste that arrives as one read keeps every line', OPTS, async () => {
  const { input, output } = streams();
  const rl = deferredPrompt({ input, output });
  input.write('one\ntwo\nthree\n');
  await tick();

  assert.equal(await rl.question('\u203a '), 'one');
  assert.equal(rl.pending, 2);
  assert.equal(await rl.question('\u203a '), 'two');
  assert.equal(await rl.question('\u203a '), 'three');
  assert.equal(rl.pending, 0);
  rl.close();
});

test('a line typed ahead is echoed after the prompt that answers it', OPTS, async () => {
  const { input, output } = streams();
  let seen = '';
  output.on('data', (d) => { seen += d.toString(); });
  const rl = deferredPrompt({ input, output });
  input.write('/context\n');
  await tick();

  await rl.question('PROMPT> ');
  await tick();
  // readline redraws around it in terminal mode; what matters is that the line
  // appears once, after the prompt that took it.
  assert.match(seen, /PROMPT> [\s\S]*\/context/);
  assert.equal(seen.match(/\/context/g).length, 1);
  rl.close();
});

test('closing under a pending question rejects it rather than hanging', OPTS, async () => {
  const { input, output } = streams();
  const rl = deferredPrompt({ input, output });
  const asked = rl.question('\u203a ');
  await tick();
  rl.close();
  await assert.rejects(asked, PromptClosed);
  await assert.rejects(rl.question('\u203a '), PromptClosed);
});
