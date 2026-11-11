import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clip, safe, session, runBash, runTool, killAllJobs, backgroundJobs, readJob, applyEdit, preview, describe, TOOLS, NEEDS_APPROVAL, mcpNeedsApproval } from '../src/tools.js';

// realpath, because macOS maps /var onto /private/var and the shell reports the latter
const root = realpathSync(mkdtempSync(join(tmpdir(), 'kronk-tools-')));
session.root = root;
session.cwd = root;

test('clip leaves short text alone', () => {
  assert.equal(clip('hello'), 'hello');
});

test('clip trims the middle, never the tail', () => {
  const body = `HEAD${'x'.repeat(60_000)}TAIL_ERROR_HERE`;
  const out = clip(body);
  assert.ok(out.startsWith('HEAD'), 'keeps the head');
  assert.ok(out.endsWith('TAIL_ERROR_HERE'), 'keeps the tail — errors live there');
  assert.match(out, /elided from the middle/);
  assert.ok(out.length < body.length);
});

test('safe resolves inside the root', () => {
  assert.equal(safe('a/b.txt'), join(root, 'a/b.txt'));
});

test('safe refuses to escape the root', () => {
  assert.throws(() => safe('../outside.txt'), /refusing to touch path outside/);
  assert.throws(() => safe('/etc/passwd'), /refusing to touch path outside/);
});

test('bash reports a real exit code, not the marker’s', async () => {
  const out = await runBash('exit 7');
  assert.match(out, /^error: exit code 7/);
});

test('bash surfaces stderr on failure', async () => {
  const out = await runBash('echo boom >&2; exit 1');
  assert.match(out, /exit code 1/);
  assert.match(out, /boom/);
});

test('the result handed to messages is complete, not capped to the display line count', async () => {
  // Display caps a failed result at 20 lines after the first (see
  // toolResultLines in src/ui.js). The string this returns is what agent.js
  // pushes into `messages` verbatim, so it must carry every line the display
  // cap would otherwise hide, plus the full `stderr:` block.
  const out = await runBash("for i in $(seq 1 50); do echo \"err $i\" >&2; done; exit 1");
  assert.match(out, /^error: exit code 1/);
  assert.match(out, /stderr:/);
  assert.match(out, /err 1\n/, 'first stderr line survives');
  assert.match(out, /err 50/, 'last stderr line survives — no 20-line cap leaked in');
  assert.equal(out.split('\n').length > 22, true, 'the full body is longer than the display cap');
});

test('bash returns plain output on success', async () => {
  assert.equal((await runBash('echo fine')).trim(), 'fine');
});

test('cd persists to the next call', async () => {
  writeFileSync(join(root, 'marker.txt'), 'x');
  await runBash('mkdir -p nested && cd nested');
  const pwd = (await runBash('pwd')).trim();
  assert.ok(pwd.endsWith('/nested'), `expected to still be in nested, got ${pwd}`);
  session.cwd = root;
});

test('cd cannot escape the root', async () => {
  await runBash('cd /tmp');
  assert.equal(session.cwd, root, 'session cwd must stay inside the launch root');
});

test('a timeout moves the command to the background instead of killing it', async () => {
  const out = await runBash('echo started; sleep 10', { timeoutMs: 400 });
  assert.match(out, /still running after/);
  assert.match(out, /NOT killed/);
  assert.match(out, /started/, 'output printed before the timeout survives');
  const id = out.match(/job (bg\d+)/)[1];
  assert.equal(backgroundJobs(), 1);
  killAllJobs();
  assert.equal(backgroundJobs(), 0);
  assert.match(await runTool('bash_output', { id }), /no background job/);
});

test('live progress never shows the internal cwd marker', async () => {
  const seen = [];
  const out = await runBash('echo hello', { onProgress: (p) => seen.push(p) });
  assert.equal(out.trim(), 'hello');
  assert.ok(seen.length >= 1);
  for (const p of seen) assert.ok(!p.lastLine.includes('__KRONK_CWD__'), `leaked: ${p.lastLine}`);
  assert.equal(seen.at(-1).lastLine, 'hello');
  assert.equal(seen.at(-1).bytes, 'hello\n'.length, 'the marker is not counted in the size estimate');
});

