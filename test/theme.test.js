import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  PALETTES, ansi, colorDepth, detectTheme, namedTheme, parseColorFgBg, parseOsc11,
  probeBackground, resolveTheme, theme, themeForLuminance, useTheme,
} from '../src/theme.js';

// A tty that answers whatever the test tells it to, so the probe can be
// exercised without one.
function fakeTty(reply, { delay = 0 } = {}) {
  const input = new EventEmitter();
  input.isTTY = true;
  input.isRaw = false;
  input.setRawMode = (on) => { input.isRaw = on; };
  input.resume = () => {};
  input.pause = () => {};
  const output = {
    isTTY: true,
    written: '',
    write(s) {
      output.written += s;
      if (reply === null) return;
      setTimeout(() => input.emit('data', Buffer.from(reply, 'latin1')), delay);
    },
  };
  return { input, output };
}

test('COLORFGBG names the background in its last field', () => {
  assert.equal(parseColorFgBg('15;0'), 'dark');
  assert.equal(parseColorFgBg('0;15'), 'light');
  assert.equal(parseColorFgBg('15;default;0'), 'dark');   // rxvt's three-field form
  assert.equal(parseColorFgBg('7;8'), 'dark');            // bright black is a dark bg
  assert.equal(parseColorFgBg('0;7'), 'light');
});

test('a background COLORFGBG cannot describe leaves the theme unresolved', () => {
  assert.equal(parseColorFgBg('15;default'), null);
  assert.equal(parseColorFgBg(''), null);
  assert.equal(parseColorFgBg(undefined), null);
  assert.equal(parseColorFgBg('12;77'), null);            // not a palette index
});

test('an OSC 11 reply is read at whatever hex width the terminal used', () => {
  const black = parseOsc11('\x1b]11;rgb:0000/0000/0000\x07');
  const white = parseOsc11('\x1b]11;rgb:ffff/ffff/ffff\x1b\\');
  assert.equal(black, 0);
  assert.equal(white, 1);
  // Eight-bit components must not read as near-black just for being short.
  assert.equal(parseOsc11('\x1b]11;rgb:ff/ff/ff\x07'), 1);
  assert.ok(Math.abs(parseOsc11('\x1b]11;rgba:1e1e/1e1e/1e1e/ffff\x07') - 0.1176) < 0.001);
});

test('anything that is not an OSC 11 reply parses to null', () => {
  assert.equal(parseOsc11('\x1b]10;rgb:0000/0000/0000\x07'), null);
  assert.equal(parseOsc11('hello'), null);
  assert.equal(parseOsc11(null), null);
});

test('luminance splits at mid-grey', () => {
  assert.equal(themeForLuminance(0.05), 'dark');
  assert.equal(themeForLuminance(0.49), 'dark');
  assert.equal(themeForLuminance(0.5), 'light');
  assert.equal(themeForLuminance(1), 'light');
});

test('KRONK_THEME beats COLORFGBG, and a typo defers to detection', () => {
  assert.equal(detectTheme({ KRONK_THEME: 'light', COLORFGBG: '15;0' }), 'light');
  assert.equal(detectTheme({ KRONK_THEME: ' DARK ', COLORFGBG: '0;15' }), 'dark');
  assert.equal(detectTheme({ KRONK_THEME: 'auto', COLORFGBG: '15;0' }), 'dark');
  assert.equal(detectTheme({ KRONK_THEME: 'darkk', COLORFGBG: '0;15' }), 'light');
  assert.equal(detectTheme({}), null);
});

test('only dark and light are names', () => {
  assert.equal(namedTheme('Light'), 'light');
  assert.equal(namedTheme('auto'), null);
  assert.equal(namedTheme(undefined), null);
});

test('colour depth honours NO_COLOR, a dumb terminal and a redirect', () => {
  const tty = { isTTY: true };
  assert.equal(colorDepth({ NO_COLOR: '1', TERM: 'xterm-256color' }, tty), 0);
  assert.equal(colorDepth({ TERM: 'dumb' }, tty), 0);
  assert.equal(colorDepth({ TERM: 'xterm-256color' }, { isTTY: false }), 0);
  assert.equal(colorDepth({ TERM: 'xterm-256color', FORCE_COLOR: '1' }, { isTTY: false }), 256);
  assert.equal(colorDepth({ FORCE_COLOR: '0', TERM: 'xterm-256color' }, tty), 0);
});

