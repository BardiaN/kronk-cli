#!/usr/bin/env node
/**
 * Reproduces the performance numbers README.md publishes.
 *
 * Talks to whatever KRONK_URL / KRONK_TOKEN / KRONK_MODEL already point at,
 * the same way the CLI does (src/config.js) — no flags to aim it somewhere
 * else, on purpose: the point is to measure the server you already have
 * configured, not a benchmark harness with its own settings to drift out of
 * sync with reality.
 *
 * A dev tool, not part of the shipped package (see the `files` allowlist in
 * package.json) — so it is free to shell out to the `kronk` CLI for version
 * strings that have no REST equivalent, something src/ never does.
 *
 * Deliberately imports no filesystem module: it reads configuration from the
 * environment (via src/config.js) and writes only to stdout/stderr.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { config, DEFAULT_MODEL } from '../src/config.js';
import { listModels, listLoaded, streamChat, tokenize, warm } from '../src/client.js';
import { c } from '../src/ui.js';

const run = promisify(execFile);

// ---- fixed measurement parameters --------------------------------------
// Fixed prompt, fixed budget, run more than once — the first run always
// pays warm-up cost the rest don't, which is the point of running it twice.
const GEN_PROMPT = 'Write a 150-word short story about a lighthouse keeper who finds a '
  + 'message in a bottle. Use the full length available; do not stop early.';
const GEN_MAX_TOKENS = 256;
const GEN_RUNS = 2;

// Thinking is switched off for both measurements below: llama.cpp's decode
// rate is the same whether the tokens are reasoning or content, so this buys
// run-to-run consistency (no variable-length reasoning pass) without biasing
// the tok/s figure it exists to compare.
const CACHE_TURNS = 3;
const CACHE_MAX_TOKENS = 8;
const FILLER_LINES = 200;
const FILLER_SENTENCE = 'The quick brown fox jumps over the lazy dog while the old stone '
  + 'bridge holds steady against the river current.';

// ---- pure: deterministic filler ----------------------------------------

/**
 * N numbered lines of one fixed sentence — no randomness, no timestamps, no
 * host-dependent values. Byte-identical on every run and every machine, so
 * the token count it produces (printed alongside it) is a real comparison
 * point between runs, not noise.
 */
export function buildFillerPrompt(lines = FILLER_LINES) {
  const out = [];
  for (let i = 1; i <= lines; i++) out.push(`Line ${i}: ${FILLER_SENTENCE}`);
  return out.join('\n');
}

// ---- pure: version-string parsing --------------------------------------

/** `kronk version 1.31.9\n` -> `1.31.9` */
export function parseKronkVersion(stdout) {
  const m = stdout.match(/version\s+(\S+)/i);
  return m ? m[1] : stdout.trim();
}

/**
 * `kronk libs --list-installs` prints a fixed-width table:
 *   OS         ARCH       PROCESSOR  VERSION
 *   darwin     arm64      metal      b10549
 * The llama.cpp build string is the last column of the first data row.
 */
export function parseLlamaCppVersion(stdout) {
  const rows = stdout.trim().split('\n').slice(1).filter((l) => l.trim());
  if (!rows.length) return 'unknown';
  const cols = rows[0].trim().split(/\s+/);
  return cols[cols.length - 1];
}

// ---- pure: the arithmetic and formatting -------------------------------

const round = (n, d = 1) => Number(n.toFixed(d));

/**
 * Takes the raw numbers each measurement collected and returns the plain,
 * JSON-safe report object both the table and --json render from. This is
 * the testable surface — the network calls that fill in its input are not.
 */
export function buildReport({ meta, generation, cache, coldLoad }) {
  return {
    meta,
    generation: {
      runs: generation.map((r, i) => {
        const seconds = round(r.wallClockMs / 1000, 2);
        return {
          run: i + 1,
          completionTokens: r.completionTokens,
          seconds,
          tokensPerSecond: seconds > 0 ? round(r.completionTokens / seconds, 1) : 0,
          ttftMs: round(r.ttftMs, 0),
        };
      }),
    },
    cache: {
      fillerTokens: cache.fillerTokens,
      turns: cache.turns.map((t) => ({
        turn: t.turn,
        promptTokens: t.promptTokens,
        cachedTokens: t.cachedTokens,
        cachedFraction: round(t.promptTokens > 0 ? t.cachedTokens / t.promptTokens : 0, 3),
        latencyMs: round(t.latencyMs, 0),
      })),
    },
    coldLoad: coldLoad.skipped
      ? { skipped: true, reason: coldLoad.reason }
      : { skipped: false, seconds: round(coldLoad.wallClockMs / 1000, 1) },
  };
}

/** The report as the short table `node scripts/bench.mjs` prints by default. */
export function renderTable(report) {
  const { meta } = report;
  const lines = [
    `kronk-bench · model ${meta.model} · kronk ${meta.kronkVersion} · llama.cpp ${meta.llamaCppVersion}`,
    '',
    '1. Generation speed',
  ];
  for (const r of report.generation.runs) {
    lines.push(`   run ${r.run}: ${r.completionTokens} tok · ${r.seconds}s · ${r.tokensPerSecond} tok/s · ttft ${r.ttftMs}ms`);
  }
  lines.push('', `2. Prompt cache retention (filler prompt: ${report.cache.fillerTokens} tok)`);
  for (const t of report.cache.turns) {
    const pct = round(t.cachedFraction * 100, 0);
    lines.push(`   turn ${t.turn}: ${t.promptTokens} tok prompt · ${t.cachedTokens} tok cached (${pct}%) · ${t.latencyMs}ms`);
  }
  lines.push('', '3. Cold load');
  lines.push(report.coldLoad.skipped
    ? `   skipped — ${report.coldLoad.reason}`
    : `   ${report.coldLoad.seconds}s`);
  return lines.join('\n');
}