test('bash_output of a job that has finished does not show the cwd marker', async () => {
  const out = await runBash('echo started; sleep 0.6; echo finished', { timeoutMs: 200 });
  assert.ok(!out.includes('__KRONK_CWD__'));
  const id = out.match(/job (bg\d+)/)[1];
  await new Promise((r) => setTimeout(r, 1200));
  const read = await runTool('bash_output', { id });
  assert.match(read, /exited with code 0/);
  assert.match(read, /finished/);
  assert.ok(!read.includes('__KRONK_CWD__'), read);
});

test('built-in approval gating covers exactly the mutating tools', () => {
  assert.ok(NEEDS_APPROVAL.has('write_file'));
  assert.ok(NEEDS_APPROVAL.has('edit_file'));
  assert.ok(NEEDS_APPROVAL.has('bash'));
  assert.ok(!NEEDS_APPROVAL.has('read_file'));
});

test('every tool declares a JSON schema', () => {
  for (const t of TOOLS) {
    assert.equal(t.type, 'function');
    assert.equal(typeof t.function.name, 'string');
    assert.equal(t.function.parameters.type, 'object');
  }
});

test('MCP approval keys off write-ish verbs', () => {
  assert.ok(mcpNeedsApproval('argocd__delete_application'));
  assert.ok(mcpNeedsApproval('eks__apply_yaml'));
  assert.ok(mcpNeedsApproval('github__create_issue'));
  assert.ok(!mcpNeedsApproval('nx__nx_docs'));
  assert.ok(!mcpNeedsApproval('argocd__list_applications'));
  assert.ok(!mcpNeedsApproval('eks__get_pod_logs'));
});

// ── where a command actually ran ──────────────────────────────────────────────
// realpathSync every expected path: on macOS the shell reports /private/var
// while the raw mkdtempSync return says /var, so comparing against the raw path
// fails for reasons that have nothing to do with what is being tested.
const parent = realpathSync(join(root, '..'));

test('a failing command that left the root reports where it really ran', async () => {
  const out = await runBash('cd .. && exit 1');
  assert.ok(out.split('\n').includes(`ran in: ${parent}`), out);
  assert.ok(!out.includes(`cwd: ${root}`), 'the stale session cwd must not be reported');
});

test('a successful command that left the root says so', async () => {
  const out = await runBash('cd .. && true');
  assert.ok(out.split('\n').includes(`ran in: ${parent}`), out);
  assert.match(out, /note: this command left the launch root/);
});

test('a successful in-root command is left exactly as it was', async () => {
  assert.equal(await runBash('true'), '(no output)');
});

test('leaving the root does not move the session', async () => {
  await runBash('cd .. && pwd');
  assert.equal(session.cwd, root);
});

test('an in-root cd still persists to the next call', async () => {
  await runBash('mkdir -p sub && cd sub');
  assert.equal((await runBash('pwd')).trim(), join(root, 'sub'));
  session.cwd = root;
});

test('a command that replaces its own shell reports the directory as unknown', async () => {
  const out = await runBash('exec false');
  assert.match(out, /^ran in: .+ \(final directory unknown\)$/m);
});

test('where it ran is printed before the output blocks, not after', async () => {
  const out = await runBash('cd .. && echo boom >&2; exit 1');
  assert.ok(out.indexOf('ran in:') < out.indexOf('stderr:'), out);
  assert.ok(out.indexOf('note: this command left') < out.indexOf('stderr:'), out);
  assert.match(out, /boom/, 'output is reported, not suppressed');
});

// ---- search, on the branch CI cannot reach ---------------------------------
//
// `search` prefers ripgrep and falls back to grep. CI images ship ripgrep, so
// the fallback never runs there — and it was the fallback that reported "no
// matches" as a failed command for every machine without an `rg` binary. These
// shadow `rg` with a stub that fails, so the fallback is what runs.

const shadowRg = (exitCode) => {
  const dir = mkdtempSync(join(tmpdir(), 'kronk-norg-'));
  writeFileSync(join(dir, 'rg'), `#!/bin/sh\nexit ${exitCode}\n`, { mode: 0o700 });
  const saved = process.env.PATH;
  process.env.PATH = `${dir}:${saved}`;
  return () => { process.env.PATH = saved; };
};

