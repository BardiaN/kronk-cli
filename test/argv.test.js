import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { parseArgv, suggest, KNOWN } from '../src/argv.js';

const run = promisify(execFile);
const CLI = new URL('../src/index.js', import.meta.url).pathname;
const MODEL = 'stub/Other-Q4/AGENT';
// Nothing listens here. A usage error must not care.
const NO_SERVER = 'http://127.0.0.1:9/v1';

// ---- the parser on its own ---------------------------------------------

test('suggest: one more dash first, then nearest within two edits', () => {
  assert.equal(suggest('-auto'), '--auto');
  assert.equal(suggest('-yes'), '--yes');
  assert.equal(suggest('--mdoel'), '--model');
  assert.equal(suggest('-zzzz'), null, 'a wrong suggestion is worse than none');
  // One edit from both --model and --models; alphabetical order decides.
  assert.equal(suggest('--modell'), '--model');
});

test('the known-option list is the one the parser uses', () => {
  for (const name of KNOWN) {
    assert.equal(parseArgv([name, 'x', 'y']).words.includes(name), false,
      `${name} must be consumed as an option, not left as prompt text`);
  }
});

test('every row of the observed-behaviour table is now an error', () => {
  const rows = [
    ['-auto'],
    ['-auto', 'use gh cli to …'],
    ['-auto', 'use gh cli to …', '-yes'],
    ['-auto', 'use gh cli to …', '-y'],
  ];
  for (const row of rows) {
    const r = parseArgv(row);
    assert.match(r.error ?? '', /unknown option: -auto/, JSON.stringify(row));
    assert.match(r.error, /did you mean --auto\?/);
  }
  // The one spelling that was already right stays right.
  const ok = parseArgv(['-a', 'use gh cli to …', '-y']);
  assert.equal(ok.error, null);
  assert.deepEqual(ok.words, ['use gh cli to …']);
  assert.ok(ok.auto && ok.yes);
});

test('prose that starts with a dash is prompt text, not an option', () => {
  for (const text of ['- fix the dashes bug', '-y was what I typed, why did it fail', '-']) {
    const r = parseArgv([text]);
    assert.equal(r.error, null, text);
    assert.deepEqual(r.words, [text]);
  }
});

test('a bare word is left for whatever dispatch exists', () => {
  const r = parseArgv(['setup']);
  assert.equal(r.error, null);
  assert.deepEqual(r.words, ['setup']);
});

test('-- ends option parsing and is not part of the prompt', () => {
  const r = parseArgv(['--', '--explain', 'this']);
  assert.equal(r.error, null);
  assert.deepEqual(r.words, ['--explain', 'this']);
  // A second -- is ordinary text.
  assert.deepEqual(parseArgv(['--', '-a', '--', 'x']).words, ['-a', '--', 'x']);
});

test('an option that takes a value must get one', () => {
  assert.match(parseArgv(['--model']).error, /--model needs a value/);
  assert.match(parseArgv(['-m']).error, /-m needs a value/);
  assert.match(parseArgv(['--model', '--steps', '5', 'x']).error, /--model needs a value/);
  // The case no look-ahead patch on the old multi-pass helpers could catch:
  // --no-think used to be spliced out before --model ever looked at it.
  assert.match(parseArgv(['--model', '--no-think', 'x']).error, /--model needs a value/);
  assert.equal(parseArgv(['--model', 'foo', 'x']).model, 'foo');
});

test('--steps takes a non-negative integer or a keyword', () => {
  assert.equal(parseArgv(['--steps', '5']).steps, 5);
  assert.equal(parseArgv(['--steps', '0']).steps, Infinity, '0 still means unlimited');
  for (const word of ['off', 'none', 'inf', 'unlimited']) {
    assert.equal(parseArgv(['--steps', word]).steps, Infinity, word);
  }
  for (const bad of ['abc', '3.5']) {
    assert.match(parseArgv(['--steps', bad, 'x']).error, /non-negative integer.*unlimited/, bad);
  }
  // Deliberately the missing-value message, not an invalid-value one.
  assert.match(parseArgv(['--steps', '-1', 'x']).error, /--steps needs a value/);
});

test('--mcp is bare-or-list, never a missing value', () => {
  const bare = parseArgv(['--mcp', '-y', 'x']);
  assert.equal(bare.error, null);
  assert.ok(bare.mcp && bare.mcpNames === null && bare.yes);
  const list = parseArgv(['--mcp', 'nx,kronk', 'x']);
  assert.deepEqual(list.mcpNames, ['nx', 'kronk']);
  assert.deepEqual(list.words, ['x']);
});

// ---- the README table is the contract ----------------------------------

const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

