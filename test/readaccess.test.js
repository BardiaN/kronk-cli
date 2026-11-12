import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, rmSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decideRead, within, secretHit, secretsUnder, isWide, grantFolder, parseReadAnswer, readPromptHead, readPromptChoices, refusalText,
} from '../src/readaccess.js';
import {
  runTool, session, readCheck, grantReadFolder, consentFile, readGrantLines, TOOLS,
} from '../src/tools.js';
import { secretPaths } from '../src/sandbox.js';
import { runTurn, SYSTEM } from '../src/agent.js';
import { runTask } from '../src/subagent.js';
import { config } from '../src/config.js';
import { contextLines } from '../src/ui.js';
import { PassThrough } from 'node:stream';
import { deferredPrompt } from '../src/prompt.js';
import { startStub } from './fixtures/kronk-stub.js';

const ROOT = '/work/project';
const base = { root: ROOT, secrets: ['/home/u/.ssh', '/home/u/.npmrc'] };

// ── the pure decision ─────────────────────────────────────────────────────────

test('a path inside the root is untouched, whoever is there to ask', () => {
  assert.deepEqual(decideRead({ ...base, abs: `${ROOT}/a/b.txt` }), { action: 'allow', reason: 'inside' });
  assert.deepEqual(decideRead({ ...base, abs: ROOT, kind: 'list_dir' }), { action: 'allow', reason: 'inside' });
});

test('a lookalike sibling is outside: /work/project-x is not under /work/project', () => {
  assert.equal(within('/work/project-x/a', ROOT), false);
  assert.equal(within('/work/..foo/a', '/work'), true, 'a directory called ..foo is a child, not a parent hop');
  assert.equal(decideRead({ ...base, abs: '/work/project-x/a' }).action, 'refuse');
});

test('outside and unruled: ask when someone is there, refuse when not', () => {
  const abs = '/home/u/Downloads/compteur.jpeg';
  assert.deepEqual(decideRead({ ...base, abs, interactive: true }), { action: 'ask', reason: 'outside' });
  assert.deepEqual(decideRead({ ...base, abs, interactive: false }), { action: 'refuse', reason: 'noninteractive' });
});

test('a granted folder covers its subfolders and not its siblings', () => {
  const folders = ['/home/u/Downloads'];
  const run = (abs) => decideRead({ ...base, abs, folders, interactive: true });
  assert.equal(run('/home/u/Downloads/a.jpeg').action, 'allow');
  assert.equal(run('/home/u/Downloads/sub/deep/a.jpeg').action, 'allow');
  assert.equal(run('/home/u/Downloads').action, 'allow', 'the folder itself, for list_dir');
  assert.equal(run('/home/u/Documents/a.jpeg').action, 'ask');
  assert.equal(run('/home/u/Downloads-old/a.jpeg').action, 'ask');
  assert.equal(run('/home/u/a.jpeg').action, 'ask', 'the parent is not covered');
});

test('one yes covers one path; an attached file covers that file only', () => {
  const abs = '/home/u/x.png';
  assert.equal(decideRead({ ...base, abs, once: [abs] }).reason, 'granted');
  assert.equal(decideRead({ ...base, abs, once: ['/home/u/y.png'], interactive: true }).action, 'ask');
  assert.equal(decideRead({ ...base, abs, files: [abs] }).reason, 'granted');
  assert.equal(decideRead({ ...base, abs: '/home/u/y.png', files: [abs] }).action, 'refuse');
});

test('a declined path is not asked about again', () => {
  const abs = '/home/u/x.png';
  assert.deepEqual(decideRead({ ...base, abs, declined: [abs], interactive: true }), { action: 'refuse', reason: 'declined' });
});

test('a credential store is refused before any grant is read', () => {
  const abs = '/home/u/.ssh/id_ed25519';
  const grants = { folders: ['/home/u', '/home/u/.ssh'], files: [abs], once: [abs], interactive: true };
  assert.deepEqual(decideRead({ ...base, abs, ...grants }), { action: 'refuse', reason: 'secret' });
  assert.equal(decideRead({ ...base, abs: '/home/u/.npmrc', ...grants }).reason, 'secret');
  // A listing names entries and reads nothing; a search walks the tree beneath it.
  assert.equal(decideRead({ ...base, abs: '/home/u', kind: 'list_dir', interactive: true }).action, 'ask');
  assert.equal(decideRead({ ...base, abs: '/home/u', kind: 'search', interactive: true }).action, 'ask');
  assert.deepEqual(secretsUnder('/home/u', base.secrets), base.secrets, 'a search from there leaves them out');
  assert.deepEqual(secretsUnder('/home/u/.ssh', base.secrets), [], 'the store itself is refused, not skipped');
  assert.equal(secretHit('/home/u/notes', 'search', base.secrets), null);
});

