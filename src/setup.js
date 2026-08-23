/**
 * `kronk-cli setup` — the three things a first-time user has to know and
 * currently has to do by hand: pull the model, give it an /AGENT profile in
 * ~/.kronk/models/model_config.yaml, and restart Kronk, because that file is
 * only read at server start.
 *
 * The YAML writer here is deliberately not a parser. It locates one insertion
 * point by a structural scan and refuses whenever the answer is not obvious.
 * A half-written parser would round-trip — and quietly corrupt — a file it does
 * not understand, which is worse than printing the block and letting the user
 * paste it.
 */
import readline from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { accessSync, constants, copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { config, DEFAULT_MODEL } from './config.js';
import { listModels, modelLimits } from './client.js';
import { c } from './ui.js';

/** The documented defaults for an agent profile. See README, "Tip: use an /AGENT profile". */
const DEFAULT_CONTEXT = 131072;
const PROFILE_MAX_TOKENS = 16384;
const NSEQ_MAX = 2;

/** How long to wait for the server to answer again after a restart. */
const RESTART_TIMEOUT_MS = 90_000;
const RESTART_POLL_MS = 1000;

/**
 * `catalog show` prints the whole tokenizer vocabulary — megabytes of it. Only
 * the header is ever read, so stop accumulating once it cannot still be there.
 */
const CAPTURE_CAP = 64 * 1024;

// ---- pure helpers -------------------------------------------------------

/**
 * The catalog id for a model id. A catalog entry is `owner/name`; anything past
 * that is a Kronk profile suffix (`/AGENT`), which the catalog cannot resolve.
 */
export function baseModelId(id) {
  const parts = id.split('/');
  return parts.length > 2 ? parts.slice(0, -1).join('/') : id;
}

/** Ids are plain enough to sit unquoted in YAML, but do not bet the file on it. */
const YAML_SAFE = /^[A-Za-z0-9._/@+-]+$/;
const yamlKey = (id) => (YAML_SAFE.test(id) ? id : `'${id.replace(/'/g, "''")}'`);

/**
 * The profile block, as lines, at the two-space indent of a `models:` child.
 *
 * No `temperature`, `top_k` or `top_p`: current GGUFs carry the values their
 * authors recommend and Kronk's AutoTune reads them, so an explicit block here
 * would only override the model's own advice.
 */
export function profileEntry(id, contextWindow) {
  return [
    `  ${yamlKey(id)}:`,
    `    context-window: ${contextWindow}`,
    `    nseq-max: ${NSEQ_MAX}`,
    '    chat-template-kwargs:',
    '      preserve_thinking: true',
    '    sampling-parameters:',
    `      max_tokens: ${PROFILE_MAX_TOKENS}`,
  ];
}

/** Every line with its byte offsets and its own terminator, so nothing is re-joined. */
function splitLines(text) {
  const rows = [];
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i < text.length && text[i] !== '\n') continue;
    const raw = text.slice(start, i);
    const crlf = raw.endsWith('\r');
    rows.push({
      text: crlf ? raw.slice(0, -1) : raw,
      end: crlf ? i - 1 : i,                       // first byte of the terminator
      term: i < text.length ? (crlf ? '\r\n' : '\n') : '',
    });
    start = i + 1;
  }
  return rows;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Where the entry for `id` goes in an existing model_config.yaml.
 *
 * Top-level keys are lines matching `^[A-Za-z_]` with no leading whitespace, as
 * the issue specifies; the children of `models:` run to the next such line.
 *
 * kind is one of:
 *   'present'  the profile key is already there — nothing to do
 *   'insert'   splice the entry in directly beneath the one `models:` key
 *   'append'   no `models:` key at all — add the key and the entry at the end
 *   'refuse'   more than one insertion point, or none that is unambiguous
 */
