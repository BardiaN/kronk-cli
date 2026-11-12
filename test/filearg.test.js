import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  unquote, expandHome, normName, matchNames, resolveFileArg, classifyBytes,
} from '../src/filearg.js';
import { session } from '../src/tools.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function tree() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kronk-filearg-')));
  session.root = dir;
  session.cwd = dir;
  return dir;
}

test('unquote strips one matching pair and nothing else', () => {
  assert.equal(unquote('"a b.png"'), 'a b.png');
  assert.equal(unquote("  'a b'  "), 'a b');
  assert.equal(unquote('"a b\''), '"a b\'');
  assert.equal(unquote('""x""'), '"x"');
  assert.equal(unquote('plain'), 'plain');
  assert.equal(unquote('"'), '"');
});

test('expandHome handles ~ and ~/ only', () => {
  assert.equal(expandHome('~', '/h'), '/h');
  assert.equal(expandHome('~/Desktop/a', '/h'), '/h/Desktop/a');
  assert.equal(expandHome('~bob/a', '/h'), '~bob/a');
  assert.equal(expandHome('a~/b', '/h'), 'a~/b');
});

test('normName makes every unicode space a plain one', () => {
  assert.equal(normName('a\u202fb\u00a0c\u2007d e'), 'a b c d e');
  assert.equal(normName('e\u0301'), 'é');
});

test('matchNames: exact beats extension fallback, extension only without one', () => {
  assert.deepEqual(matchNames('shot', ['shot', 'shot.png']), ['shot']);
  assert.deepEqual(matchNames('shot', ['shot.png', 'other']), ['shot.png']);
  assert.deepEqual(matchNames('shot', ['shot.txt']), []);
  assert.deepEqual(matchNames('shot.png', ['shot.png.png']), []);
  assert.deepEqual(matchNames('a b', ['a\u202fb']), ['a\u202fb']);
});

test('classifyBytes tells image, text and binary apart', () => {
  assert.equal(classifyBytes(PNG), 'image');
  assert.equal(classifyBytes(Buffer.from('héllo\n')), 'text');
  assert.equal(classifyBytes(Buffer.from([0x68, 0x00, 0x69])), 'binary');
  assert.equal(classifyBytes(Buffer.from([0xff, 0xfe, 0xfd, 0x80])), 'binary');
});

test('resolveFileArg: quoted, extensionless name finds the .png', async () => {
  const dir = tree();
  writeFileSync(join(dir, 'Screenshot 1.png'), PNG);
  const r = await resolveFileArg('"Screenshot 1"');
  assert.equal(r.path, join(dir, 'Screenshot 1.png'));
  assert.match(r.note, /using .*Screenshot 1\.png/);
});

test('resolveFileArg: an existing exact file is used without a note', async () => {
  const dir = tree();
  writeFileSync(join(dir, 'a b'), PNG);
  const r = await resolveFileArg("'a b'");
  assert.equal(r.path, join(dir, 'a b'));
  assert.equal(r.note, null);
});

test('resolveFileArg: U+202F in the real name matches a typed plain space', async () => {
  const dir = tree();
  const real = 'Screenshot 2026-11-03 at 7.51.21\u202fPM.png';
  writeFileSync(join(dir, real), PNG);
  const r = await resolveFileArg('"Screenshot 2026-11-03 at 7.51.21 PM"');
  assert.equal(r.path, join(dir, real));
});

test('resolveFileArg: two candidates are refused, not guessed', async () => {
  const dir = tree();
  writeFileSync(join(dir, 'shot.png'), PNG);
  writeFileSync(join(dir, 'shot.jpg'), PNG);
  await assert.rejects(resolveFileArg('shot'), /ambiguous.*shot\.(png|jpg)/);
});

test('resolveFileArg: not found names the path, the launch folder and a near match', async () => {
  const dir = tree();
  mkdirSync(join(dir, 'Desktop'));
  writeFileSync(join(dir, 'Desktop', 'Screenshot 2.png'), PNG);
  await assert.rejects(resolveFileArg('"Screenshot 2"'), (e) => {
    assert.ok(e.message.includes(`not found: ${join(dir, 'Screenshot 2')}`), e.message);
    assert.ok(e.message.includes(`relative paths resolve against ${dir}`), e.message);
    assert.ok(e.message.includes('Did you mean Desktop/Screenshot 2.png?'), e.message);
    return true;
  });
});

test('resolveFileArg: the suggestion is never attached on its own', async () => {
  const dir = tree();
  mkdirSync(join(dir, 'Desktop'));
  writeFileSync(join(dir, 'Desktop', 'x.png'), PNG);
  await assert.rejects(resolveFileArg('x.png'), /not found/);
});

test('resolveFileArg: ~ expands, and a path outside the launch folder is the user\'s to attach', async () => {
  const dir = tree();
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'kronk-home-')));
  writeFileSync(join(home, 'out.png'), PNG);
  // Typing the path is the consent; the launch folder only limits the model.
  assert.equal((await resolveFileArg('~/out.png', { home })).path, join(home, 'out.png'));
  await assert.rejects(resolveFileArg('../nope.png'), /not found/);
  const inside = join(dir, 'in.png');
  writeFileSync(inside, PNG);
  const r = await resolveFileArg('~/in.png', { home: dir });
  assert.equal(r.path, inside);
});
