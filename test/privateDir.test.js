import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, chmodSync, statSync, symlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { privateDir } from '../src/privateDir.js';

const base = mkdtempSync(join(tmpdir(), 'kronk-privatedir-'));
const mode = (p) => statSync(p).mode & 0o777;
const posix = typeof process.getuid === 'function';

test('a new directory is created owner-only', () => {
  const d = join(base, 'fresh', 'nested');
  privateDir(d);
  if (posix) assert.equal(mode(d), 0o700);
});

test('an existing directory of ours that is too open is tightened', { skip: !posix }, () => {
  const d = join(base, 'open');
  mkdirSync(d);
  chmodSync(d, 0o777);
  privateDir(d);
  assert.equal(mode(d), 0o700);
});

test('a symlink in place of the directory is refused', { skip: !posix }, () => {
  const target = join(base, 'elsewhere');
  mkdirSync(target);
  const link = join(base, 'planted');
  symlinkSync(target, link);
  assert.throws(() => privateDir(link), /not a plain directory/);
  assert.throws(() => privateDir(link, { create: false }), /not a plain directory/);
});

test("a directory owned by someone else is refused, for reads as well as writes", { skip: !posix }, () => {
  const d = join(base, 'theirs');
  mkdirSync(d);
  const real = process.getuid;
  process.getuid = () => real() + 1;
  try {
    assert.throws(() => privateDir(d), /belongs to another user/);
    assert.throws(() => privateDir(d, { create: false }), /belongs to another user/);
  } finally {
    process.getuid = real;
  }
});

test('the read-side check does not create anything', () => {
  const d = join(base, 'never-made');
  assert.equal(privateDir(d, { create: false }), d);
  assert.equal(existsSync(d), false);
});
