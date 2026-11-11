import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  termStatus, termStatusEnabled, titleSeq, progressSeq, clearProgressSeq,
  pushTitleSeq, popTitleSeq, TITLES,
} from '../src/termstatus.js';
import { parseArgv } from '../src/argv.js';

const tty = () => {
  const out = [];
  return { isTTY: true, write: (s) => { out.push(s); return true; }, out };
};
const bells = (s) => s.out.filter((x) => x === '\x07').length;

test('sequences are the exact OSC forms', () => {
  assert.equal(titleSeq('a b'), '\x1b]0;a b\x07');
  assert.equal(progressSeq(), '\x1b]9;4;3\x07');
  assert.equal(clearProgressSeq(), '\x1b]9;4;0\x07');
});

test('a title cannot smuggle a terminator or another sequence', () => {
  assert.equal(titleSeq('x\x07\x1b[2Jy'), '\x1b]0;x  [2Jy\x07');
});

test('no sequence moves the cursor or prints a cell', () => {
  const all = [titleSeq(TITLES.working), progressSeq(), clearProgressSeq(), pushTitleSeq(), popTitleSeq()];
  for (const s of all) {
    assert.ok(!/\[\d*[ABCDEFGHJKf]/.test(s.replace('[22;0t', '').replace('[23;0t', '')));
    assert.doesNotMatch(s, /[\r\n]/);
  }
});

test('enabled only on a TTY, not dumb, and not switched off', () => {
  assert.equal(termStatusEnabled({ stream: { isTTY: true }, env: { TERM: 'xterm' } }), true);
  assert.equal(termStatusEnabled({ stream: { isTTY: false }, env: { TERM: 'xterm' } }), false);
  assert.equal(termStatusEnabled({ stream: { isTTY: true }, env: { TERM: 'dumb' } }), false);
  assert.equal(termStatusEnabled({ stream: { isTTY: true }, env: {}, enabled: false }), false);
});

test('disabled writes nothing, ever', () => {
  const s = tty();
  s.isTTY = false;
  const t = termStatus({ stream: s, env: {} });
  t.working(); t.approval(); t.ready(); t.restore();
  assert.deepEqual(s.out, []);
  assert.equal(t.active, false);
});

test('a short turn: title and progress, no bell, then restore', () => {
  const s = tty();
  let ms = 0;
  const t = termStatus({ stream: s, env: {}, now: () => ms });
  t.working();
  ms = 2000;
  t.ready();
  t.restore();
  const all = s.out.join('');
  assert.ok(all.includes(titleSeq(TITLES.working) + progressSeq()));
  assert.ok(all.includes(titleSeq(TITLES.ready) + clearProgressSeq()));
  assert.ok(all.startsWith(pushTitleSeq()));
  assert.ok(all.endsWith(clearProgressSeq() + popTitleSeq()));
  assert.equal(bells(s), 0);
});

test('a long turn rings once when it finishes', () => {
  const s = tty();
  let ms = 0;
  const t = termStatus({ stream: s, env: {}, now: () => ms, bellAfterMs: 10000 });
  t.working();
  ms = 10000;
  t.ready();
  t.ready();
  assert.equal(bells(s), 1);
});

test('an approval prompt rings in a long turn, not in a short one', () => {
  for (const [elapsed, expected] of [[500, 0], [30000, 1]]) {
    const s = tty();
    let ms = 0;
    const t = termStatus({ stream: s, env: {}, now: () => ms });
    t.working();
    ms = elapsed;
    t.approval();
    assert.ok(s.out.join('').includes(titleSeq(TITLES.approval)));
    assert.equal(bells(s), expected);
  }
});

test('restore is idempotent and silent when nothing was shown', () => {
  const s = tty();
  const t = termStatus({ stream: s, env: {} });
  t.restore();
  assert.deepEqual(s.out, []);
  t.working();
  t.restore();
  const n = s.out.length;
  t.restore();
  assert.equal(s.out.length, n);
});

test('--no-term-status parses', () => {
  assert.equal(parseArgv(['--no-term-status']).noTermStatus, true);
  assert.equal(parseArgv([]).noTermStatus, false);
});
