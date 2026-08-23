import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  buildFillerPrompt, buildReport, renderTable, parseKronkVersion, parseLlamaCppVersion,
} from '../scripts/bench.mjs';

const run = promisify(execFile);
const BENCH = new URL('../scripts/bench.mjs', import.meta.url).pathname;
const SRC = new URL('../scripts/bench.mjs', import.meta.url).pathname;
const MODEL = 'stub/Bench-Model/AGENT';

// ---- the arithmetic and formatting: the actual testable surface --------

test('buildFillerPrompt is deterministic and byte-identical across calls', () => {
  const a = buildFillerPrompt(50);
  const b = buildFillerPrompt(50);
  assert.equal(a, b);
  assert.equal(a.split('\n').length, 50);
  assert.match(a, /^Line 1: /);
  assert.match(a, /Line 50: /);
});

test('buildFillerPrompt carries no randomness, timestamps or host-dependent values', () => {
  const p = buildFillerPrompt(10);
  assert.doesNotMatch(p, /\d{4}-\d{2}-\d{2}/, 'no dates');
  assert.doesNotMatch(p, /Math\.random/);
});

test('buildReport computes tokens/sec from measured wall clock, not a server-reported figure', () => {
  const report = buildReport({
    meta: { model: MODEL, kronkVersion: '1.31.9', llamaCppVersion: 'b10549' },
    generation: [
      { completionTokens: 200, wallClockMs: 4000, ttftMs: 120 },
      { completionTokens: 100, wallClockMs: 2000, ttftMs: 80 },
    ],
    cache: {
      fillerTokens: 5000,
      turns: [
        { turn: 1, promptTokens: 5020, cachedTokens: 0, latencyMs: 4000 },
        { turn: 2, promptTokens: 5040, cachedTokens: 5020, latencyMs: 180 },
        { turn: 3, promptTokens: 5060, cachedTokens: 5040, latencyMs: 175 },
      ],
    },
    coldLoad: { skipped: false, wallClockMs: 11400 },
  });

  assert.deepEqual(report.generation.runs[0], {
    run: 1, completionTokens: 200, seconds: 4, tokensPerSecond: 50, ttftMs: 120,
  });
  assert.deepEqual(report.generation.runs[1], {
    run: 2, completionTokens: 100, seconds: 2, tokensPerSecond: 50, ttftMs: 80,
  });

  assert.equal(report.cache.fillerTokens, 5000);
  assert.equal(report.cache.turns[0].cachedFraction, 0, 'nothing cached on the first turn');
  assert.equal(report.cache.turns[1].cachedFraction, Number((5020 / 5040).toFixed(3)));
  assert.equal(report.cache.turns[2].cachedFraction, Number((5040 / 5060).toFixed(3)));

  assert.deepEqual(report.coldLoad, { skipped: false, seconds: 11.4 });
});

test('buildReport never divides by zero — a zero-length run reports 0 tok/s, not Infinity or NaN', () => {
  const report = buildReport({
    meta: { model: MODEL, kronkVersion: 'x', llamaCppVersion: 'y' },
    generation: [{ completionTokens: 0, wallClockMs: 0, ttftMs: 0 }],
    cache: { fillerTokens: 0, turns: [{ turn: 1, promptTokens: 0, cachedTokens: 0, latencyMs: 0 }] },
    coldLoad: { skipped: true, reason: 'not resident' },
  });
  assert.equal(report.generation.runs[0].tokensPerSecond, 0);
  assert.equal(report.cache.turns[0].cachedFraction, 0);
  assert.deepEqual(report.coldLoad, { skipped: true, reason: 'not resident' });
});

test('renderTable prints a unit on every number, and identifies the run in its header', () => {
  const report = buildReport({
    meta: { model: MODEL, kronkVersion: '1.31.9', llamaCppVersion: 'b10549' },
    generation: [{ completionTokens: 256, wallClockMs: 5000, ttftMs: 130 }],
    cache: {
      fillerTokens: 5491,
      turns: [{ turn: 1, promptTokens: 5518, cachedTokens: 5496, latencyMs: 149 }],
    },
    coldLoad: { skipped: true, reason: `${MODEL} is already resident` },
  });
  const out = renderTable(report);

  assert.match(out, new RegExp(`model ${MODEL.replace(/\//g, '\\/')} · kronk 1\\.31\\.9 · llama\\.cpp b10549`));
  assert.match(out, /256 tok · 5s · 51\.2 tok\/s · ttft 130ms/);
  assert.match(out, /filler prompt: 5491 tok/);
  assert.match(out, /5518 tok prompt · 5496 tok cached \(100%\) · 149ms/);
  assert.match(out, /skipped — stub\/Bench-Model\/AGENT is already resident/);
});