test('a search that matches nothing is an answer, not a failed command', async () => {
  writeFileSync(join(root, 'haystack.txt'), 'alpha\nbravo\n');
  const restore = shadowRg(2);                      // force the grep fallback
  try {
    const out = await runTool('search', { pattern: 'zzz-definitely-absent', path: 'haystack.txt' }, {});
    assert.equal(out, '(no matches)', 'grep exits 1 for no matches, exactly as rg does');
    assert.doesNotMatch(out, /error/, 'told it failed, the model stops believing the tool');
  } finally { restore(); }
});

test('the grep fallback keeps the file:line prefix the description promises', async () => {
  writeFileSync(join(root, 'haystack.txt'), 'alpha\nbravo\n');
  const restore = shadowRg(2);
  try {
    const out = await runTool('search', { pattern: 'bravo', path: 'haystack.txt' }, {});
    // GNU grep drops the filename when given exactly one file and BSD grep does
    // not, so without -H this passes on macOS and fails on Linux.
    assert.match(out, /haystack\.txt:2:bravo/);
  } finally { restore(); }
});

test('the fallback reads alternation as a pattern, not as three literal characters', async () => {
  writeFileSync(join(root, 'haystack.txt'), 'alpha\nbravo\n');
  const restore = shadowRg(2);
  try {
    // The tool describes itself as ripgrep-style, so this is what models write.
    const out = await runTool('search', { pattern: 'alpha|bravo', path: 'haystack.txt' }, {});
    // Assert on the file:line prefixes, not on the words. Without -E this
    // search matches nothing, and the old error message quoted the pattern
    // back — so `match(/alpha/)` passed on the failure it was meant to catch.
    assert.doesNotMatch(out, /error/);
    assert.match(out, /haystack\.txt:1:alpha/);
    assert.match(out, /haystack\.txt:2:bravo/);
  } finally { restore(); }
});

test('a search with no rg binary at all behaves the same as one with a broken rg', async () => {
  writeFileSync(join(root, 'haystack.txt'), 'alpha\nbravo\n');
  const restore = shadowRg(127);                    // stands in for ENOENT
  try {
    assert.equal(await runTool('search', { pattern: 'nope-not-here', path: 'haystack.txt' }, {}), '(no matches)');
  } finally { restore(); }
});

// ── edit_file ─────────────────────────────────────────────────────────────────
test('applyEdit replaces a unique match and reports misses and ambiguity', () => {
  assert.deepEqual(applyEdit('a b c', 'b', 'X'), { text: 'a X c', count: 1 });
  assert.match(applyEdit('a b c', 'z', 'X').error, /0 matches/);
  assert.match(applyEdit('b b', 'b', 'X').error, /matches 2 places/);
  assert.deepEqual(applyEdit('b b', 'b', 'X', true), { text: 'X X', count: 2 });
  assert.equal(applyEdit('abc', 'b', '$&').text, 'a$&c', 'new_string is literal');
  assert.ok(applyEdit('abc', '', 'X').error);
  assert.ok(applyEdit('abc', 'b', 'b').error);
});

test('edit_file edits in place, refuses a missing file, and stays in the root', async () => {
  writeFileSync(join(root, 'e.txt'), 'one\ntwo\nthree\n');
  assert.match(await runTool('edit_file', { path: 'e.txt', old_string: 'two', new_string: '2' }), /edited e\.txt \(1 replacement\)/);
  assert.equal(readFileSync(join(root, 'e.txt'), 'utf8'), 'one\n2\nthree\n');
  assert.match(await runTool('edit_file', { path: 'e.txt', old_string: 'nope', new_string: 'x' }), /^error: .*0 matches/);
  assert.match(await runTool('edit_file', { path: 'gone.txt', old_string: 'a', new_string: 'b' }), /write_file/);
  assert.match(await runTool('edit_file', { path: '../x', old_string: 'a', new_string: 'b' }), /outside/);
});

test('edit_file previews and summarises like write_file', () => {
  assert.equal(describe('edit_file', { path: 'a.js' }), 'edit a.js');
  const p = preview('edit_file', { path: 'a.js', old_string: 'x', new_string: 'y' });
  assert.match(p, /- x/);
  assert.match(p, /\+ y/);
});