test('grantFolder: the containing folder for a file, the folder itself for a listing, never /', () => {
  assert.equal(grantFolder('/a/b/c.png', 'read_file', false), '/a/b');
  assert.equal(grantFolder('/a/b', 'list_dir', true), '/a/b');
  assert.equal(grantFolder('/a/b', 'search', true), '/a/b');
  assert.equal(grantFolder('/a/b/f.txt', 'search', false), '/a/b');
  assert.equal(grantFolder('/etc', 'read_file', false), null);
  assert.equal(grantFolder('/', 'list_dir', true), null);
});

// ── the texts ─────────────────────────────────────────────────────────────────

test('the prompt names the root and the path, and answers parse safely', () => {
  assert.equal(readPromptHead('/Users/x/Desktop', '/Users/x/Downloads/c.jpeg'),
    'read outside /Users/x/Desktop: /Users/x/Downloads/c.jpeg');
  assert.match(readPromptChoices('/Users/x/Downloads'), /\[y\] yes once.*\[f\] the folder \/Users\/x\/Downloads for this session.*\[N\] no/);
  assert.doesNotMatch(readPromptChoices(null), /folder/);
  assert.equal(parseReadAnswer('y'), 'yes');
  assert.equal(parseReadAnswer(' YES '), 'yes');
  assert.equal(parseReadAnswer('f'), 'folder');
  assert.equal(parseReadAnswer('f', false), 'no', 'a folder that was not offered cannot be chosen');
  for (const a of ['', 'n', 'no', 'always', 'yy', undefined]) assert.equal(parseReadAnswer(a), 'no');
});

test('each refusal tells the model what to do next', () => {
  const none = refusalText('noninteractive', '/o/x.png', '/r');
  assert.match(none, /\/o\/x\.png is outside the launch folder \(\/r\)/);
  assert.match(none, /start kronk-cli in a folder that contains it/);
  assert.match(none, /\/file <path>/);
  assert.match(none, /Do not retry/);
  const no = refusalText('declined', '/o/x.png', '/r');
  assert.match(no, /user declined/);
  assert.match(no, /do not retry this path/);
  assert.match(no, /do not suggest copying, moving or dragging/);
  assert.match(no, /ask the user what they would like to do instead/);
  assert.match(refusalText('secret', '/h/.ssh/k', '/r'), /credential store/);
});

test('the system prompt and the tool descriptions say a path outside will ask', () => {
  assert.match(SYSTEM, /outside the launch folder/);
  assert.match(SYSTEM, /never tell them to copy, move or drag/);
  for (const name of ['read_file', 'list_dir', 'search']) {
    const t = TOOLS.find((x) => x.function.name === name);
    assert.match(t.function.description, /outside the launch folder/, name);
  }
  for (const name of ['write_file', 'edit_file', 'bash']) {
    const t = TOOLS.find((x) => x.function.name === name);
    assert.doesNotMatch(t.function.description, /outside the launch folder/, name);
  }
});

test('/context lists what was opened up', () => {
  const lines = contextLines({ messageTokens: 1, toolTokens: 1, window: 1000, messages: 2, root: '/r',
    reads: ['/o/dl/ (folder)'] }).join('\n');
  assert.match(lines, /readable outside \/r this session/);
  assert.match(lines, /\/o\/dl\/ \(folder\)/);
  assert.doesNotMatch(contextLines({ messageTokens: 1, toolTokens: 1, window: 1000, messages: 2 }).join('\n'), /readable outside/);
});

// ── the tool layer, on a real filesystem ──────────────────────────────────────

const dir = () => realpathSync(mkdtempSync(join(tmpdir(), 'kronk-ra-')));