test('parseKronkVersion reads the version out of `kronk --version`', () => {
  assert.equal(parseKronkVersion('kronk version 1.31.9\n'), '1.31.9');
  assert.equal(parseKronkVersion('kronk version 1.31.9'), '1.31.9');
});

test('parseLlamaCppVersion reads the build string out of `kronk libs --list-installs`', () => {
  const table = 'OS         ARCH       PROCESSOR  VERSION    \ndarwin     arm64      metal      b10549\n';
  assert.equal(parseLlamaCppVersion(table), 'b10549');
});

test('parseLlamaCppVersion has no data row to read', () => {
  assert.equal(parseLlamaCppVersion('OS ARCH PROCESSOR VERSION\n'), 'unknown');
});

// ---- static check: the script must import no filesystem module ---------

test('scripts/bench.mjs never mentions node:fs', () => {
  const source = readFileSync(SRC, 'utf8');
  assert.doesNotMatch(source, /node:fs/, 'bench.mjs must read only the environment, write only to stdout');
});

// ---- stub-server: the printed table and --json output, scripted --------

/**
 * Every streamed chat request the bench makes is answered from this fixed
 * script, in order: two generation runs, then three cache-retention turns.
 * Fixed numbers in, so the report's token/cache fields can be asserted
 * exactly; only the timing fields the stub cannot fix are asserted loosely.
 */
const SCRIPT = [
  { completionTokens: 256, promptTokens: 12, cachedTokens: 0 },
  { completionTokens: 249, promptTokens: 12, cachedTokens: 0 },
  { completionTokens: 4, promptTokens: 5518, cachedTokens: 0 },
  { completionTokens: 4, promptTokens: 5543, cachedTokens: 5518 },
  { completionTokens: 4, promptTokens: 5568, cachedTokens: 5543 },
];
const FILLER_TOKENS = 5491;

function startStub({ resident = [] } = {}) {
  let call = 0;
  const send = (res, code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const server = createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/v1/models') return send(res, 200, { object: 'list', data: [{ id: MODEL, object: 'model' }] });
    if (url === '/v1/kronk/models/ps') return send(res, 200, resident.map((id) => ({ id, status: 'loaded' })));
    if (url === '/v1/tokenize') return send(res, 200, { tokens: FILLER_TOKENS });
    if (url === '/v1/chat/completions') {
      let raw = '';
      req.on('data', (d) => { raw += d; });
      return req.on('end', () => {
        const body = JSON.parse(raw);
        if (!body.stream) {
          // the cold-load warm() call: reply discarded, only that it succeeded matters
          return send(res, 200, {
            id: 'chatcmpl-warm',
            choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'length' }],
          });
        }
        const step = SCRIPT[call++];
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const chunk = (delta, finish = null, usage = null) => JSON.stringify({
          choices: [{ index: 0, delta, finish_reason: finish }], usage,
        });
        res.write(`data: ${chunk({ role: 'assistant', content: 'x' })}\n`);
        res.write(`data: ${chunk({}, 'stop', {
          prompt_tokens: step.promptTokens,
          completion_tokens: step.completionTokens,
          prompt_tokens_details: { cached_tokens: step.cachedTokens },
        })}\n`);
        res.write('data: [DONE]\n');
        return res.end();
      });
    }
    return send(res, 404, { error: { message: `stub has no route for ${url}` } });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}/v1`,
      close: () => { server.closeAllConnections(); server.close(); },
    }));
  });
}

/** Run the real script against a stub, with a throwaway HOME so ~/.kronk-cli.json cannot interfere. */
async function bench(stubUrl, args) {
  const env = {
    ...process.env,
    KRONK_URL: stubUrl,
    KRONK_MODEL: MODEL,
    HOME: mkdtempSync(join(tmpdir(), 'bench-home-')),
    NO_COLOR: '1',
  };
  return run(process.execPath, [BENCH, ...args], { env, timeout: 30_000 });
}

test('the printed table reflects the scripted usage numbers exactly, timing loosely', async () => {
  const stub = await startStub({ resident: [] });
  try {
    const { stdout } = await bench(stub.url, []);

    assert.match(stdout, new RegExp(`model ${MODEL.replace(/\//g, '\\/')}`));
    assert.match(stdout, /run 1: 256 tok · [\d.]+s · [\d.]+ tok\/s · ttft \d+ms/);
    assert.match(stdout, /run 2: 249 tok · [\d.]+s · [\d.]+ tok\/s · ttft \d+ms/);
    assert.match(stdout, /filler prompt: 5491 tok/);
    assert.match(stdout, /turn 1: 5518 tok prompt · 0 tok cached \(0%\) · \d+ms/);
    assert.match(stdout, /turn 2: 5543 tok prompt · 5518 tok cached \(100%\) · \d+ms/);
    assert.match(stdout, /turn 3: 5568 tok prompt · 5543 tok cached \(100%\) · \d+ms/);
    // not resident in this stub, so the cold load actually ran and printed seconds
    assert.match(stdout, /3\. Cold load\n {3}[\d.]+s/);
  } finally {
    stub.close();
  }
});