test('edit_file validates its arguments and refuses non-UTF-8 files', async () => {
  assert.match(applyEdit('abc', 'b', undefined).error, /new_string must be a string/);
  assert.equal(applyEdit('abc', 'b', '').text, 'ac', 'empty new_string deletes');
  assert.match(applyEdit('abc', undefined, 'x').error, /old_string/);
  writeFileSync(join(root, 'bin.dat'), Buffer.from([0x61, 0xff, 0xfe, 0x62]));
  assert.match(await runTool('edit_file', { path: 'bin.dat', old_string: 'a', new_string: 'z' }), /not valid UTF-8/);
  assert.deepEqual(readFileSync(join(root, 'bin.dat')), Buffer.from([0x61, 0xff, 0xfe, 0x62]));
});

test('bash_output returns only new output, then the exit status', async () => {
  const out = await runBash('echo one; sleep 0.6; echo two', { timeoutMs: 200 });
  const id = out.match(/job (bg\d+)/)[1];
  assert.match(out, /one/);
  const mid = await runTool('bash_output', { id });
  assert.match(mid, /still running/);
  assert.match(mid, /\(no new output\)/, 'one was already handed over');
  await new Promise((r) => setTimeout(r, 900));
  const end = await runTool('bash_output', { id });
  assert.match(end, /exited with code 0/);
  assert.match(end, /two/);
  assert.doesNotMatch(end, /one/);
  assert.doesNotMatch(end, /__KRONK_CWD__/);
  assert.match(await runTool('bash_output', { id }), /no background job/, 'forgotten once reported');
});

test('bash_output reports a non-zero exit', async () => {
  const out = await runBash('sleep 0.4; echo bad >&2; exit 3', { timeoutMs: 100 });
  const id = out.match(/job (bg\d+)/)[1];
  await new Promise((r) => setTimeout(r, 700));
  const end = await readJob(id);
  assert.match(end, /exited with code 3/);
  assert.match(end, /bad/);
});

test('bash_output with kill stops the job and ends the process', async () => {
  const out = await runBash('sleep 30', { timeoutMs: 100 });
  const id = out.match(/job (bg\d+)/)[1];
  const res = await runTool('bash_output', { id, kill: true });
  assert.match(res, /killed by SIGKILL/);
  assert.equal(backgroundJobs(), 0);
});

test('a background job moving the cwd does not move the session', async () => {
  const out = await runBash('mkdir -p sub; cd sub; sleep 0.4', { timeoutMs: 100 });
  const id = out.match(/job (bg\d+)/)[1];
  await new Promise((r) => setTimeout(r, 700));
  await readJob(id);
  assert.equal(session.cwd, root);
});

test('retained output per job is capped and the drop is reported', async () => {
  const out = await runBash('sleep 0.3; head -c 600000 /dev/zero | tr "\\0" x; echo; echo TAIL', { timeoutMs: 100 });
  const id = out.match(/job (bg\d+)/)[1];
  await new Promise((r) => setTimeout(r, 1500));
  const end = await readJob(id);
  assert.match(end, /earlier output were dropped/);
  assert.match(end, /TAIL/);
});

test('bash_output is ungated and unknown ids are an error, not a crash', async () => {
  assert.ok(!NEEDS_APPROVAL.has('bash_output'));
  assert.ok(TOOLS.some((t) => t.function.name === 'bash_output'));
  assert.match(await runTool('bash_output', { id: 'nope' }), /^error: no background job/);
});

test('past the job limit a timeout still kills', async () => {
  for (let i = 0; i < 8; i++) await runBash('sleep 30', { timeoutMs: 50 });
  assert.equal(backgroundJobs(), 8);
  const out = await runBash('sleep 30', { timeoutMs: 100 });
  assert.match(out, /error: killed after/);
  killAllJobs();
});

test('more than 8 unread finished jobs discards the oldest with a clear message', async () => {
  const ids = [];
  for (let i = 0; i < 10; i++) {
    const out = await runBash('sleep 0.3', { timeoutMs: 50 });
    ids.push(out.match(/job (bg\d+)/)[1]);
    if (i % 4 === 3) await new Promise((r) => setTimeout(r, 450));
  }
  await new Promise((r) => setTimeout(r, 600));
  assert.match(await runTool('bash_output', { id: ids[0] }), /finished and discarded/);
  assert.match(await runTool('bash_output', { id: ids[9] }), /exited with code 0/);
  killAllJobs();
});