/** A launch root, a sibling folder with a file in it, and a clean session. */
async function world(fn) {
  const parent = dir();
  const root = join(parent, 'Desktop');
  const other = join(parent, 'Downloads');
  mkdirSync(root);
  mkdirSync(other);
  writeFileSync(join(other, 'meter.txt'), 'index 04821');
  const saved = { ...session };
  Object.assign(session, {
    root, cwd: root, readFolders: new Set(), readFiles: new Set(), readDeclined: new Set(),
  });
  try { return await fn({ parent, root, other }); } finally {
    Object.assign(session, saved);
    rmSync(parent, { recursive: true, force: true });
  }
}

test('with nobody to ask, read_file, list_dir and search refuse and say why', () => world(async ({ other, root }) => {
  for (const [name, args] of [
    ['read_file', { path: join(other, 'meter.txt') }],
    ['list_dir', { path: other }],
    ['search', { pattern: 'index', path: other }],
  ]) {
    const r = await runTool(name, args);
    assert.match(r, /^error: .* is outside the launch folder/, name);
    assert.ok(r.includes(root), 'names the launch folder');
    assert.match(r, /\/file <path>/);
  }
}));

test('a yes for this call reads the file, and only that call', () => world(async ({ other }) => {
  const p = join(other, 'meter.txt');
  assert.equal(await runTool('read_file', { path: p }, { allowRead: new Set([p]) }), 'index 04821');
  assert.match(await runTool('read_file', { path: p }), /^error:/, 'the next call is refused again');
}));

test('a granted folder lets all three tools in, for subfolders too, not for a sibling', () => world(async ({ parent, other }) => {
  mkdirSync(join(other, 'sub'));
  writeFileSync(join(other, 'sub', 'deep.txt'), 'deep index');
  mkdirSync(join(parent, 'Documents'));
  writeFileSync(join(parent, 'Documents', 'd.txt'), 'doc');
  grantReadFolder(other);
  assert.equal(await runTool('read_file', { path: join(other, 'meter.txt') }), 'index 04821');
  assert.match(await runTool('list_dir', { path: other }), /meter\.txt/);
  assert.match(await runTool('search', { pattern: 'deep', path: other }), /deep\.txt/);
  assert.equal(await runTool('read_file', { path: join(other, 'sub', 'deep.txt') }), 'deep index');
  assert.match(await runTool('read_file', { path: join(parent, 'Documents', 'd.txt') }), /^error:.*outside the launch folder/);
}));

test('symlinks are resolved first: into a granted folder is covered, out of one is not', () => world(async ({ parent, root, other }) => {
  grantReadFolder(other);
  // A link in the launch root pointing into the granted folder reads fine...
  symlinkSync(join(other, 'meter.txt'), join(root, 'link-in'));
  assert.equal(await runTool('read_file', { path: 'link-in' }), 'index 04821');
  // ...and a link inside the granted folder pointing at an ungranted one does not.
  const elsewhere = join(parent, 'Elsewhere');
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, 's.txt'), 'secret-ish');
  symlinkSync(join(elsewhere, 's.txt'), join(other, 'link-out'));
  assert.match(await runTool('read_file', { path: join(other, 'link-out') }), /^error:.*outside the launch folder/);
}));

test('a file the user attached with /file is readable, and nothing next to it', () => world(async ({ other }) => {
  writeFileSync(join(other, 'sibling.txt'), 'nope');
  consentFile(join(other, 'meter.txt'));
  assert.equal(await runTool('read_file', { path: join(other, 'meter.txt') }), 'index 04821');
  assert.match(await runTool('read_file', { path: join(other, 'sibling.txt') }), /^error:/);
  assert.deepEqual(readGrantLines(), [`${join(other, 'meter.txt')} (attached)`]);
}));

test('a leading ~/ means the home folder for a read', () => world(async ({ parent }) => {
  const home = process.env.HOME;
  process.env.HOME = parent;
  try {
    assert.match(await runTool('read_file', { path: '~/Downloads/meter.txt' }), /^error: .*Downloads\/meter\.txt is outside/);
    assert.equal(readCheck('~/Downloads/meter.txt', { interactive: true }).action, 'ask');
  } finally { process.env.HOME = home; }
}));

