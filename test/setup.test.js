import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { DEFAULT_MODEL } from '../src/config.js';

const run = promisify(execFile);
const CLI = new URL('../src/index.js', import.meta.url).pathname;

const BASE = 'unsloth/Qwen3.6-35B-A3B-UD-Q4_K_M';
/** Nothing listens here. */
const NO_SERVER = 'http://127.0.0.1:9/v1';

/** The block setup writes for the default model, as it must appear on disk. */
const ENTRY = [
  `  ${DEFAULT_MODEL}:`,
  '    context-window: 131072',
  '    nseq-max: 2',
  '    chat-template-kwargs:',
  '      preserve_thinking: true',
  '    sampling-parameters:',
  '      max_tokens: 16384',
];

/**
 * A stand-in for the `kronk` binary. It records the argv of every invocation,
 * so a test can prove what setup spawned — and, for --dry-run, that it spawned
 * nothing at all. `catalog show` is the only call whose output is parsed.
 */
const STUB = `#!/bin/sh
printf '%s\\n' "$*" >> "$KRONK_STUB_LOG"
if [ "$1 $2" = "catalog show" ]; then
  echo "Total Size:     21.45 GB"
  echo "Downloaded:     $KRONK_STUB_DOWNLOADED"
fi
exit \${KRONK_STUB_EXIT:-0}
`;

/** Minimal Kronk: enough for the server check and the post-restart poll. */
function startStub() {
  const server = createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: [{ id: BASE, object: 'model' }] }));
    }
    // Everything else 404s: modelLimits treats that as "native maximum unknown".
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `no route for ${url}` } }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}/v1`,
      close: () => { server.closeAllConnections(); server.close(); },
    }));
  });
}

/**
 * A throwaway world: its own HOME, its own model_config.yaml, and a PATH that
 * contains nothing but the stub. The real ~/.kronk and the real kronk binary
 * are unreachable from here by construction.
 */
function world({ yaml, downloaded = 'true', kronk = true, models = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kronk-setup-'));
  const home = join(dir, 'home');
  const bin = join(dir, 'bin');
  const modelsDir = join(dir, 'models');
  mkdirSync(home);
  mkdirSync(bin);
  if (models) mkdirSync(modelsDir);
  if (kronk) writeFileSync(join(bin, 'kronk'), STUB, { mode: 0o755 });

  const cfg = join(modelsDir, 'model_config.yaml');
  if (yaml !== undefined) writeFileSync(cfg, yaml);
  const log = join(dir, 'argv.log');

  return {
    dir, cfg, log,
    env: {
      PATH: bin,
      HOME: home,
      NO_COLOR: '1',
      KRONK_MODEL_CONFIG: cfg,
      KRONK_STUB_LOG: log,
      KRONK_STUB_DOWNLOADED: downloaded,
    },
    read: () => readFileSync(cfg, 'utf8'),
    /** The argv of every kronk invocation, one line each. */
    spawned: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []),
    backups: () => [1, 2, 3].map((n) => `${cfg}.bak${n === 1 ? '' : n}`).filter(existsSync),
  };
}

/** Run the CLI as a subprocess and report the exit code rather than throwing. */
async function cli(args, w, url, stdin = '') {
  const p = run(process.execPath, [CLI, ...args], {
    env: { ...w.env, KRONK_URL: url },
    timeout: 30_000,
  });
  p.child.stdin.end(stdin);
  try { return { code: 0, ...(await p) }; }
  catch (e) { return { code: e.code, stdout: e.stdout, stderr: e.stderr }; }
}

/** startStub + cli + close, since every test but the first wants exactly that. */
async function setup(args, w, stdin = '') {
  const stub = await startStub();
  try { return await cli(['setup', ...args], w, stub.url, stdin); }
  finally { stub.close(); }
}

// ---- 1. the server -------------------------------------------------------

test('setup with no server exits non-zero on the shared "Cannot reach" copy', async () => {
  const w = world();
  const r = await cli(['setup', '-y'], w, NO_SERVER);

  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /Cannot reach Kronk at/);
  assert.match(r.stderr, /kronk server start --detach/);
  assert.deepEqual(w.spawned(), [], 'the binary is not touched before the server answers');
});

// ---- 2. nothing to do ----------------------------------------------------

test('an already-downloaded model with its profile in place changes nothing', async () => {
  const yaml = `version: 1\n\nmodels:\n${ENTRY.join('\n')}\n`;
  const w = world({ yaml });
  const r = await setup(['-y'], w);

  assert.equal(r.code, 0);
  assert.equal(w.read(), yaml, 'the file must not be rewritten');
  assert.deepEqual(w.backups(), [], 'no write, no backup');
  assert.match(r.stdout, /already downloaded/);
  assert.match(r.stdout, /already a profile/);
  assert.deepEqual(w.spawned(), [`catalog show ${BASE} --local`],
    'the presence check is the only thing that runs');
});

// ---- 3. the insertion ----------------------------------------------------

const ORIGINAL = `version: 1

