import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPresets } from '../src/presets.js';

const config = fileURLToPath(new URL('../src/config.js', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'kronk-cfgwarn-'));

/** Load config.js against a config file with this content and return its warnings. */
function warningsFor(content, name = 'rc.json') {
  const rc = join(dir, name);
  if (content !== null) writeFileSync(rc, content);
  const r = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { warnConfigProblems } from ${JSON.stringify(config)}; warnConfigProblems();`],
  { env: { ...process.env, KRONK_CONFIG: rc }, encoding: 'utf8' });
  return r.stderr;
}

test('a config file that is not JSON is named, with the parse error and what it disables', () => {
  const err = warningsFor('{ "hooks": ', 'bad.json');
  assert.match(err, /warning: .*bad\.json is not valid JSON \(/);
  assert.match(err, /NOT active/);
  assert.equal(err.trim().split('\n').length, 1, 'one warning');
});

test('a config file holding an array is refused with a warning', () => {
  assert.match(warningsFor('[1]', 'arr.json'), /must hold a JSON object/);
});

test('a missing config file is silent, and so is a good one', () => {
  assert.equal(warningsFor(null, 'absent.json'), '');
  assert.equal(warningsFor('{"warm": false}', 'ok.json'), '');
});

test('invalid hook entries are counted in a warning', () => {
  const err = warningsFor(JSON.stringify({ hooks: { pre: [{ match: '(', command: 'x' }, { command: '' }, { match: 'bash', command: 'true' }] } }), 'hooks.json');
  assert.match(err, /2 hook entries in .*hooks\.json ignored/);
});

test('preset files and keys with an invalid name are reported, not silently skipped', () => {
  const user = join(dir, 'prompts');
  mkdirSync(user);
  writeFileSync(join(user, 'Good_Name.md'), 'x');
  writeFileSync(join(user, 'fine.md'), 'y');
  const { presets, invalid } = loadPresets({ fromConfig: { 'Bad Key': 'z' }, userDir: user });
  assert.deepEqual(Object.keys(presets), ['fine']);
  assert.equal(invalid.length, 2);
  assert.ok(invalid.some((i) => i.includes('Good_Name.md')));
  assert.ok(invalid.some((i) => i.includes('Bad Key')));
});