test('256 colours are used where the terminal advertises them', () => {
  const tty = { isTTY: true };
  assert.equal(colorDepth({ TERM: 'xterm-256color' }, tty), 256);
  assert.equal(colorDepth({ TERM: 'screen-256color' }, tty), 256);
  assert.equal(colorDepth({ TERM: 'xterm', COLORTERM: 'truecolor' }, tty), 256);
  assert.equal(colorDepth({ TERM: 'alacritty' }, tty), 256);
  assert.equal(colorDepth({ TERM: 'xterm' }, tty), 16);
  assert.equal(colorDepth({}, tty), 16);
});

test('the probe resolves from the terminal reply and restores stdin', async () => {
  const { input, output } = fakeTty('\x1b]11;rgb:ffff/ffff/ffff\x07');
  assert.equal(await probeBackground({ input, output, timeoutMs: 500 }), 'light');
  assert.equal(output.written, '\x1b]11;?\x07');
  assert.equal(input.isRaw, false);
  assert.equal(input.listenerCount('data'), 0);
});

test('a dark reply reads as dark', async () => {
  const { input, output } = fakeTty('\x1b]11;rgb:1e1e/1e1e/1e1e\x07');
  assert.equal(await probeBackground({ input, output, timeoutMs: 500 }), 'dark');
});

test('a terminal that never answers times out instead of hanging', async () => {
  const { input, output } = fakeTty(null);
  assert.equal(await probeBackground({ input, output, timeoutMs: 20 }), null);
  assert.equal(input.isRaw, false);
});

test('typing during the probe gives the keystrokes back rather than eating more', async () => {
  const { input, output } = fakeTty('x'.repeat(100));
  assert.equal(await probeBackground({ input, output, timeoutMs: 500 }), null);
  assert.equal(input.listenerCount('data'), 0);
});

test('nothing is written to a stream that is not a terminal', async () => {
  const { output } = fakeTty(null);
  assert.equal(await probeBackground({ input: { isTTY: false }, output }), null);
  assert.equal(output.written, '');
});

test('an explicit preference skips the terminal round trip entirely', async () => {
  const before = theme();
  const { input, output } = fakeTty('\x1b]11;rgb:ffff/ffff/ffff\x07');
  assert.equal(await resolveTheme({ prefer: 'dark', input, output }), 'dark');
  assert.equal(output.written, '');
  useTheme({ name: before });
});

test('the muted grey differs per background, and is lighter on the dark one', () => {
  const dark = PALETTES[256].dark.grey;
  const light = PALETTES[256].light.grey;
  assert.notEqual(dark, light);
  const index = (code) => Number(code.split(';').pop());
  assert.ok(index(dark) > index(light), 'the dark palette must sit higher up the greyscale ramp');
  // 90 is what this program used to print on every background: the bright
  // black that started the whole problem on a dark one.
  assert.notEqual(PALETTES[16].dark.grey, '90');
  assert.equal(PALETTES[16].light.grey, '90');
});

test('both palettes define every entry the ui asks for', () => {
  const names = Object.keys(PALETTES[256].dark);
  for (const depth of [256, 16]) {
    for (const name of ['dark', 'light']) {
      assert.deepEqual(Object.keys(PALETTES[depth][name]).sort(), [...names].sort());
    }
  }
});

test('ansi follows the selected theme and goes silent when colour is off', () => {
  const before = theme();
  useTheme({ name: 'dark', colors: 256 });
  assert.equal(ansi('grey'), PALETTES[256].dark.grey);
  useTheme({ name: 'light' });
  assert.equal(ansi('grey'), PALETTES[256].light.grey);
  useTheme({ colors: 16 });
  assert.equal(ansi('grey'), PALETTES[16].light.grey);
  assert.equal(ansi('nosuchcolour'), null);
  useTheme({ colors: 0 });
  assert.equal(ansi('grey'), null);
  useTheme({ name: before, colors: 0 });
});