export function scanConfig(text, id) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const rows = splitLines(text);
  const heads = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => /^[A-Za-z_]/.test(row.text) && /^models\s*:/.test(row.text));

  if (heads.length > 1) {
    return { eol, kind: 'refuse', reason: `it has ${heads.length} top-level "models:" keys` };
  }
  if (!heads.length) return { eol, kind: 'append' };

  const { row, index } = heads[0];
  // `models: {}` or `models: [x]` is a mapping written inline. Its children are
  // not lines, so there is no line to insert one beneath.
  const inline = row.text.slice(row.text.indexOf(':') + 1).trim();
  if (inline && !inline.startsWith('#')) {
    return { eol, kind: 'refuse', reason: 'its "models:" key holds an inline value' };
  }

  let end = rows.length;
  for (let i = index + 1; i < rows.length; i++) {
    if (/^[A-Za-z_]/.test(rows[i].text)) { end = i; break; }
  }
  // An exact match on the indented `<id>:` line. A commented-out `# <id>:` has a
  // `#` where the id would start, so it never matches.
  const key = new RegExp(`^\\s+${escapeRe(yamlKey(id))}\\s*:\\s*(#.*)?$`);
  for (const child of rows.slice(index + 1, end)) {
    if (key.test(child.text)) return { eol, kind: 'present' };
  }

  return { eol, kind: 'insert', head: row, next: rows[index + 1] };
}

/**
 * The file as it will be on disk. Every line the writer did not add is copied
 * across untouched, terminator included — the entry is spliced into the string
 * rather than the file being re-serialised from parsed lines.
 */
export function applyEntry(text, scan, entry) {
  const { eol } = scan;
  const block = entry.map((l) => l + eol).join('');

  if (scan.kind === 'insert') {
    const at = scan.head.end + scan.head.term.length;
    // A file that ended on `models:` with no newline still needs one.
    const lead = scan.head.term ? '' : eol;
    // Keep whatever followed from being glued to the new entry.
    const gap = scan.next && scan.next.text.trim() !== '' ? eol : '';
    return text.slice(0, at) + lead + block + gap + text.slice(at);
  }

  let out = text;
  if (out.length && !out.endsWith(eol)) out += eol;          // finish the last line
  if (out.length && !out.endsWith(eol + eol)) out += eol;    // one blank line before the key
  return `${out}models:${eol}${block}`;
}

/** A brand-new file. Nothing to preserve, so it gets the documented shape. */
export function newConfig(entry) {
  return ['version: 1', '', 'models:', ...entry, ''].join('\n');
}

/**
 * Copy the file aside before touching it, never over a backup that already
 * exists — `.bak` and `.bak2` are sitting next to real configs in the wild.
 * COPYFILE_EXCL makes "does it exist" and "claim it" one operation.
 */
export function backupFile(path) {
  for (let n = 1; n <= 50; n++) {
    const dest = `${path}.bak${n === 1 ? '' : n}`;
    try {
      copyFileSync(path, dest, constants.COPYFILE_EXCL);
      return dest;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  throw new Error(`${path}.bak … .bak50 all exist — clean some up first`);
}

/**
 * Resolve an executable on PATH without spawning anything, so `--dry-run` can
 * report a missing binary while keeping its promise to start no process.
 */
export function findOnPath(name, env = process.env) {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    try {
      const full = join(dir, name);
      accessSync(full, constants.X_OK);
      return full;
    } catch {
      // not here, keep looking
    }
  }
  return null;
}

// ---- the kronk binary ---------------------------------------------------

/**
 * The only place this program starts the `kronk` binary. One door means a test
 * can put a stub named `kronk` first on PATH and assert on the argv it saw.
 *
 * `stream: true` hands the child our terminal, which is what a 21 GB pull wants;
 * otherwise its output is captured (up to CAPTURE_CAP) for parsing.
 */
export function runKronk(argv, { stream = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('kronk', argv, {
      stdio: ['ignore', stream ? 'inherit' : 'pipe', stream ? 'inherit' : 'pipe'],
    });
    let output = '';
    const take = (d) => { if (output.length < CAPTURE_CAP) output += d; };
    child.stdout?.setEncoding('utf8').on('data', take);
    child.stderr?.setEncoding('utf8').on('data', take);
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
  });
}

