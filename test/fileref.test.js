import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mentionsFile, parseFileRefs, isBareRef, resolves, buildFileMessage,
} from '../src/fileref.js';
import { loadImage } from '../src/image.js';
import { resolveFileArg } from '../src/filearg.js';
import { session, consentFile } from '../src/tools.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const only = (names) => async (arg) => names.includes(arg);

test('a quoted reference in the middle of a sentence', async () => {
  const p = await parseFileRefs('in this /file "asdas asdas asdas.png" what do you see?');
  assert.deepEqual(p.segments, [
    { text: 'in this ' }, { ref: 'asdas asdas asdas.png' }, { text: ' what do you see?' },
  ]);
  assert.deepEqual(p.refs, ['asdas asdas asdas.png']);
  assert.ok(!isBareRef(p));
});

test('single quotes, escaped double quotes, and several references', async () => {
  const p = await parseFileRefs('compare /file \'a b.png\' with /file "say \\"hi\\".txt" please');
  assert.deepEqual(p.refs, ['a b.png', 'say "hi".txt']);
  assert.equal(p.segments.length, 5);
});

test('a line that is only one reference is the bare form', async () => {
  assert.ok(isBareRef(await parseFileRefs('/file "a b.png"')));
  assert.ok(isBareRef(await parseFileRefs('/file a.png', only(['a.png']))));
  assert.ok(!isBareRef(await parseFileRefs('/file "a b.png" what is this?')));
  assert.ok(!isBareRef(await parseFileRefs('/file a.png b.png', only(['a.png']))));
});

test('unquoted: the longest run of words that resolves wins', async () => {
  const probe = only(['my notes.txt', 'my']);
  const p = await parseFileRefs('/file my notes.txt explain it', probe);
  assert.deepEqual(p.refs, ['my notes.txt']);
  assert.deepEqual(p.segments[1], { text: ' explain it' });
});

test('unquoted: falls back to the first word, and strips trailing punctuation when that resolves', async () => {
  assert.deepEqual((await parseFileRefs('/file nothing here', only([]))).refs, ['nothing']);
  const p = await parseFileRefs('what is in /file a.png?', only(['a.png']));
  assert.deepEqual(p.segments, [{ text: 'what is in ' }, { ref: 'a.png' }, { text: '?' }]);
});

test('unquoted: at most eight words are tried', async () => {
  const nine = 'a b c d e f g h i';
  const p = await parseFileRefs(`/file ${nine}`, async (arg) => arg === nine);
  assert.deepEqual(p.refs, ['a']);
});

test('not matched: /files, foo/file, a bare /file, /file with no space after', async () => {
  for (const line of ['/files a.png', 'see foo/file x', 'just /file', '/file"a"', 'a /filex b']) {
    const p = await parseFileRefs(line);
    assert.deepEqual(p.refs, [], line);
    assert.equal(p.segments.map((s) => s.text).join(''), line);
  }
});

test('an escaped \\/file is literal text without its backslash', async () => {
  const p = await parseFileRefs('type \\/file to attach, then /file "x.png"');
  assert.deepEqual(p.refs, ['x.png']);
  assert.equal(p.segments[0].text, 'type /file to attach, then ');
  const lone = await parseFileRefs('use \\/file x');
  assert.deepEqual(lone.refs, []);
  assert.equal(lone.segments[0].text, 'use /file x');
  assert.ok(mentionsFile('use \\/file x'));
  assert.ok(!mentionsFile('use \\/files x'));
});

test('an unterminated quote falls back to unquoted words', async () => {
  const p = await parseFileRefs('/file "a b.png what');
  assert.equal(p.refs.length, 1);
});

function inTemp(fn) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'fileref-')));
  const saved = { ...session };
  session.root = dir;
  session.cwd = dir;
  writeFileSync(join(dir, 'Screenshot test'), PNG);
  writeFileSync(join(dir, 'my notes.txt'), 'hello notes');
  writeFileSync(join(dir, 'blob.bin'), Buffer.from([1, 0, 2, 0xff]));
  return fn(dir).finally(() => Object.assign(session, saved));
}
const build = (line) => parseFileRefs(line, resolves)
  .then((p) => buildFileMessage(p, { load: loadImage, read: readFile }));

test('buildFileMessage: image and text references become parts, context and mentions', () => inTemp(async () => {
  const b = await build('look at /file "Screenshot test" and /file my notes.txt explain');
  assert.equal(b.text, 'look at [image: Screenshot test] and [file: my notes.txt] explain');
  assert.equal(b.images.length, 1);
  assert.equal(b.contexts.length, 1);
  assert.match(b.contexts[0], /^Contents of .*my notes\.txt:\n\n```\nhello notes\n```$/);
  assert.ok(b.notes.length === 0);
}));

test('buildFileMessage: any failure blocks the whole message and lists every error', () => inTemp(async () => {
  const b = await build('/file "Screenshot test" and /file "missing.png" and /file blob.bin ok');
  assert.equal(b.text, undefined);
  assert.equal(b.errors.length, 2);
  assert.match(b.errors[0], /not found: .*missing\.png/);
  assert.match(b.errors[1], /blob\.bin is binary/);
}));

test('buildFileMessage: a path above the launch folder is attached, because the user typed it', () => inTemp(async (dir) => {
  const up = join(dir, '..', `up-${process.pid}.txt`);
  writeFileSync(up, 'from above');
  try {
    // The REPL resolves through a wrapper that records the consent (src/index.js).
    const attach = async (arg) => { const r = await resolveFileArg(arg); consentFile(r.path); return r; };
    const p = await parseFileRefs(`what is /file "${up}" ?`, resolves);
    const b = await buildFileMessage(p, { resolve: attach, load: loadImage, read: readFile });
    assert.equal(b.errors, undefined);
    assert.match(b.contexts[0], /from above/);
  } finally { rmSync(up, { force: true }); session.readFiles.clear(); }
}));
