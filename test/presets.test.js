import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import {
  loadPresets, expandPreset, resolveInvocation, listPresets, projectPromptsDir,
} from '../src/presets.js';

function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'kronk-presets-'));
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return root;
}

test('later sources win: config < user dir < project dir', () => {
  const root = fixture({
    'user/a.md': 'user a', 'user/b.md': 'user b',
    'proj/.kronk/prompts/b.md': 'project b',
  });
  try {
    const { presets } = loadPresets({
      fromConfig: { a: 'config a', b: 'config b', c: 'config c' },
      userDir: join(root, 'user'),
      projectDir: projectPromptsDir(join(root, 'proj')),
    });
    assert.deepEqual(presets, { a: 'user a', b: 'project b', c: 'config c' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('missing dirs, bad names, empty files and non-md files are ignored', () => {
  const root = fixture({
    'p/Good.md': 'upper', 'p/has space.md': 'x', 'p/empty.md': '  \n', 'p/note.txt': 'x',
    'p/ok-1.md': 'fine\n',
  });
  try {
    const { presets } = loadPresets({
      fromConfig: { 'Bad Name': 'x', n: 5 },
      userDir: join(root, 'nope'),
      projectDir: join(root, 'p'),
    });
    assert.deepEqual(presets, { 'ok-1': 'fine' });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a preset named like a built-in is dropped and reported', () => {
  const { presets, shadowed } = loadPresets({ fromConfig: { clear: 'x', exit: 'y', review: 'z' } });
  assert.deepEqual(presets, { review: 'z' });
  assert.deepEqual(shadowed, ['clear', 'exit']);
});

test('expandPreset substitutes every $ARGS, or appends when there is none', () => {
  assert.equal(expandPreset('look at $ARGS then $ARGS', 'x.js'), 'look at x.js then x.js');
  assert.equal(expandPreset('review', 'the diff'), 'review\n\nthe diff');
  assert.equal(expandPreset('review', ''), 'review');
  assert.equal(expandPreset('do $ARGS now', ''), 'do  now');
  // `$&` in the extra text must stay literal.
  assert.equal(expandPreset('a $ARGS', '$& b'), 'a $& b');
});

test('resolveInvocation only answers for known presets', () => {
  const p = { fix: 'fix $ARGS', plain: 'hello' };
  assert.equal(resolveInvocation('/fix the bug', p), 'fix the bug');
  assert.equal(resolveInvocation('/plain', p), 'hello');
  assert.equal(resolveInvocation('/nope', p), null);
  assert.equal(resolveInvocation('/constructor', p), null);
  assert.equal(resolveInvocation('fix', p), null);
});

test('listPresets previews the first non-empty line, truncated', () => {
  const lines = listPresets({ a: '\nfirst line\nsecond', b: 'x'.repeat(100) }, 10);
  assert.equal(lines[0], '/a  first line');
  assert.equal(lines[1], `/b  ${'x'.repeat(9)}…`);
});

test('commandWord splits on the whole word, so /steps-audit is not /steps', async () => {
  const { commandWord } = await import('../src/presets.js');
  assert.equal(commandWord('/steps'), 'steps');
  assert.equal(commandWord('/steps 5'), 'steps');
  assert.equal(commandWord('/steps-audit src'), 'steps-audit');
  assert.equal(commandWord('hello'), null);
});