# a comment that must survive
kms: {}

models:
  # chat profile
  other/Model-Q8:
    context-window: 32768

trailing: true
`;

const EXPECTED = `version: 1

# a comment that must survive
kms: {}

models:
${ENTRY.join('\n')}

  # chat profile
  other/Model-Q8:
    context-window: 32768

trailing: true
`;

test('the entry is inserted under the one models: key and nothing else moves', async () => {
  const w = world({ yaml: ORIGINAL, downloaded: 'false' });
  const r = await setup(['-y'], w);

  assert.equal(r.code, 0, r.stderr);
  assert.equal(w.read(), EXPECTED);
  assert.deepEqual(w.backups(), [`${w.cfg}.bak`]);
  assert.equal(readFileSync(`${w.cfg}.bak`, 'utf8'), ORIGINAL, 'the backup is the file as it was');

  assert.deepEqual(w.spawned(), [
    `catalog show ${BASE} --local`,
    `model pull ${BASE}`,
    'server stop',
    'server start --detach',
  ]);
  assert.match(r.stdout, /server is back/);
});

test('an existing backup is never overwritten', async () => {
  const w = world({ yaml: ORIGINAL });
  writeFileSync(`${w.cfg}.bak`, 'an older backup someone still wants\n');
  const r = await setup(['-y'], w);

  assert.equal(r.code, 0, r.stderr);
  assert.equal(readFileSync(`${w.cfg}.bak`, 'utf8'), 'an older backup someone still wants\n');
  assert.equal(readFileSync(`${w.cfg}.bak2`, 'utf8'), ORIGINAL);
  assert.match(r.stdout, /model_config\.yaml\.bak2/);
});

// ---- 4. no file ----------------------------------------------------------

test('a missing model_config.yaml is created with version, models and the entry', async () => {
  const w = world();
  const r = await setup(['-y'], w);

  assert.equal(r.code, 0, r.stderr);
  assert.equal(w.read(), `version: 1\n\nmodels:\n${ENTRY.join('\n')}\n`);
  assert.deepEqual(w.backups(), [], 'there was nothing to back up');
});

test('a missing ~/.kronk/models directory stops setup instead of creating one', async () => {
  const w = world({ models: false });
  const r = await setup(['-y'], w);

  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /Kronk has never run here/);
  assert.equal(existsSync(w.cfg), false);
});

// ---- 5. no models: key ---------------------------------------------------

test('a file with no models: key gets the key and the entry appended', async () => {
  const w = world({ yaml: 'version: 1\nkms: {}\n' });
  const r = await setup(['-y'], w);

  assert.equal(r.code, 0, r.stderr);
  assert.equal(w.read(), `version: 1\nkms: {}\n\nmodels:\n${ENTRY.join('\n')}\n`);
  assert.equal(w.read().match(/^models:/gm).length, 1, 'exactly one models: key');
});

// ---- 6. two models: keys -------------------------------------------------

test('two top-level models: keys are refused, and the file is left alone', async () => {
  const yaml = `version: 1
models:
  a/b:
    context-window: 4096
version: 1
models:
  c/d:
    context-window: 4096
`;
  const w = world({ yaml });
  const r = await setup(['-y'], w);

  assert.notEqual(r.code, 0);
  assert.equal(w.read(), yaml, 'not one byte may change');
  assert.deepEqual(w.backups(), []);
  assert.match(r.stderr, new RegExp(`Refusing to edit ${w.cfg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(r.stderr, /2 top-level "models:" keys/);
  // The block is still printed so the user can paste it into the right section.
  assert.match(r.stdout + r.stderr, /preserve_thinking: true/);
});

// ---- 7. dry run ----------------------------------------------------------

test('--dry-run writes nothing, spawns nothing, and exits 0', async () => {
  const w = world({ yaml: ORIGINAL });
  const r = await setup(['--dry-run'], w);

  assert.equal(r.code, 0, r.stderr);
  assert.equal(w.read(), ORIGINAL);
  assert.deepEqual(w.backups(), []);
  assert.deepEqual(w.spawned(), [], 'a dry run starts no subprocess');
  assert.match(r.stdout, /would run: kronk model pull/);
  assert.match(r.stdout, /would run: kronk server start --detach/);
  assert.match(r.stdout, /nothing was written/);

  // It must not conjure a file either.
  const fresh = world();
  const second = await setup(['--dry-run'], fresh);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(existsSync(fresh.cfg), false);
});

// ---- declining ------------------------------------------------------------

test('declining the pull is not an error — it prints the command and exits 0', async () => {
  const w = world({ yaml: ORIGINAL, downloaded: 'false' });
  const r = await setup([], w, 'n\n');

  assert.equal(r.code, 0);
  assert.equal(w.read(), ORIGINAL, 'declining stops before the file is touched');
  assert.deepEqual(w.spawned(), [`catalog show ${BASE} --local`], 'no pull was started');
  assert.match(r.stdout, new RegExp(`kronk model pull ${BASE}`));
});