/**
 * What the local catalog knows about a base id.
 *
 * `catalog show` exits 0 even for an id it cannot resolve, so presence is read
 * from the body, not the status.
 */
async function catalogEntry(base) {
  const { output } = await runKronk(['catalog', 'show', base, '--local']);
  const size = /^Total Size:\s*(.+)$/m.exec(output)?.[1].trim() ?? null;
  return { known: size !== null, size, downloaded: /^Downloaded:\s*true\s*$/m.test(output) };
}

// ---- output -------------------------------------------------------------

const line = (s = '') => console.log(s);
const step = (n, title) => line(`\n  ${c.bold(`${n})`)} ${title}`);
const detail = (s) => line(c.grey(`     ${s}`));
const note = (s) => line(`     ${s}`);
const cmd = (s) => line(c.cyan(`     ${s}`));

/** Show exactly the lines that are being added, or that the user must paste. */
function printBlock(lines) {
  line();
  for (const l of lines) line(c.grey(`     ${l}`));
  line();
}

// ---- the walk -----------------------------------------------------------

/**
 * Run the whole setup path. Returns the process exit code rather than calling
 * process.exit, so the caller stays in charge of how the program ends.
 */
export async function runSetup({ model, context, yes = false, dryRun = false } = {}) {
  if (context !== null && context !== undefined && !/^[1-9]\d*$/.test(String(context))) {
    console.error(c.red('\n  --context takes a positive integer\n'));
    return 2;
  }

  let rl = null;
  let ended = false;
  const ask = async (question) => {
    if (yes) { note(`${question} ${c.grey('yes (--yes)')}`); return true; }
    if (dryRun) { note(`${question} ${c.grey('skipped (--dry-run)')}`); return false; }
    if (!rl) {
      rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.once('close', () => { ended = true; });
    }
    // Silence is not consent. An input that has already ended — a closed pipe, a
    // background job, CI without --yes — must decline, and say why: asking a
    // dead readline yields a promise that never settles, and the program would
    // otherwise exit 0 in the middle of the walk having said nothing.
    if (ended) { note(`${question} ${c.grey('no answer — stdin ended, assuming no')}`); return false; }
    let answer;
    try {
      answer = await Promise.race([
        rl.question(`     ${c.yellow(question)} `),
        new Promise((resolve) => rl.once('close', () => resolve(''))),
      ]);
    } catch { return false; }
    // A pipe does not echo, so the transcript would otherwise run the question
    // and its consequence together on one line with no answer between them.
    if (!process.stdin.isTTY) line(answer.trim());
    return /^y(es)?$/i.test(answer.trim());
  };

  try {
    return await walk({ model, context, dryRun, ask });
  } finally {
    rl?.close();
  }
}

