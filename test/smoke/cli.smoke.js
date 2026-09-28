import { before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { setup, run, repl } from './harness.js';

/**
 * The smoke suite: the real CLI, as a real process, against a real Kronk
 * server and a real model. Nothing here is stubbed, which is the entire point
 * — `npm test` already proves the pieces in isolation, and everything this
 * catches is something that only goes wrong once a model, a terminal or a
 * second process is involved.
 *
 * Never run in CI. See `setup()` in harness.js for the two independent things
 * that stop that happening, and test/smoke/README.md for how to run it.
 *
 * Two rules for anyone adding a check here:
 *
 * - **Nothing machine-specific.** No model ids, no paths under a home
 *   directory, no MCP server names. What the suite needs, it discovers from
 *   the server at run time (`ctx.model`, `ctx.lightModel`) or reads out of a
 *   file in the repository. That is what lets this sit in git.
 * - **A failure has to be diagnosable without rerunning**, because a rerun
 *   costs minutes of model time. Put the actual output in the assertion
 *   message, not just the expectation.
 */

const ctx = {};

// One cold ~20 GB model load, possibly preceded by starting the server, all of
// which happens before the first check can mean anything.
before(async () => { Object.assign(ctx, await setup()); }, { timeout: 600_000 });

/**
 * The first line of every check.
 *
 * `setup()` decides whether this machine can run the suite at all, and it
 * cannot report that as a skip itself — node:test fixes a test's options when
 * it is registered, which is before any hook has run. So the decision is
 * carried on `ctx` and each check turns it into its own skip, which is also
 * what makes the reason appear once per check rather than buried in a hook.
 */
function ready(t) {
  if (ctx.skip) { t.skip(ctx.reason); return false; }
  return true;
}

/** Same, for the checks that are only meaningful with a second model to move work onto. */
function readyWithLight(t) {
  if (!ready(t)) return false;
  if (!ctx.hasLightModel) {
    t.skip('only one chat model is served, so there is no second model to delegate onto');
    return false;
  }
  return true;
}

const REPO = new URL('../../', import.meta.url).pathname;
const pkgVersion = () => JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version;
const temp = (prefix) => mkdtempSync(join(tmpdir(), prefix));

/** Show the output when an assertion about it fails; a rerun costs minutes. */
const shows = (out, needle) => `expected ${JSON.stringify(needle)} in:\n${out}`;

describe('argv and the paths that must not reach a model at all', () => {
  test('--help exits 0 and prints usage', async (t) => {
    if (!ready(t)) return;
    const { code, stdout } = await run(['--help']);
    assert.equal(code, 0);
    assert.ok(stdout.includes('USAGE'), shows(stdout, 'USAGE'));
  });

  test('an unknown option is a usage error, not a prompt', async (t) => {
    if (!ready(t)) return;
    const { code, stderr } = await run(['--frobnicate']);
    assert.equal(code, 2, `exit was ${code}; stderr:\n${stderr}`);
    assert.ok(stderr.includes('unknown option'), shows(stderr, 'unknown option'));
  });

  test('a single-dash typo suggests the real flag', async (t) => {
    if (!ready(t)) return;
    const { stderr } = await run(['-auto']);
    assert.ok(stderr.includes('did you mean --auto'), shows(stderr, 'did you mean --auto'));
  });

  test('--steps refuses a value that is not a number', async (t) => {
    if (!ready(t)) return;
    const { code, stderr } = await run(['--steps', 'banana']);
    assert.equal(code, 2, `exit was ${code}`);
    assert.ok(stderr.includes('non-negative integer'), shows(stderr, 'non-negative integer'));
  });

  test('an option that needs a value says so', async (t) => {
    if (!ready(t)) return;
    const { code, stderr } = await run(['--model']);
    assert.equal(code, 2, `exit was ${code}`);
    assert.ok(stderr.includes('needs a value'), shows(stderr, 'needs a value'));
  });

  test('setup takes no arguments', async (t) => {
    if (!ready(t)) return;
    const { code } = await run(['setup', 'extra', 'args']);
    assert.equal(code, 2, `exit was ${code}`);
  });

  test('with no server it fails cleanly and says how to start one', async (t) => {
    if (!ready(t)) return;
    // Port 9 is the discard port: reliably nothing listening, on any machine.
    const { code, stderr } = await run([], {
      env: { KRONK_URL: 'http://127.0.0.1:9/v1' }, stdin: 'hi\n', timeout: 60_000,
    });
    assert.equal(code, 1, `exit was ${code}; stderr:\n${stderr}`);
    assert.ok(stderr.includes('Cannot reach Kronk'), shows(stderr, 'Cannot reach Kronk'));
    assert.ok(stderr.includes('kronk server start'), shows(stderr, 'kronk server start'));
  });
});

describe('what it says about the server it found', () => {
  test('--models lists the model this run picked, and what is resident', async (t) => {
    if (!ready(t)) return;
    const { code, stdout } = await run(['--models']);
    assert.equal(code, 0);
    assert.ok(stdout.includes(ctx.model), shows(stdout, ctx.model));
    assert.ok(stdout.includes('resident:'), shows(stdout, 'resident:'));
  });

  test('--mcp-list reports whatever is configured without failing', async (t) => {
    if (!ready(t)) return;
    // Deliberately not asserting *what* is configured, or how much: the answer
    // is read from the operator's own ~/.claude.json and friends, so both "four
    // servers" and "none at all" are correct here and neither belongs in git.
    const { code, stdout } = await run(['--mcp-list'], { timeout: 180_000 });
    assert.equal(code, 0, `exit was ${code}`);
    const answered = stdout.includes('No MCP servers configured') || stdout.includes('configured');
    assert.ok(answered, shows(stdout, 'either "No MCP servers configured" or "…configured"'));
  });

  test('setup --dry-run inspects without changing anything', async (t) => {
    if (!ready(t)) return;
    const { code, stderr } = await run(['setup', '--dry-run', '-y'], { timeout: 180_000 });
    assert.equal(code, 0, `exit was ${code}; stderr:\n${stderr}`);
  });
});

describe('a real turn with a real model', () => {
  test('a one-shot prompt gets an answer', async (t) => {
    if (!ready(t)) return;
    const { code, stdout } = await run([
      '--no-context', '--no-warm', '-y', '--steps', '2',
      'Reply with exactly the word PONG and nothing else.',
    ], { timeout: 300_000 });
    assert.equal(code, 0, `exit was ${code}`);
    assert.ok(stdout.toUpperCase().includes('PONG'), shows(stdout, 'PONG'));
  });

  test('piped stdin arrives as extra context', async (t) => {
    if (!ready(t)) return;
    const { stdout } = await run([
      '--no-context', '--no-warm', '-y', '--steps', '2',
      'The text below is a secret word. Reply with only that word.',
    ], { stdin: 'BANANAPHONE\n', timeout: 300_000 });
    assert.ok(stdout.toUpperCase().includes('BANANAPHONE'), shows(stdout, 'BANANAPHONE'));
  });

  test('the model really calls read_file, and quotes what is in it', async (t) => {
    if (!ready(t)) return;
    // The expected string is read from the file rather than written down, so
    // this check cannot drift when NOTICE changes and does not encode a guess
    // about what the first line says.
    const first = readFileSync(join(REPO, 'NOTICE'), 'utf8').split('\n')[0].trim();
    const { stdout } = await run([
      '--no-context', '--no-warm', '-y', '--steps', '4',
      'Use read_file to read NOTICE and quote its first line exactly.',
    ], { timeout: 300_000 });
    assert.ok(stdout.includes('read NOTICE'), shows(stdout, 'a read_file call on NOTICE'));
    assert.ok(stdout.includes(first), shows(stdout, first));
  });

  test('without --yes a write is refused, and nothing is written', async (t) => {
    if (!ready(t)) return;
    // The most valuable check in the suite: the approval prompt is the whole
    // boundary between "an agent that edits your code" and "an agent that
    // edits your code without asking". Into a temp dir, never the repository.
    const target = join(temp('kronk-smoke-approval-'), 'MUST_NOT_EXIST.txt');
    const { stdout } = await run([
      '--no-context', '--no-warm', '--steps', '3',
      `Use write_file to create ${target} containing hi.`,
    ], { timeout: 300_000 });
    assert.ok(!existsSync(target), `the file was created despite no --yes: ${target}`);
    const refused = stdout.includes('needs approval') || stdout.toLowerCase().includes('denied');
    assert.ok(refused, shows(stdout, 'a refusal'));
  });
});

describe('the interactive REPL, over a real pty', () => {
  test('the banner and the slash commands all answer', async (t) => {
    if (!ready(t)) return;
    const out = await repl(['/help', '/context', '/theme light', '/thinking', '/models', '/exit'],
      { args: ['--no-context', '--no-warm'] });
    for (const needle of ['██ kronk-cli', 'sandbox', '/model <id>', 'window:', 'light palette', ctx.model, 'bye']) {
      assert.ok(out.includes(needle), shows(out, needle));
    }
  });

  test('/model switches model and re-reads its limits', async (t) => {
    if (!ready(t)) return;
    // The light model when there is one, so the switch is a real change; the
    // orchestrator itself otherwise, which still exercises the same path.
    const to = ctx.lightModel ?? ctx.model;
    const out = await repl([`/model ${to}`, '/context', '/exit'],
      { args: ['--no-context', '--no-warm'], after: 3 });
    assert.ok(out.includes(`switched to ${to}`), shows(out, `switched to ${to}`));
    assert.ok(out.includes('window'), shows(out, 'window'));
  });

  test('/agents describes the roles a task can be given', async (t) => {
    if (!ready(t)) return;
    const out = await repl(['/agents', '/exit'], { args: ['--no-context', '--no-warm'] });
    for (const needle of ['explore', 'code', 'model:']) {
      assert.ok(out.includes(needle), shows(out, needle));
    }
  });
});

describe('the version it reports, and whether a newer one exists', () => {
  test('--version and -v print the real version', async (t) => {
    if (!ready(t)) return;
    const expected = `kronk-cli ${pkgVersion()}`;
    for (const flag of ['--version', '-v']) {
      const { code, stdout } = await run([flag]);
      assert.equal(code, 0, `${flag} exited ${code}`);
      assert.ok(stdout.split('\n').map((l) => l.trim()).includes(expected), shows(stdout, expected));
    }
  });

  test('--version still works with no kronk binary on PATH', async (t) => {
    if (!ready(t)) return;
    // The common case for asking is a machine where nothing is running yet.
    // `node` itself has to stay reachable, so its own directory is the PATH.
    const { code, stdout } = await run(['--version'], {
      env: { PATH: dirname(process.execPath) },
    });
    assert.equal(code, 0, `exit was ${code}`);
    assert.ok(stdout.includes(`kronk-cli ${pkgVersion()}`), shows(stdout, 'the kronk-cli line'));
    assert.ok(!stdout.includes('kronk    '), `it claimed a server version with no binary:\n${stdout}`);
  });

  test('the MCP handshake announces the real version, not a literal', async (t) => {
    if (!ready(t)) return;
    // The literal '0.1.0' still appears in src/mcp.js, inside the comment
    // explaining the six releases that carried it, so grepping the source for
    // that string would report a bug that is no longer there. What actually
    // matters is what this program puts on the wire, so a throwaway MCP
    // server is spun up for real, `McpHub` connects to it the same way it
    // would connect to anything in ~/.claude.json, and the check reads back
    // the `clientInfo.version` this process actually sent during that
    // handshake — behaviour, not text in a file.
    const { McpHub } = await import('../../src/mcp.js');
    const dir = temp('kronk-smoke-mcp-');
    const seenFile = join(dir, 'seen-version.txt');
    const stub = join(dir, 'stub.mjs');
    writeFileSync(stub, [
      "import { writeFileSync } from 'node:fs';",
      "let buf = '';",
      'process.stdin.on(\'data\', (d) => {',
      "  buf += d.toString();",
      "  const lines = buf.split('\\n');",
      '  buf = lines.pop();',
      '  for (const line of lines) {',
      "    if (!line.trim()) continue;",
      '    const msg = JSON.parse(line);',
      "    if (msg.method === 'initialize') {",
      '      writeFileSync(process.env.SMOKE_MCP_SEEN, msg.params?.clientInfo?.version ?? \'\');',
      '      process.stdout.write(JSON.stringify({ jsonrpc: \'2.0\', id: msg.id, result: {',
      '        protocolVersion: msg.params.protocolVersion, capabilities: {}, serverInfo: { name: \'smoke-stub\', version: \'0\' },',
      '      } }) + \'\\n\');',
      "    } else if (msg.method === 'tools/list') {",
      '      process.stdout.write(JSON.stringify({ jsonrpc: \'2.0\', id: msg.id, result: { tools: [] } }) + \'\\n\');',
      '    }',
      '  }',
      '});',
    ].join('\n'), 'utf8');

    const hub = new McpHub();
    try {
      await hub.connect({
        smoke: { command: process.execPath, args: [stub], env: { SMOKE_MCP_SEEN: seenFile } },
      });
      assert.deepEqual(hub.failures, [], `the stub MCP server failed to start: ${JSON.stringify(hub.failures)}`);
      const seen = readFileSync(seenFile, 'utf8');
      assert.equal(seen, pkgVersion(), `clientInfo.version was ${JSON.stringify(seen)}`);
    } finally {
      hub.close();
    }
  });

  test('a fresh cache renders the update row; the off switch removes it', async (t) => {
    if (!ready(t)) return;
    const cache = join(temp('kronk-smoke-update-'), 'update.json');
    const current = pkgVersion();
    writeFileSync(cache, JSON.stringify({
      checkedAt: Date.now(),
      cli: { current, latest: '99.99.99', hint: 'git pull' },
    }));

    const shown = await repl(['/exit'], {
      args: ['--no-context', '--no-warm'], env: { KRONK_UPDATE_CACHE: cache },
    });
    const row = `update  kronk-cli ${current} → 99.99.99 · run: git pull`;
    assert.ok(shown.includes(row), shows(shown, row));

    const off = await repl(['/exit'], {
      args: ['--no-context', '--no-warm'],
      env: { KRONK_UPDATE_CACHE: cache, KRONK_UPDATE_CHECK: 'false' },
    });
    assert.ok(!off.includes('update  kronk-cli'), `the off switch still rendered a row:\n${off}`);
  });
});

describe('a delegated task choosing the model it runs on', () => {
  test('the orchestrator routes a task onto the other model', async (t) => {
    if (!readyWithLight(t)) return;
    const taskLog = temp('kronk-smoke-tasklog-');
    const { stdout } = await run([
      '--no-context', '--no-warm', '-y', '--steps', '6',
      'Use the task tool to delegate this to a sub-agent, and run that sub-agent on the '
      + `model whose id contains "${ctx.lightModel}" rather than on your own model: `
      + 'report the word OK. Do not answer it yourself.',
    ], { env: { KRONK_TASK_LOG_DIR: taskLog, KRONK_SUBAGENT_STEPS: '3' }, timeout: 420_000 });

    assert.ok(stdout.includes('task'), shows(stdout, 'a task tool call'));
    assert.ok(stdout.includes(ctx.lightModel),
      shows(stdout, `${ctx.lightModel} on the sub-agent's opening line`));

    // And the record, which is what `/tasks` reads afterwards to account for a
    // delegation that took a minute longer than the rest.
    const records = readdirSync(taskLog, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .flatMap((d) => readdirSync(join(taskLog, d.name))
        .filter((f) => /^task-\d+\.json$/.test(f))
        .map((f) => JSON.parse(readFileSync(join(taskLog, d.name, f), 'utf8'))));
    const models = records.map((r) => r.model);
    assert.ok(models.includes(ctx.lightModel),
      `no run recorded against ${ctx.lightModel}; recorded: ${JSON.stringify(models)}`);
  });
});

describe('the rescue job queue', () => {
  /** A store per run, under the temp dir, so the suite never touches the real one. */
  let store;
  let env;
  before(() => {
    store = temp('kronk-smoke-rescue-');
    env = { KRONK_RESCUE_DIR: store };
  });

  test('submit returns at once and the job finishes in its own process', async (t) => {
    if (!ready(t)) return;
    const started = Date.now();
    const submitted = await run(['rescue', 'Reply with only the word READY.', '--role', 'explore', '--steps', '2'],
      { env, timeout: 60_000 });
    const elapsed = Date.now() - started;
    assert.equal(submitted.code, 0, `submit exited ${submitted.code}; stderr:\n${submitted.stderr}`);
    const id = submitted.stdout.trim();
    assert.ok(id, 'submit printed no job id');
    assert.ok(elapsed < 10_000,
      `submit took ${elapsed}ms, so it waited for the run instead of detaching`);

    const status = await run(['rescue', 'status', id], { env });
    assert.equal(status.code, 0, `status exited ${status.code}`);
    assert.match(status.stdout.trim(), /^(queued|running|done)/,
      `unexpected state: ${status.stdout.trim()}`);

    const waited = await run(['rescue', 'wait', id], { env, timeout: 420_000 });
    assert.equal(waited.code, 0, `wait exited ${waited.code} (0 means done); stdout:\n${waited.stdout}`);
    assert.ok(waited.stdout.toUpperCase().includes('READY'), shows(waited.stdout, 'READY'));

    const result = await run(['rescue', 'result', id, '--json'], { env });
    const record = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(record).sort(),
      ['id', 'model', 'ms', 'report', 'role', 'state', 'steps', 'transcript'],
      `unexpected --json shape: ${result.stdout}`);
    assert.equal(record.state, 'done');
  });

  test('an id that does not exist, or could escape the store, is refused', async (t) => {
    if (!ready(t)) return;
    const unknown = await run(['rescue', 'status', 'nope'], { env });
    assert.equal(unknown.code, 1, `exit was ${unknown.code}`);

    // The traversal this once allowed: it read the file and printed it, and the
    // collect() after it wrote the record back over it.
    const escape = await run(['rescue', 'result', '../secret', '--json'], { env });
    assert.equal(escape.code, 1, `exit was ${escape.code}; stdout:\n${escape.stdout}`);
    assert.ok(escape.stderr.includes('no rescue job'), shows(escape.stderr, 'no rescue job'));
  });

  test('an unknown verb is a usage error', async (t) => {
    if (!ready(t)) return;
    const { code } = await run(['rescue', 'wobble', 'thing'], { env });
    assert.equal(code, 2, `exit was ${code}`);
  });

  test('a --model nothing serves is refused at submit time', async (t) => {
    if (!ready(t)) return;
    const { code } = await run(['rescue', 'hi', '--model', 'definitely-not-a-served-model'], { env });
    assert.equal(code, 1, `exit was ${code}`);
  });

  test('a --model substring resolves the same way the CLI resolves -m', async (t) => {
    if (!readyWithLight(t)) return;
    // A distinctive middle slice of the id, so this is a real substring match
    // rather than the exact-id shortcut, without naming any model in the file.
    const segment = ctx.lightModel.split('/').pop().slice(0, 8);
    const { code, stdout, stderr } = await run(
      ['rescue', 'Reply with only OK.', '--model', segment, '--steps', '2'],
      { env, timeout: 60_000 },
    );
    assert.equal(code, 0, `submit exited ${code}; stderr:\n${stderr}`);
    const id = stdout.trim();
    const record = JSON.parse(readFileSync(join(store, `${id}.json`), 'utf8'));
    assert.equal(record.model, ctx.lightModel,
      `"${segment}" resolved to ${record.model} rather than ${ctx.lightModel}`);
  });
});

describe('all of it together', () => {
  test('an ordinary one-shot still works with every feature in place', async (t) => {
    if (!ready(t)) return;
    const { stdout } = await run([
      '--no-context', '--no-warm', '-y', '--steps', '2', 'Reply with only the word TOGETHER.',
    ], { timeout: 300_000 });
    assert.ok(stdout.toUpperCase().includes('TOGETHER'), shows(stdout, 'TOGETHER'));
  });
});
