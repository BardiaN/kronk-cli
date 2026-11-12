import { spawn } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { setTimeout as sleep } from 'node:timers/promises';
import { config } from '../../src/config.js';
import { listModels, listModelDetails, warm } from '../../src/client.js';
import { chatModels } from '../../src/boot.js';
import { resolveModel } from '../../src/resolve.js';
import { findOnPath, runKronk } from '../../src/setup.js';

/**
 * Everything cli.smoke.js needs that is not itself a check: finding a real
 * server, picking real models to run them against, and the two ways of
 * driving the real CLI (a one-shot child process, and an interactive one
 * under a pty). None of this is a runtime dependency of the program — it is
 * only ever imported by test/smoke files — so it lives here rather than in
 * src/, and it reaches into src/ for the same reason a unit test does: to
 * exercise the real thing instead of a copy of it.
 *
 * The one rule this file exists to enforce: nothing in it, or in what it
 * hands back, may be specific to the machine it runs on. A model id, a
 * server URL, an MCP server name — anything like that is either discovered
 * at run time from Kronk itself, or read from an environment variable / a
 * gitignored local file, and it is never written down here. That is what
 * lets this whole suite sit in git.
 */

const CLI = new URL('../../src/index.js', import.meta.url).pathname;
const REPO = new URL('../../', import.meta.url).pathname;
const LOCAL_CONFIG = new URL('./smoke.local.json', import.meta.url).pathname;

// ---- output -----------------------------------------------------------

const log = (s) => console.log(`  smoke: ${s}`);

// ---- local, gitignored overrides ---------------------------------------

/**
 * `test/smoke/smoke.local.json`, or `{}` if it does not exist.
 *
 * Documented keys: `model` and `lightModel`, both a served model id or a
 * substring of one, in the same sense `-m` / `--model` already accepts on
 * the real CLI (src/resolve.js). Anyone who wants the suite pinned to a
 * particular pair of models on their own machine writes them here instead
 * of editing a committed file — see test/smoke/README.md.
 */
function loadLocalConfig() {
  try {
    return JSON.parse(readFileSync(LOCAL_CONFIG, 'utf8'));
  } catch {
    return {};
  }
}

// ---- waiting for a server to answer -------------------------------------

/**
 * How long to wait for a freshly started Kronk to bind its port and answer
 * `/models`. Generous on purpose: this is a cold start of the server binary
 * itself, on whatever machine happens to be running the suite, not a network
 * round trip — see src/setup.js's own `waitForServer`, which this mirrors.
 */
const STARTUP_TIMEOUT_MS = 120_000;
const STARTUP_POLL_MS = 1000;

async function waitForServer() {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastLog = 0;
  for (;;) {
    try {
      await listModels();
      return true;
    } catch {
      // still down
    }
    if (Date.now() >= deadline) return false;
    if (Date.now() - lastLog > 5000) {
      log(`waiting for ${config.baseUrl} to answer…`);
      lastLog = Date.now();
    }
    await sleep(STARTUP_POLL_MS);
  }
}

// ---- the before-all ------------------------------------------------------

/**
 * Run once, before any check. Works out whether this machine can run the
 * suite at all and, if so, what to run it against.
 *
 * Returns `{ skip: true, reason }` when the suite cannot run here — CI, no
 * server and nothing to start one with, or a server with no chat model to
 * pick an orchestrator from — and cli.smoke.js is expected to turn that into
 * one skipped check that explains why, rather than a wall of failures. On
 * success it returns `{ skip: false, baseUrl, model, lightModel,
 * hasLightModel }`, already warmed and ready for the first check to use.
 */