async function walk({ model, context, dryRun, ask }) {
  line(`\n  ${c.bold('kronk-cli setup')}${dryRun ? c.grey('  · dry run, nothing will change') : ''}`);

  // 1 — the server. Setup never starts it: that is the user's decision to make.
  step(1, 'Checking the Kronk server');
  try {
    const ids = await listModels();
    detail(`${config.baseUrl} · serving ${ids.length} model${ids.length === 1 ? '' : 's'}`);
  } catch (e) {
    console.error(c.red(`\n  Cannot reach Kronk at ${config.baseUrl}`));
    console.error(c.grey(`  ${e.message}`));
    console.error(c.grey('  Start it with:  kronk server start --detach\n'));
    return 1;
  }

  // 2 — the target, and the catalog id underneath it.
  const target = model ?? config.model ?? DEFAULT_MODEL;
  const base = baseModelId(target);
  step(2, 'Resolving the target');
  detail(`profile  ${target}`);
  detail(`catalog  ${base}`);

  // Every later step shells out, so find the binary before promising anything.
  const binary = findOnPath('kronk');
  const entry = profileEntry(target, await contextWindow(base, context));
  if (!binary) {
    console.error(c.red('\n  No `kronk` binary on PATH.'));
    console.error(c.grey('  Setup drives the real CLI; install it, then re-run, or do this by hand:\n'));
    console.error(c.cyan(`    kronk model pull ${base}`));
    console.error(c.grey(`\n  then add to ${config.modelConfigPath}:\n`));
    console.error(c.grey('    models:'));
    for (const l of entry) console.error(c.grey(`    ${l}`));
    console.error(c.grey('\n  and restart the server:\n'));
    console.error(c.cyan('    kronk server stop'));
    console.error(c.cyan('    kronk server start --detach\n'));
    return 1;
  }
  detail(`binary   ${binary}`);

  // 3 — is it already on disk?
  step(3, 'Checking whether the model is downloaded');
  let downloaded = false;
  if (dryRun) {
    cmd(`would run: kronk catalog show ${base} --local`);
  } else {
    const found = await catalogEntry(base);
    downloaded = found.downloaded;
    if (!found.known) detail('not in the local catalog — a pull will resolve it');
    else detail(`${found.size ?? 'unknown size'} · downloaded: ${found.downloaded}`);
  }

  // 4 — the pull.
  step(4, 'Downloading the model');
  if (downloaded) {
    detail('already downloaded — nothing to pull');
  } else if (dryRun) {
    cmd(`would run: kronk model pull ${base}`);
  } else if (!await ask(`Pull ${base} now? [y/N]`)) {
    note('Declined. Pull it later with:');
    cmd(`kronk model pull ${base}`);
    return 0;
  } else {
    line();
    const { code } = await runKronk(['model', 'pull', base], { stream: true });
    if (code !== 0) {
      console.error(c.red(`\n  kronk model pull ${base} exited ${code} — stopping here.`));
      console.error(c.grey('  Nothing has been written to model_config.yaml.\n'));
      return 1;
    }
    detail('pull finished');
  }

  // 5 — the profile.
  step(5, 'Writing the /AGENT profile');
  const wrote = await writeProfile({ path: config.modelConfigPath, entry, target, dryRun, ask });
  if (wrote.code !== 0) return wrote.code;
  if (wrote.declined) return 0;
  if (!wrote.changed) {
    line(c.green(`\n  Nothing to do — ${target} is already set up.\n`));
    return 0;
  }

  // 6 — the restart. model_config.yaml is read at server start and never again.
  step(6, 'Restarting Kronk');
  detail('model_config.yaml is read only when the server starts, so the new');
  detail('profile does nothing until Kronk is restarted.');
  if (dryRun) {
    cmd('would run: kronk server stop');
    cmd('would run: kronk server start --detach');
    line(c.grey('\n  Dry run complete — nothing was written and nothing was started.\n'));
    return 0;
  }
  if (!await ask('Restart Kronk now? [y/N]')) {
    note('Declined. The profile is written but not live. Restart with:');
    cmd('kronk server stop');
    cmd('kronk server start --detach');
    return 0;
  }

  line();
  const stopped = await runKronk(['server', 'stop'], { stream: true });
  if (stopped.code !== 0) detail(`kronk server stop exited ${stopped.code} — continuing`);
  const started = await runKronk(['server', 'start', '--detach'], { stream: true });
  if (started.code !== 0) {
    console.error(c.red(`\n  kronk server start --detach exited ${started.code}.`));
    console.error(c.grey(`  The profile is written to ${config.modelConfigPath}; start the server by hand.\n`));
    return 1;
  }

  detail('waiting for the server to answer…');
  if (!await waitForServer()) {
    console.error(c.yellow(`\n  Kronk did not answer within ${RESTART_TIMEOUT_MS / 1000}s.`));
    console.error(c.grey('  Check:  kronk server logs\n'));
    return 1;
  }
  detail('server is back');
  line(c.green(`\n  Done. ${target} is configured.`));
  line(c.grey(`  Try it:  kronk-cli -m ${target}\n`));
  return 0;
}