test('a credential store stays refused whatever was granted, and reads still cannot write', () => world(async ({ parent }) => {
  const home = process.env.HOME;
  process.env.HOME = parent;
  try {
    mkdirSync(join(parent, '.ssh'));
    writeFileSync(join(parent, '.ssh', 'id_test'), 'PRIVATE KEY');
    writeFileSync(join(parent, '.npmrc'), '//registry:_authToken=abc');
    grantReadFolder(parent);
    grantReadFolder(join(parent, '.ssh'));
    consentFile(join(parent, '.ssh', 'id_test'));
    const r = await runTool('read_file', { path: join(parent, '.ssh', 'id_test') }, { allowRead: new Set([join(parent, '.ssh', 'id_test')]) });
    assert.match(r, /credential store/);
    assert.doesNotMatch(r, /PRIVATE KEY/);
    assert.match(await runTool('read_file', { path: join(parent, '.npmrc') }), /credential store/);
    // A search from above leaves the store out rather than refusing the lot.
    assert.doesNotMatch(await runTool('search', { pattern: 'KEY', path: parent }), /PRIVATE|id_test/);
    assert.match(await runTool('search', { pattern: 'KEY', path: join(parent, '.ssh') }), /credential store/);
    assert.deepEqual(secretPaths(parent).filter((p) => p.endsWith('.ssh')), [join(parent, '.ssh')]);
    // And a grant never reaches a write.
    const w = await runTool('write_file', { path: join(parent, 'Downloads', 'w.txt'), content: 'x' });
    assert.match(w, /refusing to touch path outside/);
    const e = await runTool('edit_file', { path: join(parent, 'Downloads', 'meter.txt'), old_string: 'index', new_string: 'x' });
    assert.match(e, /refusing to touch path outside/);
  } finally { process.env.HOME = home; }
}));

test('a FIFO or device outside the root is not read', () => world(async () => {
  const p = '/dev/null';
  const r = await runTool('read_file', { path: p }, { allowRead: new Set([p]) });
  assert.match(r, /is not a regular file/);
}));

// ── the agent loop ────────────────────────────────────────────────────────────

const MODEL = 'stub/Model-Q4/AGENT';

async function loop(calls, extra = {}) {
  const stub = await startStub({ ids: [MODEL], turns: [{ calls }] });
  const saved = { url: config.baseUrl, log: console.log, out: process.stdout.write };
  config.baseUrl = stub.url;
  console.log = () => {};
  const messages = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'go' }];
  try {
    await runTurn({ messages, model: MODEL, approve: async () => true, out: () => {}, ...extra });
  } finally {
    console.log = saved.log;
    config.baseUrl = saved.url;
    stub.close();
  }
  return messages.filter((m) => m.role === 'tool').map((m) => m.content);
}

test('yes once: asked with the path and the folder, the file is read, the next read asks again', () => world(async ({ other }) => {
  const p = join(other, 'meter.txt');
  const asked = [];
  const out = await loop([{ name: 'read_file', args: { path: p } }, { name: 'read_file', args: { path: p } }], {
    readAccess: async (q) => { asked.push(q); return 'yes'; },
  });
  assert.deepEqual(out, ['index 04821', 'index 04821']);
  assert.equal(asked.length, 2, 'a yes covers one call');
  assert.equal(asked[0].path, p);
  assert.equal(asked[0].folder, other);
  assert.equal(asked[0].root, session.root);
}));

test('folder: asked once, and every later read under it goes through', () => world(async ({ other }) => {
  writeFileSync(join(other, 'two.txt'), 'second');
  const asked = [];
  const out = await loop([
    { name: 'read_file', args: { path: join(other, 'meter.txt') } },
    { name: 'read_file', args: { path: join(other, 'two.txt') } },
    { name: 'list_dir', args: { path: other } },
  ], { readAccess: async (q) => { asked.push(q.path); return 'folder'; } });
  assert.equal(asked.length, 1);
  assert.equal(out[0], 'index 04821');
  assert.equal(out[1], 'second');
  assert.match(out[2], /meter\.txt/);
  assert.deepEqual(readGrantLines(), [`${other}/ (folder)`]);
}));

test('no: the model is told the user declined, and the same path is not asked about again', () => world(async ({ other }) => {
  const p = join(other, 'meter.txt');
  const asked = [];
  const out = await loop([{ name: 'read_file', args: { path: p } }, { name: 'read_file', args: { path: p } }], {
    readAccess: async (q) => { asked.push(q.path); return 'no'; },
  });
  assert.equal(asked.length, 1);
  for (const r of out) {
    assert.match(r, /^error: the user declined to let you read /);
    assert.match(r, /do not retry this path/);
    assert.match(r, /do not suggest copying/);
  }
}));