export async function setup() {
  // The suite drives a real CLI against a real, possibly cold model and can
  // legitimately take minutes; nothing about that should ever be allowed to
  // happen on a CI runner, whether or not today's glob would have picked it
  // up. This is the belt to test/smoke/'s directory-name suspenders.
  if (process.env.CI) {
    return {
      skip: true,
      reason: 'process.env.CI is set — the smoke suite talks to a real local Kronk server '
        + 'and a real model, and must never run unattended in CI.',
    };
  }

  let reachable = true;
  try {
    await listModels();
  } catch {
    reachable = false;
  }

  if (!reachable) {
    const binary = findOnPath('kronk');
    if (!binary) {
      return {
        skip: true,
        reason: `Kronk is not reachable at ${config.baseUrl}, and there is no \`kronk\` binary `
          + 'on PATH to start one. Install Kronk and run `kronk server start --detach`, or run '
          + '`kronk-cli setup`, then try again.',
      };
    }
    log(`no server at ${config.baseUrl} — starting one with \`kronk server start --detach\`…`);
    // Going through runKronk, not child_process directly: it is the one door
    // src/setup.js already opened for driving this exact binary, and a
    // second door next to it would only be a second thing to keep honest.
    await runKronk(['server', 'start', '--detach']);
    reachable = await waitForServer();
    if (!reachable) {
      return {
        skip: true,
        reason: `started \`kronk server start --detach\` but ${config.baseUrl} never answered `
          + `within ${STARTUP_TIMEOUT_MS / 1000}s — check \`kronk server logs\`.`,
      };
    }
  }

  const ids = await listModels();
  const details = await listModelDetails();
  const sizeOf = new Map(details.map((d) => [d.id, d.size]));
  // Kronk's native model list says which models carry a multimodal projector
  // (the MTMD column of `kronk model list`); that is what "can see" means here.
  const sees = new Set(details.filter((d) => d.has_projection).map((d) => d.id));
  const served = chatModels(ids);
  if (!served.length) {
    return {
      skip: true,
      reason: `Kronk at ${config.baseUrl} is serving no chat model to pick an orchestrator `
        + 'from — pull one and restart it.',
    };
  }

  // Smallest first. A model missing from `listModelDetails()` — should not
  // happen, but the response is somebody else's server, not this program's
  // guarantee — sorts as though it weighed nothing rather than crashing the
  // whole suite over a field that is only ever used to rank, never asserted on.
  const ranked = [...served].sort((a, b) => (sizeOf.get(a) ?? 0) - (sizeOf.get(b) ?? 0));
  const discoveredLight = ranked.length > 1 ? ranked[0] : null;
  const discoveredModel = ranked[ranked.length - 1];

  const local = loadLocalConfig();
  const wantModel = process.env.SMOKE_MODEL ?? local.model ?? null;
  const wantLight = process.env.SMOKE_LIGHT_MODEL ?? local.lightModel ?? null;

  const model = (wantModel && resolveModel(wantModel, ids)) || discoveredModel;
  const lightCandidate = wantLight ? (resolveModel(wantLight, ids) || discoveredLight) : discoveredLight;
  // A second model is only useful for the delegation checks if it is
  // actually a second model — an override that happens to resolve back to
  // the orchestrator is the same "only one chat model" case discovery
  // already handles, not a new one.
  const hasLightModel = Boolean(lightCandidate) && lightCandidate !== model;
  const lightModel = hasLightModel ? lightCandidate : null;

  log(`server        ${config.baseUrl}`);
  log(`orchestrator  ${model}`);
  log(`light model   ${lightModel ?? '(none — only one chat model served; delegation checks will skip)'}`);
  log('warming the chosen model(s) — a cold ~20 GB model takes 10-30s…');
  await warm(model);
  if (lightModel) await warm(lightModel);

  return {
    skip: false, baseUrl: config.baseUrl, model, lightModel, hasLightModel, vision: sees.has(model),
  };
}

// ---- driving the real CLI -------------------------------------------------

// eslint-disable-next-line no-control-regex -- stripping ANSI is the point
const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07/g;
const strip = (s) => String(s).replace(ANSI, '');

function spawnCapture(cmd, args, {
  env, cwd, timeout, stdin,
}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeout);
    timer.unref?.();
    child.stdout.setEncoding('utf8').on('data', (d) => { stdout += d; });
    child.stderr.setEncoding('utf8').on('data', (d) => { stderr += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? null : code, stdout, stderr, timedOut });
    });
    // Mirrors `subprocess.run(..., input=stdin)` in the Python original: a
    // pipe is always opened and always closed, whether or not there is
    // anything to write, so a child reading stdin as "extra context" sees it
    // end immediately rather than hang waiting for a TTY that is not there.
    child.stdin.end(stdin ?? '');
  });
}