test('the file write is a confirmation of its own, and declining it writes nothing', async () => {
  const w = world({ yaml: ORIGINAL });
  const r = await setup([], w, 'n\n');

  assert.equal(r.code, 0);
  assert.equal(w.read(), ORIGINAL);
  assert.deepEqual(w.backups(), []);
  assert.match(r.stdout, /Nothing was written/);
  assert.ok(!w.spawned().includes('server stop'), 'and certainly no restart');
});

test('an input that has already ended declines instead of hanging or exiting quietly', async () => {
  const w = world({ yaml: ORIGINAL });
  // Two questions, no stdin at all: the write, then — had it got that far — the
  // restart. Nothing may be written, and the walk must say why it stopped.
  const r = await setup([], w, '');

  assert.equal(r.code, 0);
  assert.equal(w.read(), ORIGINAL);
  assert.deepEqual(w.backups(), []);
  assert.match(r.stdout, /Nothing was written/);
});

// ---- 8. idempotence ------------------------------------------------------

test('a second run in a row changes nothing and exits 0', async () => {
  const w = world({ yaml: ORIGINAL });
  const first = await setup(['-y'], w);
  assert.equal(first.code, 0, first.stderr);
  const after = w.read();

  const second = await setup(['-y'], w);
  assert.equal(second.code, 0, second.stderr);
  assert.equal(w.read(), after, 'the second run is a no-op');
  assert.deepEqual(w.backups(), [`${w.cfg}.bak`], 'and takes no second backup');
  assert.match(second.stdout, /already a profile/);
});

// ---- 9. --model ----------------------------------------------------------

test('--model writes the overridden id and pulls its base', async () => {
  const w = world({ yaml: ORIGINAL, downloaded: 'false' });
  const r = await setup(['-y', '--model', 'unsloth/Qwen3-0.6B-Q8_0/AGENT'], w);

  assert.equal(r.code, 0, r.stderr);
  assert.match(w.read(), /^ {2}unsloth\/Qwen3-0\.6B-Q8_0\/AGENT:$/m);
  assert.doesNotMatch(w.read(), new RegExp(`^ {2}${DEFAULT_MODEL}:$`, 'm'));
  assert.ok(w.spawned().includes('model pull unsloth/Qwen3-0.6B-Q8_0'),
    'the profile suffix is stripped for the catalog id');
});

test('--context overrides the window that is written', async () => {
  const w = world();
  const r = await setup(['-y', '--context', '65536'], w);

  assert.equal(r.code, 0, r.stderr);
  assert.match(w.read(), /^ {4}context-window: 65536$/m);
});

// ---- 10. no kronk on PATH ------------------------------------------------

test('a missing kronk binary is explained, not thrown, and nothing is written', async () => {
  const w = world({ yaml: ORIGINAL, kronk: false });
  const r = await setup(['-y'], w);

  assert.notEqual(r.code, 0);
  assert.equal(w.read(), ORIGINAL);
  assert.match(r.stderr, /No `kronk` binary on PATH/);
  assert.match(r.stderr, new RegExp(`kronk model pull ${BASE}`));
  assert.match(r.stderr, /kronk server start --detach/);
  assert.match(r.stderr, /preserve_thinking: true/, 'the block is printed to paste by hand');
});

// ---- 11. models: with no children ----------------------------------------

test('a childless models: key adopts the entry as its first child', async () => {
  const w = world({ yaml: 'version: 1\n\nmodels:\n' });
  const r = await setup(['-y'], w);

  assert.equal(r.code, 0, r.stderr);
  assert.equal(w.read(), `version: 1\n\nmodels:\n${ENTRY.join('\n')}\n`);
  assert.equal(w.read().match(/^models:/gm).length, 1, 'no second models: key');
});

// ---- line endings --------------------------------------------------------

test('a CRLF file keeps CRLF, on the old lines and the new ones alike', async () => {
  const crlf = 'version: 1\r\n\r\nmodels:\r\n  a/b:\r\n    context-window: 4096\r\n';
  const w = world({ yaml: crlf });
  const r = await setup(['-y'], w);

  assert.equal(r.code, 0, r.stderr);
  assert.equal(w.read(),
    `version: 1\r\n\r\nmodels:\r\n${ENTRY.join('\r\n')}\r\n\r\n  a/b:\r\n    context-window: 4096\r\n`);
  assert.equal(w.read().includes('\n\n'), false, 'no bare LF may be introduced');
});

// ---- dispatch ------------------------------------------------------------

test('setup is dispatched as a subcommand, never sent to the model as a prompt', async () => {
  const w = world();
  const r = await cli(['setup', 'extra'], w, NO_SERVER);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /setup takes no arguments/);
});