test('no readAccess (pipe, --deny, rescue): refused with the explanation, nothing asked', () => world(async ({ other }) => {
  const out = await loop([{ name: 'read_file', args: { path: join(other, 'meter.txt') } }]);
  assert.match(out[0], /^error: .* is outside the launch folder .*nobody is available/);
}));

test('a refuse answer is not a decline: it is not remembered as one', () => world(async ({ other }) => {
  const p = join(other, 'meter.txt');
  await loop([{ name: 'read_file', args: { path: p } }], { readAccess: async () => 'refuse' });
  assert.equal(session.readDeclined.size, 0);
}));

test('batched reads are asked one at a time, never two questions open at once', () => world(async ({ other }) => {
  writeFileSync(join(other, 'b.txt'), 'bee');
  let open = 0;
  let overlapped = false;
  const out = await loop([
    { name: 'read_file', args: { path: join(other, 'meter.txt') } },
    { name: 'read_file', args: { path: join(other, 'b.txt') } },
  ], {
    readAccess: async () => {
      open += 1;
      if (open > 1) overlapped = true;
      await new Promise((r) => setTimeout(r, 15));
      open -= 1;
      return 'yes';
    },
  });
  assert.equal(overlapped, false);
  assert.deepEqual(out, ['index 04821', 'bee']);
}));

test('a sub-agent\'s read goes to the same question, through the caller\'s shield', async () => {
  const seen = [];
  const readAccess = async () => 'yes';
  const run = async (opts) => { seen.push(opts); return [{ role: 'assistant', content: 'done' }]; };
  await runTask({ agent: 'explore', prompt: 'look at /elsewhere' }, {
    run, model: 'm', approve: async () => true, grant: async () => 'no', readAccess,
    out: () => {}, pane: () => ({ enabled: false, open() {}, line() {}, step() {}, close() {}, shield: (f) => f }),
  });
  assert.equal(seen[0].readAccess, readAccess);
  seen.length = 0;
  await runTask({ agent: 'explore', prompt: 'x' }, {
    run, model: 'm', approve: async () => true, grant: async () => 'no',
    out: () => {}, pane: () => ({ enabled: false, open() {}, line() {}, step() {}, close() {}, shield: (f) => f }),
  });
  assert.equal(seen[0].readAccess, undefined, 'no question to forward when there is nobody to ask');
});

// ── review fixes ──────────────────────────────────────────────────────────────

test('a credential store is matched without regard to case where the filesystem does the same', () => {
  assert.equal(secretHit('/home/u/.SSH/id_rsa', 'read_file', ['/home/u/.ssh']), null, 'exact match by default');
  assert.equal(secretHit('/home/u/.SSH/id_rsa', 'read_file', ['/home/u/.ssh'], true), '/home/u/.ssh');
  assert.equal(decideRead({ ...base, abs: '/home/u/.NPMRC', ci: true, interactive: true }).reason, 'secret');
});

test('~/.SSH/id_rsa, .NPMRC and .NETRC are refused on a case-insensitive disk, whatever was granted', () => world(async ({ parent }) => {
  const home = process.env.HOME;
  process.env.HOME = parent;
  try {
    mkdirSync(join(parent, '.ssh'));
    writeFileSync(join(parent, '.ssh', 'id_rsa'), 'PRIVATE KEY');
    writeFileSync(join(parent, '.npmrc'), 'TOKEN');
    if (!existsSync(join(parent, '.SSH'))) return;   // a case-sensitive disk: .SSH is simply another name
    grantReadFolder(parent);
    for (const p of ['.SSH/id_rsa', '.NPMRC', '.Ssh']) {
      const r = await runTool(p === '.Ssh' ? 'list_dir' : 'read_file', { path: join(parent, p) });
      assert.match(r, /credential store/, p);
    }
    assert.equal(readCheck(join(parent, '.SSH', 'id_rsa'), { interactive: true }).reason, 'secret');
  } finally { process.env.HOME = home; }
}));

