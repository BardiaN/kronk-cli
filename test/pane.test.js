import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  visibleWidth, paneWidth, clip, pad, renderPane, paneUsable, watchEsc, livePane,
} from '../src/pane.js';
import { EventEmitter } from 'node:events';
import { useTheme } from '../src/theme.js';

// eslint-disable-next-line no-control-regex -- stripping ANSI is the point
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

/** A terminal that records what was written to it instead of showing it. */
function fakeTty({ columns = 60 } = {}) {
  const writes = [];
  return { isTTY: true, columns, write(s) { writes.push(s); return true; }, writes,
    get text() { return writes.join(''); } };
}

test('printed width ignores colour escapes', () => {
  useTheme({ name: 'dark', colors: 256 });
  assert.equal(visibleWidth('\x1b[38;5;245mhello\x1b[0m'), 5);
  assert.equal(visibleWidth('plain'), 5);
});

test('the box is clamped to a readable width whatever the terminal claims', () => {
  assert.equal(paneWidth(80), 78);
  assert.equal(paneWidth(20), 40, 'never narrower than the hints it has to carry');
  assert.equal(paneWidth(400), 100, 'never so wide the eye has to travel');
  assert.equal(paneWidth(undefined), 78, 'a terminal that does not say is assumed 80');
});

test('clipping counts printed characters, not bytes', () => {
  assert.equal(clip('abcdef', 10), 'abcdef', 'short enough is left alone');
  assert.equal(strip(clip('abcdefghij', 5)), 'abcd…');
  assert.equal(visibleWidth(clip('abcdefghij', 5)), 5);
});

test('a clipped colour never leaks into the rest of the terminal', () => {
  useTheme({ name: 'dark', colors: 256 });
  const out = clip('\x1b[38;5;245mabcdefghij\x1b[0m', 5);
  assert.equal(strip(out), 'abcd…');
  assert.ok(out.endsWith('\x1b[0m'), 'the cut closes what it opened');
  // The escape is copied whole — a half-written one would paint the screen.
  assert.ok(out.startsWith('\x1b[38;5;245m'));
});

test('a cut with no colour in it stays free of escapes', () => {
  useTheme({ name: 'dark', colors: 0 });
  assert.equal(clip('abcdefghij', 5), 'abcd…');
  useTheme({ colors: 256 });
});

test('padding fills to the printed width, escapes discounted', () => {
  useTheme({ name: 'dark', colors: 256 });
  assert.equal(visibleWidth(pad('\x1b[1mhi\x1b[0m', 10)), 10);
});

// The one invariant worth asserting mechanically: an off-by-one in the border
// arithmetic is invisible in a diff and unmissable on screen.
for (const width of [40, 47, 60, 100]) {
  for (const agent of ['explore', 'code']) {
    test(`every line of a ${width}-wide ${agent} box is exactly ${width} columns`, () => {
      useTheme({ name: 'dark', colors: 256 });
      const lines = renderPane({
        agent,
        rows: ['⚙ read src/tools.js', 'x'.repeat(300), ''],
        status: '6/40 · 48s',
        hint: 'esc to collapse · ctrl-c to stop',
        width,
      });
      for (const l of lines) assert.equal(visibleWidth(l), width, `"${strip(l)}"`);
    });
  }
}

test('the frame says which agent, how far in, and how to get out', () => {
  const lines = renderPane({
    agent: 'explore', rows: ['⚙ read src/tools.js'],
    status: '6/40 · 48s', hint: 'esc to collapse · ctrl-c to stop', width: 60,
  }).map(strip);

  assert.match(lines[0], /^┌─ explore ─+ 6\/40 · 48s ─┐$/);
  assert.match(lines[1], /^│ ⚙ read src\/tools\.js +│$/);
  assert.match(lines.at(-1), /^└─ esc to collapse · ctrl-c to stop ─+┘$/);
  assert.equal(lines.length, 3, 'one row in, one row of box');
});

test('a row longer than the box is cut, not allowed to break the frame', () => {
  const lines = renderPane({ agent: 'code', rows: ['a'.repeat(400)], width: 50 }).map(strip);
  assert.equal(lines[1].length, 50);
  assert.ok(lines[1].endsWith('… │'));
});

test('a pipe, a dumb terminal and a redirect all take the old path', () => {
  assert.equal(paneUsable({ isTTY: false }, {}), false, 'CI greps this output');
  assert.equal(paneUsable({ isTTY: true }, { TERM: 'dumb' }), false, 'no cursor to address');
  assert.equal(paneUsable(undefined, {}), false);
  assert.equal(paneUsable({ isTTY: true }, { TERM: 'xterm-256color' }), true);
});

test('with no terminal the pane is inert and the caller needs no branch', () => {
  const pane = livePane({ agent: 'explore', stream: { isTTY: false } });
  assert.equal(pane.enabled, false);
  const approve = async () => true;
  assert.equal(pane.shield(approve), approve, 'the approval prompt is passed straight through');
  // None of these may throw, and none may print.
  pane.open(); pane.line('anything'); pane.step(3); pane.collapse(); pane.close();
});