// ---- impure: the network / process calls that feed the above ----------

async function kronkCliVersion() {
  try {
    const { stdout } = await run('kronk', ['--version']);
    return parseKronkVersion(stdout);
  } catch {
    return 'unknown';
  }
}

async function llamaCppBuildVersion() {
  try {
    const { stdout } = await run('kronk', ['libs', '--list-installs']);
    return parseLlamaCppVersion(stdout);
  } catch {
    return 'unknown';
  }
}

/** Measurement 1: a fixed prompt, streamed, timed end to end. */
async function runGeneration(model) {
  const t0 = Date.now();
  let tFirst = null;
  let usage = null;
  for await (const ev of streamChat({
    model,
    messages: [{ role: 'user', content: GEN_PROMPT }],
    maxTokens: GEN_MAX_TOKENS,
    noThink: true,
  })) {
    if (tFirst === null && (ev.type === 'text' || ev.type === 'reasoning')) tFirst = Date.now();
    if (ev.type === 'usage') usage = ev.value;
  }
  return {
    completionTokens: usage?.completion_tokens ?? 0,
    wallClockMs: Date.now() - t0,
    ttftMs: (tFirst ?? Date.now()) - t0,
  };
}

/** Measurement 2: a long deterministic system prompt, three turns on one history. */
async function runCacheRetention(model) {
  const filler = buildFillerPrompt();
  const fillerTokens = await tokenize(model, filler);
  const messages = [{ role: 'system', content: filler }];
  const turns = [];
  for (let i = 1; i <= CACHE_TURNS; i++) {
    messages.push({ role: 'user', content: `Turn ${i}: reply with exactly one word.` });
    const t0 = Date.now();
    let usage = null;
    let text = '';
    for await (const ev of streamChat({ model, messages, maxTokens: CACHE_MAX_TOKENS, noThink: true })) {
      if (ev.type === 'text') text += ev.value;
      if (ev.type === 'usage') usage = ev.value;
    }
    turns.push({
      turn: i,
      promptTokens: usage?.prompt_tokens ?? 0,
      cachedTokens: usage?.prompt_tokens_details?.cached_tokens ?? 0,
      latencyMs: Date.now() - t0,
    });
    messages.push({ role: 'assistant', content: text });
  }
  return { fillerTokens, turns };
}

/**
 * Measurement 3: time a one-token completion the same way warm() does
 * (src/client.js) against a model that is not resident. Detecting residency
 * the same way listLoaded() does (`/v1/kronk/models/ps`) and skipping rather
 * than timing an already-loaded model, which would just measure the network
 * round trip and print a number that looks like a cold load but isn't one.
 */
async function runColdLoad(model, forceSkip) {
  if (forceSkip) return { skipped: true, reason: '--skip-cold-load was set' };

  const loaded = await listLoaded();
  const resident = new Set((Array.isArray(loaded) ? loaded : []).map((l) => l.id));
  if (resident.has(model)) {
    return {
      skipped: true,
      reason: `${model} is already resident — a cold load number here would be misleading`,
    };
  }

  const t0 = Date.now();
  await warm(model);
  return { skipped: false, wallClockMs: Date.now() - t0 };
}

// ---- entry point --------------------------------------------------------

function printHelp() {
  console.log(`
  bench.mjs — reproduce the performance numbers in README.md

  USAGE
    node scripts/bench.mjs [options]

  OPTIONS
    --json              print one JSON object instead of the table
    --skip-cold-load    skip measurement 3 even if the model is not resident
    -h, --help          this message

  Reads KRONK_URL / KRONK_TOKEN / KRONK_MODEL the same way the CLI does.
`);
}

async function main() {
  const argv = process.argv.slice(2);
  const flag = (...names) => {
    const i = argv.findIndex((a) => names.includes(a));
    if (i === -1) return false;
    argv.splice(i, 1);
    return true;
  };
  if (flag('-h', '--help')) { printHelp(); return; }
  const jsonOut = flag('--json');
  const skipColdLoad = flag('--skip-cold-load');

  try {
    await listModels();
  } catch (e) {
    console.error(c.red(`\n  Cannot reach Kronk at ${config.baseUrl}`));
    console.error(c.grey(`  ${e.message}`));
    console.error(c.grey('  Start it with:  kronk server start --detach\n'));
    process.exit(1);
  }

  const model = config.model ?? DEFAULT_MODEL;
  const [kronkVersion, llamaCppVersion] = await Promise.all([kronkCliVersion(), llamaCppBuildVersion()]);

  // Measured first, printed last. Kronk admits a model on its first inference
  // request, so anything that talks to the model loads it. Run this after the
  // generation section and the residency check inside it can never be false —
  // the section reported `skipped` on every run, describing a state its own
  // earlier requests had created. A model the operator left resident is still a
  // real skip; that is the case the check exists for.
  const coldLoad = await runColdLoad(model, skipColdLoad);

  const generation = [];
  for (let i = 0; i < GEN_RUNS; i++) generation.push(await runGeneration(model));

  const cache = await runCacheRetention(model);

  const report = buildReport({ meta: { model, kronkVersion, llamaCppVersion }, generation, cache, coldLoad });
  console.log(jsonOut ? JSON.stringify(report, null, 2) : renderTable(report));
}

// Only run when invoked directly (`node scripts/bench.mjs`) — importing this
// module for its pure functions, as the tests do, must not talk to a server.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => {
    console.error(c.red(`\n  bench failed: ${e.message}`));
    process.exit(1);
  });
}