test('launched in the home folder, the credential stores are not "inside": refused, while project files read', () => world(async ({ parent }) => {
  const home = process.env.HOME;
  process.env.HOME = parent;
  const saved = { root: session.root, cwd: session.cwd };
  session.root = parent;
  session.cwd = parent;
  try {
    mkdirSync(join(parent, '.ssh'));
    writeFileSync(join(parent, '.ssh', 'id_rsa'), 'PRIVATE KEY');
    writeFileSync(join(parent, '.npmrc'), 'NPM TOKEN');
    writeFileSync(join(parent, 'notes.txt'), 'KEY notes');
    assert.equal(await runTool('read_file', { path: '.ssh/id_rsa' }).then((r) => /credential store/.test(r)), true);
    assert.match(await runTool('read_file', { path: '.npmrc' }), /credential store/);
    assert.match(await runTool('list_dir', { path: '.ssh' }), /credential store/);
    assert.equal(await runTool('read_file', { path: 'notes.txt' }), 'KEY notes');
    assert.match(await runTool('list_dir', { path: '.' }), /notes\.txt/);
    const found = await runTool('search', { pattern: 'KEY', path: '.' });
    assert.match(found, /notes\.txt/);
    assert.doesNotMatch(found, /PRIVATE|id_rsa/, found);
  } finally { process.env.HOME = home; Object.assign(session, saved); }
}));

test('the home folder, and anything above it, is never offered as a folder grant', () => {
  assert.equal(grantFolder('/home/u/x.png', 'read_file', false, '/home/u'), null, 'home itself');
  assert.equal(grantFolder('/home/x.png', 'read_file', false, '/home/u'), null, 'a parent of home');
  assert.equal(grantFolder('/home/u/Downloads/x.png', 'read_file', false, '/home/u'), '/home/u/Downloads');
  assert.equal(grantFolder('/home/u', 'list_dir', true, '/home/u'), null);
  assert.equal(grantFolder('/home/other', 'list_dir', true, '/home/u'), '/home/other');
  assert.equal(isWide('/home', '/home/u'), true);
  assert.equal(isWide('/home/u/Documents', '/home/u'), false);
  assert.match(readPromptChoices(null, true), /whole-home grant is not offered/);
  assert.doesNotMatch(readPromptChoices(null, true), /\[f\]/);
});

test('readCheck offers no folder for the home folder, and says it is wide', () => world(async ({ parent }) => {
  const home = process.env.HOME;
  process.env.HOME = parent;
  try {
    writeFileSync(join(parent, 'a.png'), 'x');
    const v = readCheck(join(parent, 'a.png'), { interactive: true });
    assert.equal(v.action, 'ask');
    assert.equal(v.folder, null);
    assert.equal(v.wide, true);
    const w = readCheck(join(parent, 'Downloads', 'meter.txt'), { interactive: true });
    assert.equal(w.folder, join(parent, 'Downloads'));
    assert.equal(w.wide, false);
  } finally { process.env.HOME = home; }
}));

test('search treats a pattern that starts with a dash as a pattern, not as an option', () => world(async ({ root }) => {
  writeFileSync(join(root, 'f.txt'), 'a -needle here\n');
  assert.match(await runTool('search', { pattern: '-needle' }), /f\.txt:1:a -needle here/);
  assert.match(await runTool('search', { pattern: '--files' }), /no matches/);
}));

// ── typed-ahead lines never answer a guarding prompt ──────────────────────────

function pty() {
  const input = new PassThrough();
  const output = new PassThrough();
  output.on('data', () => {});
  return { input, output, rl: deferredPrompt({ input, output }) };
}
const tick = () => new Promise((r) => setTimeout(r, 20));

test('fresh: lines queued before the question are parked, not taken as the answer', async () => {
  const { input, rl } = pty();
  const first = rl.question('› ');
  input.write('read the file\ny\nnext prompt\n');   // a paste: three lines at once
  assert.equal(await first, 'read the file');
  await tick();
  assert.equal(rl.pending, 2, 'the rest waited in the queue');
  let settled = false;
  const answer = rl.question('allow? ', { fresh: true }).then((l) => { settled = true; return l; });
  await tick();
  assert.equal(settled, false, 'the pasted y did not answer it');
  assert.equal(rl.pending, 0, 'parked while the question is open');
  input.write('n\n');
  assert.equal(await answer, 'n', 'only a line entered afterwards does');
  assert.equal(rl.pending, 2, 'and the parked lines are back');
  assert.equal(await rl.question('› '), 'y', 'in the order they came');
  assert.equal(await rl.question('› '), 'next prompt');
  rl.close();
});

test('without fresh, typing ahead still answers, as it always did', async () => {
  const { input, rl } = pty();
  const first = rl.question('› ');
  input.write('a\nb\n');
  await first;
  await tick();
  assert.equal(await rl.question('› '), 'b');
  rl.close();
});