test('opening draws the box once, and a new line redraws it in place', () => {
  useTheme({ name: 'dark', colors: 0 });
  const stream = fakeTty();
  const pane = livePane({ agent: 'explore', maxSteps: 40, stream, tickMs: 10_000, now: () => 0 });
  pane.open();

  const first = stream.text;
  assert.ok(!first.startsWith('\r'), 'the first paint moves no cursor — there is nothing above it');
  // eslint-disable-next-line no-control-regex -- a cursor-up is exactly what must not be there
  assert.ok(!/\x1b\[\d+A/.test(first), 'in particular it never scrolls back over the conversation');
  assert.match(first, /┌─ explore /);

  stream.writes.length = 0;
  pane.line('⚙ read src/tools.js');
  const second = stream.text;
  // eslint-disable-next-line no-control-regex -- the cursor move is what is being asserted
  assert.match(second, /^\r\x1b\[2A/, 'up over the two rows it drew, then repaint');
  assert.match(second, /⚙ read src\/tools\.js/);
});

test('only the last rows survive, so the box cannot scroll the terminal', () => {
  useTheme({ name: 'dark', colors: 0 });
  const stream = fakeTty();
  const pane = livePane({ agent: 'explore', rows: 3, stream, tickMs: 10_000, now: () => 0 });
  pane.open();
  for (let i = 1; i <= 9; i += 1) pane.line(`step ${i}`);

  // The last frame is the box as it now stands; everything before it was painted over.
  const frame = stream.writes.at(-1).split('\n');
  const body = frame.filter((l) => /step \d/.test(l));
  assert.equal(body.length, 3, 'three rows on screen');
  assert.ok(frame.some((l) => l.includes('step 9')) && frame.some((l) => l.includes('step 7')));
  assert.ok(!frame.some((l) => l.includes('step 6')),
    'and the fourth-from-last is gone from the box, not from the file');
});

test('one fed line containing newlines becomes several rows', () => {
  useTheme({ name: 'dark', colors: 0 });
  const stream = fakeTty();
  const pane = livePane({ agent: 'code', rows: 6, stream, tickMs: 10_000, now: () => 0 });
  pane.open();
  pane.line('⚙ bash: npm test\n  ✓ 354 lines');
  const rows = stream.writes.at(-1).split('\n').filter((l) => l.startsWith('│'));
  assert.equal(rows.length, 2);
});

test('closing erases the box and leaves the cursor where it started', () => {
  useTheme({ name: 'dark', colors: 0 });
  const stream = fakeTty();
  const pane = livePane({ agent: 'explore', stream, tickMs: 10_000, now: () => 0 });
  pane.open();
  pane.line('⚙ read a');
  stream.writes.length = 0;
  pane.close();
  assert.equal(stream.text, '\r\x1b[3A\x1b[J', 'up over the box, then clear to the end of the screen');

  stream.writes.length = 0;
  pane.close();
  assert.equal(stream.text, '', 'closing twice is a no-op — runTask closes from both paths');
});

test('esc gives the screen back and the run carries on into the transcript', () => {
  useTheme({ name: 'dark', colors: 0 });
  const stream = fakeTty();
  const pane = livePane({ agent: 'explore', stream, tickMs: 10_000, now: () => 0 });
  pane.open();
  pane.collapse();
  const after = stream.text;

  stream.writes.length = 0;
  pane.line('⚙ still working');
  pane.step(7);
  assert.equal(stream.text, '', 'nothing is drawn once it is collapsed');
  // eslint-disable-next-line no-control-regex -- the erase is what is being asserted
  assert.match(after, /\x1b\[J$/, 'and what was there is gone');
});

test('the approval prompt gets the terminal to itself, and the box comes back', () => {
  useTheme({ name: 'dark', colors: 0 });
  const stream = fakeTty();
  const pane = livePane({ agent: 'code', stream, tickMs: 10_000, now: () => 0 });
  pane.open();
  pane.line('⚙ write src/x.js');

  const asked = [];
  const approve = pane.shield(async (name) => { asked.push([name, stream.text]); return true; });

  stream.writes.length = 0;
  return approve('write_file').then((ok) => {
    assert.equal(ok, true, 'the answer is passed straight back');
    const [, screenWhenAsked] = asked[0];
    assert.ok(screenWhenAsked.endsWith('\x1b[J'),
      'the box was wiped before the question, so nothing redraws over it');
    assert.match(stream.text, /┌─ code /, 'and drawn again once it is answered');
  });
});

test('a collapsed pane is not redrawn by an approval that follows it', () => {
  useTheme({ name: 'dark', colors: 0 });
  const stream = fakeTty();
  const pane = livePane({ agent: 'code', stream, tickMs: 10_000, now: () => 0 });
  pane.open();
  pane.collapse();
  stream.writes.length = 0;
  return pane.shield(async () => true)('bash').then(() => {
    assert.equal(stream.text, '', 'esc means gone, not gone until the next question');
  });
});

test('shield leaves a missing callback missing rather than inventing one', () => {
  const pane = livePane({ agent: 'explore', stream: fakeTty(), tickMs: 10_000 });
  assert.equal(pane.shield(undefined), undefined);
});

test('the header counts steps, and says so without a cap when there is none', () => {
  useTheme({ name: 'dark', colors: 0 });
  const stream = fakeTty();
  let clock = 0;
  const pane = livePane({ agent: 'explore', stream, tickMs: 10_000, now: () => clock });
  pane.open();
  pane.step(6);
  clock = 48_000;
  pane.line('⚙ read src/agent.js');
  assert.match(stream.writes.at(-1), /6 · 48\.0s/);
  assert.doesNotMatch(stream.writes.at(-1), /6\/Infinity/);
});

test('esc is only offered when a readline is holding stdin, never taken by force', () => {
  const notRaw = { isTTY: true, isRaw: false, on() { assert.fail('must not listen'); } };
  assert.equal(watchEsc({ input: notRaw, onEsc: () => {} }), null);
  assert.equal(watchEsc({ input: { isTTY: false, isRaw: true }, onEsc: () => {} }), null);
  assert.equal(watchEsc({ input: { isTTY: true, isRaw: true } }), null, 'no handler, no listener');
});

test('a bare esc collapses; an arrow key and ctrl-[ do not', () => {
  useTheme({ name: 'dark', colors: 0 });
  // A real emitter: `emitKeypressEvents` inspects the stream it is handed.
  const input = Object.assign(new EventEmitter(), { isTTY: true, isRaw: true });
  const stream = fakeTty();
  const pane = livePane({ agent: 'explore', stream, input, tickMs: 10_000, now: () => 0 });
  pane.open();
  assert.equal(input.listenerCount('keypress'), 1, 'armed, because readline already owns raw mode');
  assert.match(stream.text, /esc to collapse/, 'and only then does the footer offer it');

  // Exactly the shapes node emits: a bare esc arrives with `meta` set, because
  // node only knows it was not the start of a sequence once the timeout fires.
  const press = (key) => input.emit('keypress', undefined, key);
  press({ sequence: '\x1b[A', name: 'up', ctrl: false, meta: false, shift: false });
  press({ sequence: '\x1b', name: 'escape', ctrl: true, meta: true, shift: false });
  stream.writes.length = 0;
  pane.line('⚙ still drawing');
  assert.notEqual(stream.text, '', 'neither of those is the key');

  press({ sequence: '\x1b', name: 'escape', ctrl: false, meta: true, shift: false });
  assert.equal(input.listenerCount('keypress'), 0, 'and collapsing gives the listener back too');
  stream.writes.length = 0;
  pane.line('⚙ and now nothing');
  assert.equal(stream.text, '', 'the box is gone; the run is not');
});

test('without a key watcher the footer does not offer a key that does nothing', () => {
  useTheme({ name: 'dark', colors: 0 });
  const stream = fakeTty();
  const pane = livePane({ agent: 'explore', stream, input: { isTTY: false }, tickMs: 10_000, now: () => 0 });
  pane.open();
  assert.doesNotMatch(stream.text, /esc to collapse/);
  assert.match(stream.text, /ctrl-c to stop/);
});

test('ctrl-c takes the box down before anything is printed over it', () => {
  useTheme({ name: 'dark', colors: 0 });
  const stream = fakeTty();
  const ac = new AbortController();
  const pane = livePane({ agent: 'explore', stream, signal: ac.signal, tickMs: 10_000, now: () => 0 });
  pane.open();
  pane.line('⚙ read src/agent.js');

  stream.writes.length = 0;
  ac.abort();
  // Synchronously, so the REPL's own `interrupted` line lands on a clear
  // screen and the next repaint cannot count rows from the wrong place.
  // eslint-disable-next-line no-control-regex -- the erase is what is being asserted
  assert.match(stream.text, /\x1b\[J$/);

  stream.writes.length = 0;
  pane.line('⚙ and nothing after');
  assert.equal(stream.text, '', 'and it stays down');
});

test('several runs on one turn do not stack listeners on its signal', () => {
  useTheme({ name: 'dark', colors: 0 });
  // One turn can delegate a dozen times against the same signal; node starts
  // warning about a leak at eleven listeners on one target.
  const live = new Set();
  const signal = {
    addEventListener: (_n, fn) => live.add(fn),
    removeEventListener: (_n, fn) => live.delete(fn),
  };
  for (let i = 0; i < 12; i += 1) {
    const pane = livePane({ agent: 'explore', stream: fakeTty(), signal, tickMs: 10_000, now: () => 0 });
    pane.open();
    assert.equal(live.size, 1, 'one at a time');
    pane.close();
    assert.equal(live.size, 0, 'and given back when the run ends');
  }
});