/**
 * Run `src/index.js` as a child process and collect what it printed.
 *
 * `NO_COLOR` and `KRONK_THEME=dark` are always set so a check's assertions
 * do not have to look through ANSI codes or stop to guess the terminal's
 * background colour; `KRONK_MODEL` is always cleared first so an operator's
 * own shell can never leak a model choice into a check that is supposed to
 * be deciding that for itself — either by passing `-m`, or by deliberately
 * setting `KRONK_MODEL` again in `env`, which is applied after the clear and
 * so still wins.
 */
export async function run(args, {
  env = {}, stdin, timeout = 180_000, cwd = REPO,
} = {}) {
  const fullEnv = { ...process.env, NO_COLOR: '1', KRONK_THEME: 'dark' };
  delete fullEnv.KRONK_MODEL;
  Object.assign(fullEnv, env);

  const {
    code, stdout, stderr, timedOut,
  } = await spawnCapture('node', [CLI, ...args], {
    env: fullEnv, cwd, timeout, stdin,
  });
  if (timedOut) throw new Error(`run(${JSON.stringify(args)}) did not exit within ${timeout}ms`);
  return { code, stdout: strip(stdout), stderr: strip(stderr) };
}

/**
 * The pacing pipeline `repl()` runs under `bash -c`. It is a constant: the
 * CLI path and its arguments arrive as positional parameters (`"$@"`) and the
 * timings through the environment, so nothing a caller or `SMOKE_MODEL`
 * supplies is ever parsed as shell text.
 */
const REPL_PIPELINE = '( perl -e \'select(undef,undef,undef,$ENV{SMOKE_SETTLE})\'; '
  + 'printf \'%s\' "$SMOKE_REPL_PAYLOAD"; '
  + 'perl -e \'select(undef,undef,undef,$ENV{SMOKE_AFTER})\' ) '
  + '| script -q /dev/null node "$@"';

/**
 * Drive the interactive REPL through a real pty, pacing the input.
 *
 * A piped run never takes the TTY path at all — src/index.js checks
 * `stdin.isTTY` and falls straight into one-shot mode — so exercising the
 * REPL means putting a real pty in front of it, which is what `script`
 * does. And with no prompt already on argv, stdin to that pty *is* the
 * prompt: feeding it eagerly turns the whole run into a one-shot, and
 * `/exit` piped in that way exits before the banner is ever printed. The
 * fix is the same one the reference script used: wait for the banner and
 * the model load to settle before typing anything, then wait again after
 * the last line so `script` does not see EOF and tear the pty down before
 * the REPL has processed what was just sent.
 *
 * The lines are carried through an environment variable and read back with
 * `printf '%s'` rather than spliced into the shell command as text, so a
 * check is free to feed a prompt containing quotes or `$` without it being
 * interpreted as shell syntax.
 *
 * macOS-only, deliberately: `script -q /dev/null <cmd> [args...]` is the BSD
 * `script`'s calling convention (quiet, throwaway typescript file, then the
 * command to run). GNU `script`, the one Linux ships, wants `-c "<cmd
 * string>"` instead of a trailing argv, so this exact invocation does not
 * port there unchanged. Nothing here detects the difference or branches on
 * it — every machine this suite has run on so far is a Mac, and that is the
 * whole reason it is not handled rather than a decision that it should not be.
 */
export async function repl(lines, {
  args = [], env = {}, settle = 7, after = 2.5, timeout = 240_000, cwd = REPO,
} = {}) {
  const fullEnv = { ...process.env, NO_COLOR: '1', KRONK_THEME: 'dark' };
  delete fullEnv.KRONK_MODEL;
  Object.assign(fullEnv, env);
  fullEnv.SMOKE_REPL_PAYLOAD = lines.map((l) => `${l}\n`).join('');
  fullEnv.SMOKE_SETTLE = String(settle);
  fullEnv.SMOKE_AFTER = String(after);

  // `bash -c <script> <$0> <$1...>`: everything after the script is argv.
  const argv = ['-c', REPL_PIPELINE, 'bash', CLI, ...args];
  const { stdout, stderr, timedOut } = await spawnCapture('bash', argv, {
    env: fullEnv, cwd, timeout,
  });
  if (timedOut) throw new Error(`repl(${JSON.stringify(lines)}) did not exit within ${timeout}ms`);
  return strip(stdout + stderr);
}