/** 131072 unless the model says it cannot, or the user says otherwise. */
async function contextWindow(base, override) {
  if (override !== null && override !== undefined) {
    const want = Number(override);
    const { native } = await modelLimits(base);
    if (native && want > native) {
      console.error(c.yellow(`  warning: --context ${want} exceeds ${base}'s native maximum of ${native}`));
    }
    return want;
  }
  const { native } = await modelLimits(base);
  return native && native < DEFAULT_CONTEXT ? native : DEFAULT_CONTEXT;
}

/**
 * Step 5 on its own: read, scan, back up, write. Returns the exit code and
 * whether anything changed — an unchanged file means there is nothing to
 * restart for.
 */
async function writeProfile({ path, entry, target, dryRun, ask }) {
  detail(`file  ${path}`);

  let text = null;
  try {
    text = readFileSync(path, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') {
      console.error(c.red(`\n  Cannot read ${path}`));
      console.error(c.grey(`  ${e.message}\n`));
      return { code: 1, changed: false };
    }
  }

  if (text === null) {
    const dir = dirname(path);
    if (!existsSync(dir)) {
      // Kronk creates this directory on its first run. Its absence is a
      // different problem from a missing profile, so do not paper over it.
      console.error(c.red(`\n  ${dir} does not exist, so Kronk has never run here.`));
      console.error(c.grey('  Start it once first:  kronk server start --detach'));
      console.error(c.grey('  Setup will not create Kronk\'s data directory for it.\n'));
      return { code: 1, changed: false };
    }
    return commit({ path, next: newConfig(entry), shown: ['models:', ...entry], dryRun, ask, made: 'created' });
  }

  const scan = scanConfig(text, target);

  if (scan.kind === 'present') {
    detail(`${target} is already a profile in this file — leaving it alone`);
    return { code: 0, changed: false };
  }
  if (scan.kind === 'refuse') {
    console.error(c.red(`\n  Refusing to edit ${path}:`));
    console.error(c.grey(`  ${scan.reason}, so there is no unambiguous place to add the profile.`));
    console.error(c.grey('  Nothing was written. Add this to the right "models:" section by hand:'));
    printBlock(entry);

    return { code: 1, changed: false };
  }

  const shown = scan.kind === 'append' ? ['models:', ...entry] : entry;
  return commit({ path, next: applyEntry(text, scan, entry), shown, dryRun, ask, made: 'updated' });
}

async function commit({ path, next, shown, dryRun, ask, made }) {
  note(`This block will be ${made === 'created' ? 'written' : 'added'}:`);
  printBlock(shown);

  if (dryRun) {
    cmd(`would ${made === 'created' ? 'create' : 'update'}: ${path}`);
    cmd(`would back up first: ${path}.bak…`);
    return { code: 0, changed: true };
  }

  if (!await ask(`${made === 'created' ? 'Create' : 'Update'} ${path}? [y/N]`)) {
    note('Declined. Nothing was written — paste the block above by hand if you prefer.');
    return { code: 0, changed: false, declined: true };
  }

  if (made === 'created') {
    detail('no backup needed — the file does not exist yet');
  } else {
    try {
      detail(`backup  ${backupFile(path)}`);
    } catch (e) {
      console.error(c.red(`\n  Cannot back up ${path} — refusing to write without one.`));
      console.error(c.grey(`  ${e.message}\n`));
      return { code: 1, changed: false };
    }
  }

  try {
    writeFileSync(path, next, 'utf8');
  } catch (e) {
    console.error(c.red(`\n  Cannot write ${path}`));
    console.error(c.grey(`  ${e.message}\n`));
    return { code: 1, changed: false };
  }
  detail(`${made} ${path}`);
  return { code: 0, changed: true };
}

/** Poll /models until the restarted server answers, or give up and say so. */
async function waitForServer() {
  const deadline = Date.now() + RESTART_TIMEOUT_MS;
  for (;;) {
    try {
      await listModels();
      return true;
    } catch {
      // still down
    }
    if (Date.now() >= deadline) return false;
    await sleep(RESTART_POLL_MS);
  }
}
