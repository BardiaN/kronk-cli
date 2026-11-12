import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  sniffMime, buildContent, imagePart, textOf, forWire, hasImage, isImagePath, loadImage, MAX_IMAGE_BYTES,
} from '../src/image.js';
import { session } from '../src/tools.js';
import { startRun, transcriptLines } from '../src/tasklog.js';
import { config } from '../src/config.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
const GIF = Buffer.from('GIF89a....');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);

test('sniffMime reads the bytes, not the name', () => {
  assert.equal(sniffMime(PNG), 'image/png');
  assert.equal(sniffMime(JPG), 'image/jpeg');
  assert.equal(sniffMime(GIF), 'image/gif');
  assert.equal(sniffMime(WEBP), 'image/webp');
  assert.equal(sniffMime(Buffer.from('hello world, not an image')), null);
  assert.equal(sniffMime(Buffer.alloc(0)), null);
  assert.equal(sniffMime(Buffer.from('RIFF0000WAVEfmt ')), null);
});

test('isImagePath matches the supported extensions case-insensitively', () => {
  for (const p of ['a.png', 'a.JPG', 'a.jpeg', 'a.webp', 'a.gif']) assert.ok(isImagePath(p), p);
  assert.ok(!isImagePath('a.txt'));
  assert.ok(!isImagePath('a.svg'));
});

test('buildContent keeps a string a string unless there are images', () => {
  assert.equal(buildContent('hi', []), 'hi');
  const c = buildContent('look', [imagePart(PNG, 'image/png', 'x.png')]);
  assert.equal(c[0].type, 'text');
  assert.equal(c[0].text, 'look');
  assert.equal(c[1].type, 'image_url');
  assert.match(c[1].image_url.url, /^data:image\/png;base64,/);
});

test('textOf turns images into placeholders and tolerates odd content', () => {
  const t = textOf(buildContent('look', [imagePart(PNG, 'image/png', 'x.png')]));
  assert.match(t, /\[image: x\.png\]/);
  assert.ok(!t.includes('base64'));
  assert.equal(textOf('plain'), 'plain');
  assert.equal(textOf(null), '');
  assert.equal(textOf(undefined), '');
});

test('forWire strips the bookkeeping name and leaves strings alone', () => {
  const m = { role: 'user', content: buildContent('q', [imagePart(PNG, 'image/png', 'x.png')]) };
  assert.ok(hasImage(m));
  assert.equal('name' in forWire(m).content[1], false);
  assert.ok(forWire(m).content[1].image_url.url.startsWith('data:'));
  const s = { role: 'user', content: 'x' };
  assert.equal(forWire(s), s);
  assert.ok(!hasImage(s));
});

test('a task transcript with array content does not throw or inline base64', () => {
  config.taskLogDir = mkdtempSync(join(tmpdir(), 'kronk-img-'));
  config.taskLog = true;
  const content = buildContent('look', [imagePart(PNG, 'image/png', 'x.png')]);
  const run = startRun({ agent: 'explore', prompt: 'p', model: 'm' });
  run.step([{ role: 'system', content: 's' }, { role: 'user', content: 'p' },
    { role: 'assistant', content }], 1);
  const lines = transcriptLines(run.n).join('\n');
  assert.match(lines, /\[image: x\.png\]/);
  assert.ok(!lines.includes('base64'));
});

test('loadImage enforces the root, the size cap and the magic bytes', async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'img-')));
  const saved = { ...session };
  session.root = dir;
  session.cwd = dir;
  try {
    writeFileSync(join(dir, 'a.png'), JPG); // wrong extension on purpose
    const ok = await loadImage('a.png');
    assert.equal(ok.mime, 'image/jpeg');
    assert.match(ok.part.image_url.url, /^data:image\/jpeg;base64,/);

    writeFileSync(join(dir, 'bad.png'), 'not an image');
    await assert.rejects(loadImage('bad.png'), /does not look like/);

    writeFileSync(join(dir, 'big.png'), Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]));
    await assert.rejects(loadImage('big.png'), /capped at 10 MB/);

    await assert.rejects(loadImage('.'), /not a regular file/);

    // optional: a file that is not an image is null, not an error
    writeFileSync(join(dir, 'note'), 'just text, long enough to be read');
    assert.equal(await loadImage('note', { optional: true }), null);
    assert.equal((await loadImage('a.png', { optional: true })).mime, 'image/jpeg');

    await assert.rejects(loadImage('../outside.png'), /outside/);
  } finally {
    Object.assign(session, saved);
  }
});