/**
 * Drive the REPL through a pty the way a person would: type a line only once
 * the screen shows what it answers.
 *
 * `repl()` pre-loads its input and paces it by the clock, which cannot answer a
 * question that appears only after the model has chosen to ask it. Here each
 * step is `{ when, send }`: wait until `when` (a RegExp) matches output that
 * arrived after the previous step's match, then type `send`. After the last
 * step it waits for `until` if one is given, types `/exit`, and returns
 * everything the terminal showed, ANSI stripped. A step that never matches
 * rejects with the output so far, because a rerun costs minutes.
 *
 * macOS `script`, like `repl()` above, and for the same reason.
 */
export async function replDriven(steps, {
  args = [], env = {}, cwd = REPO, until = null, timeout = 240_000,
} = {}) {
  const fullEnv = { ...process.env, NO_COLOR: '1', KRONK_THEME: 'dark' };
  delete fullEnv.KRONK_MODEL;
  Object.assign(fullEnv, env);
  // `script` wants a real pipe or file on stdin; the socket node hands a child
  // makes it fail on tcgetattr. `cat` turns it into a pipe, and relays each line
  // the moment it is written.
  const child = spawn('bash', ['-c', 'cat | script -q /dev/null node "$@"', 'bash', CLI, ...args], {
    cwd, env: fullEnv, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let raw = '';
  let closed = false;
  child.stdout.setEncoding('utf8').on('data', (d) => { raw += d; });
  child.stderr.setEncoding('utf8').on('data', (d) => { raw += d; });
  child.on('close', () => { closed = true; });
  child.stdin.on('error', () => {});
  const shown = () => strip(raw);
  const deadline = Date.now() + timeout;

  const waitFor = async (re, from, what) => {
    for (;;) {
      const m = shown().slice(from).match(re);
      if (m) return from + m.index + m[0].length;
      if (closed || Date.now() > deadline) {
        child.kill('SIGKILL');
        throw new Error(`replDriven: ${closed ? 'the REPL exited' : 'timed out'} waiting for ${what}; output so far:\n${shown()}`);
      }
      await sleep(100);
    }
  };

  let at = 0;
  try {
    for (const { when, send } of steps) {
      at = await waitFor(when, at, String(when));
      child.stdin.write(`${send}\n`);
    }
    if (until) at = await waitFor(until, at, String(until));
    // The prompt before /exit, so the line is read by the REPL and not by a turn.
    await waitFor(/›/, at, 'the prompt');
    child.stdin.write('/exit\n');
    const grace = Date.now() + 20_000;
    while (!closed && Date.now() < grace) await sleep(100);
  } finally {
    if (!closed) child.kill('SIGKILL');
  }
  return shown();
}

// ---- a picture to show the model -------------------------------------------

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const body = Buffer.concat([Buffer.from(type), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

/** A solid-colour PNG, built with node's zlib; no dependency, no fixture file. */
export function solidPng(r, g, b, size = 64) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, () => [r, g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: size }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * A temp directory holding red PNGs named like a macOS screenshot: `plain` has
 * no extension; the other also has a U+202F before "PM", which `typedName`
 * spells with a plain space the way a person would type it. Also a binary file
 * that is not an image.
 */
export function screenshotDir() {
  const dir = mkdtempSync(join(tmpdir(), 'kronk-smoke-shot-'));
  const plain = 'Screenshot test';
  const odd = 'Shot 7.51.21' + '\u202f' + 'PM';
  writeFileSync(join(dir, plain), solidPng(255, 0, 0));
  writeFileSync(join(dir, odd), solidPng(255, 0, 0));
  writeFileSync(join(dir, 'blob.dat'), Buffer.from([0, 1, 2, 0xff, 0xfe, 0, 7]));
  return { dir, plain, typedName: odd.replace('\u202f', ' ') };
}