test('--json prints the same scripted numbers as one parseable object', async () => {
  const stub = await startStub({ resident: [] });
  try {
    const { stdout } = await bench(stub.url, ['--json']);
    const report = JSON.parse(stdout);

    assert.equal(report.meta.model, MODEL);
    assert.equal(report.generation.runs.length, 2);
    assert.equal(report.generation.runs[0].completionTokens, 256);
    assert.equal(report.generation.runs[1].completionTokens, 249);
    for (const r of report.generation.runs) {
      assert.equal(typeof r.seconds, 'number');
      assert.ok(r.seconds >= 0);
      assert.equal(typeof r.tokensPerSecond, 'number');
      assert.equal(typeof r.ttftMs, 'number');
    }

    assert.equal(report.cache.fillerTokens, FILLER_TOKENS);
    assert.deepEqual(report.cache.turns.map((t) => t.promptTokens), [5518, 5543, 5568]);
    assert.deepEqual(report.cache.turns.map((t) => t.cachedTokens), [0, 5518, 5543]);
    assert.equal(report.cache.turns[0].cachedFraction, 0);
    assert.equal(report.cache.turns[1].cachedFraction, Number((5518 / 5543).toFixed(3)));

    assert.equal(report.coldLoad.skipped, false);
    assert.equal(typeof report.coldLoad.seconds, 'number');
  } finally {
    stub.close();
  }
});

test('a resident model skips the cold-load measurement instead of printing a misleading number', async () => {
  const stub = await startStub({ resident: [MODEL] });
  try {
    const { stdout } = await bench(stub.url, ['--json']);
    const report = JSON.parse(stdout);
    assert.equal(report.coldLoad.skipped, true);
    assert.match(report.coldLoad.reason, /already resident/);
  } finally {
    stub.close();
  }
});

test('--skip-cold-load forces the skip regardless of residency', async () => {
  const stub = await startStub({ resident: [] });
  try {
    const { stdout } = await bench(stub.url, ['--json', '--skip-cold-load']);
    const report = JSON.parse(stdout);
    assert.equal(report.coldLoad.skipped, true);
    assert.match(report.coldLoad.reason, /--skip-cold-load/);
  } finally {
    stub.close();
  }
});

// ---- server down: non-zero exit, the existing message, no new copy -----

test('exits non-zero with the existing "Cannot reach Kronk at" message when nothing is listening', async () => {
  // Bind then immediately release a port, so the address is guaranteed free
  // for this process and this process only, without guessing at a number.
  const probe = createServer();
  const port = await new Promise((resolve) => {
    probe.listen(0, '127.0.0.1', () => resolve(probe.address().port));
  });
  await new Promise((resolve) => probe.close(resolve));

  await assert.rejects(
    bench(`http://127.0.0.1:${port}/v1`, []),
    (err) => {
      assert.notEqual(err.code, 0);
      assert.match(err.stderr, /Cannot reach Kronk at/);
      return true;
    },
  );
});