/** The first column of the options table, one backticked spelling per entry. */
function documented() {
  const lines = README.split('\n');
  const head = lines.findIndex((l) => l.startsWith('| Flag | Default |'));
  assert.notEqual(head, -1, 'the options table moved');
  const out = [];
  for (const line of lines.slice(head + 2)) {
    if (!line.startsWith('|')) break;
    for (const m of line.split('|')[1].matchAll(/`([^`]+)`/g)) out.push(m[1].trim());
  }
  return out;
}

test('every documented spelling still parses', () => {
  const entries = documented();
  assert.ok(entries.length > 10, `only found ${entries.length} documented flags`);
  assert.ok(entries.includes('--'), 'the terminator must be documented');

  for (const entry of entries) {
    // -- is a terminator, not an invocable flag: it has its own test.
    if (entry === '--') continue;
    const [name, placeholder] = entry.split(/\s+/);
    assert.ok(KNOWN.includes(name), `${name} is documented but unknown to the parser`);
    const value = placeholder?.startsWith('<') ? [name === '--steps' ? '5' : 'anything'] : [];
    const r = parseArgv([name, ...value, 'a prompt']);
    assert.equal(r.error, null, `${entry}: ${r.error}`);
  }
});

// ---- the CLI as a subprocess -------------------------------------------

/** Records every request, so a test can prove Kronk was never contacted. */
function startStub() {
  const hits = [];
  const chat = [];
  const send = (res, code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const server = createServer((req, res) => {
    const url = req.url.split('?')[0];
    hits.push(url);
    if (url === '/v1/models') return send(res, 200, { data: [{ id: MODEL, object: 'model' }] });
    if (url === '/v1/kronk/models/ps') return send(res, 200, []);
    if (url.startsWith('/v1/kronk/models')) {
      return send(res, 200, { model_config: { 'context-window': 4096 }, metadata: {}, data: [] });
    }
    if (url === '/v1/chat/completions') {
      let raw = '';
      req.on('data', (d) => { raw += d; });
      return req.on('end', () => {
        chat.push(JSON.parse(raw));
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const chunk = (delta, finish = null) => JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] });
        res.write(`data: ${chunk({ role: 'assistant', content: 'STUB_OK' })}\n`);
        res.write(`data: ${chunk({}, 'stop')}\n`);
        res.write('data: [DONE]\n');
        res.end();
      });
    }
    return send(res, 404, { error: { message: `stub has no route for ${url}` } });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}/v1`,
      hits,
      chat,
      prompt: () => chat.at(-1).messages.find((m) => m.role === 'user').content,
      close: () => { server.closeAllConnections(); server.close(); },
    }));
  });
}

/**
 * Run the CLI with a throwaway HOME so ~/.kronk-cli.json cannot interfere, and
 * report the exit code instead of throwing: a usage error IS the result here.
 */
async function cli(args, { url = NO_SERVER, stdin = '' } = {}) {
  const env = {
    ...process.env,
    KRONK_URL: url,
    HOME: mkdtempSync(join(tmpdir(), 'kronk-home-')),
    NO_COLOR: '1',
  };
  delete env.KRONK_MODEL;
  delete env.KRONK_WARM;
  const p = run(process.execPath, [CLI, '--no-context', '--no-warm', ...args], { env, timeout: 30_000 });
  p.child.stdin.end(stdin);
  try { return { code: 0, ...(await p) }; }
  catch (e) { return { code: e.code, stdout: e.stdout, stderr: e.stderr }; }
}

test('an unknown option exits 2 without saying anything on stdout or the wire', async () => {
  const stub = await startStub();
  const r = await cli(['-auto', 'x'], { url: stub.url });
  stub.close();

  assert.equal(r.code, 2);
  assert.equal(r.stdout, '', 'usage errors belong on stderr');
  assert.match(r.stderr, /unknown option: -auto/);
  assert.match(r.stderr, /did you mean --auto\?/);
  assert.match(r.stderr, /kronk-cli --help for the full list/);
  assert.deepEqual(stub.hits, [], 'nothing may reach Kronk');
});

test('the remaining misspellings from the report fail loudly too', async () => {
  const yes = await cli(['-yes', 'x']);
  assert.equal(yes.code, 2);
  assert.match(yes.stderr, /unknown option: -yes/);
  assert.match(yes.stderr, /did you mean --yes\?/);

  const model = await cli(['--mdoel', 'foo', 'x']);
  assert.equal(model.code, 2);
  assert.match(model.stderr, /did you mean --model\?/);

  const wild = await cli(['-zzzz', 'x']);
  assert.equal(wild.code, 2);
  assert.match(wild.stderr, /unknown option: -zzzz/);
  assert.doesNotMatch(wild.stderr, /did you mean/, 'no candidate, no guess');
  assert.match(wild.stderr, /kronk-cli --help for the full list/);
});

test('missing and invalid option values exit 2', async () => {
  for (const [args, expected] of [
    [['--model'], /--model needs a value/],
    [['--model', '--steps', '5', 'x'], /--model needs a value/],
    [['--model', '--no-think', 'x'], /--model needs a value/],
    [['--steps', 'abc', 'x'], /non-negative integer/],
    [['--steps', '-1', 'x'], /--steps needs a value/],
  ]) {
    const r = await cli(args);
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.stderr, expected, args.join(' '));
    assert.equal(r.stdout, '', args.join(' '));
  }
});

test('--help exits 0 and documents the terminator', async () => {
  const r = await cli(['--help']);
  assert.equal(r.code, 0);
  const options = r.stdout.split('OPTIONS')[1].split('ENVIRONMENT')[0];
  assert.match(options, /^ {8}--\s{2,}end option parsing/m);
});

test('-- sends the rest to the model verbatim, minus the -- itself', async () => {
  const stub = await startStub();
  const r = await cli(['--', '--explain', 'this'], { url: stub.url });
  stub.close();
  assert.equal(r.code, 0);
  assert.equal(stub.prompt(), '--explain this');
});

test('prose and ordinary prompts are unaffected, piped stdin included', async () => {
  const prose = await startStub();
  const a = await cli(['- fix the dashes bug'], { url: prose.url });
  prose.close();
  assert.equal(a.code, 0);
  assert.equal(prose.prompt(), '- fix the dashes bug');

  const piped = await startStub();
  const b = await cli(['a normal prompt'], { url: piped.url, stdin: 'extra context' });
  piped.close();
  assert.equal(b.code, 0);
  assert.equal(piped.prompt(), 'a normal prompt\n\nextra context');

  const only = await startStub();
  const c = await cli([], { url: only.url, stdin: 'hi' });
  only.close();
  assert.equal(c.code, 0);
  assert.equal(only.prompt(), 'hi');
});
