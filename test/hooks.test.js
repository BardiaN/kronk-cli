import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHooks, matching, decide, runHook, runPre, runPost } from '../src/hooks.js';

const node = (code) => `node -e ${JSON.stringify(code)}`;
const hooks = (pre = [], post = []) => parseHooks({ pre, post });
const readStdin = 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);';

test('parseHooks keeps valid entries, applies defaults, drops broken ones', () => {
  const h = parseHooks({ pre: [
    { match: 'bash', command: 'true' },
    { match: '(', command: 'true' },
    { match: 'x' },
    { command: 'true', timeout: 3, onFailure: 'block' },
  ] });
  assert.equal(h.pre.length, 2);
  assert.equal(h.dropped, 2);
  assert.equal(h.pre[0].onFailure, 'allow');
  assert.equal(h.pre[0].timeoutMs, 10_000);
  assert.equal(h.pre[1].timeoutMs, 3_000);
  assert.equal(h.pre[1].onFailure, 'block');
  assert.deepEqual(parseHooks(undefined).pre, []);
});

test('matching is a regex over the tool name, and an empty match hits everything', () => {
  const h = hooks([{ match: 'bash|write_file', command: 'a' }, { command: 'b' }]);
  assert.equal(matching(h, 'pre', 'bash').length, 2);
  assert.equal(matching(h, 'pre', 'read_file').length, 1);
  assert.equal(matching(h, 'post', 'bash').length, 0);
});

test('decide maps exit codes, timeouts and onFailure', () => {
  assert.equal(decide({ code: 0 }).action, 'continue');
  assert.deepEqual(decide({ code: 2, stderr: ' no \n' }), { action: 'block', message: 'no' });
  assert.equal(decide({ code: 1 }, 'allow').action, 'continue');
  assert.ok(decide({ code: 1 }, 'allow').warning);
  assert.equal(decide({ code: 1, stderr: 'boom' }, 'block').action, 'block');
  assert.equal(decide({ timedOut: true }, 'block').action, 'block');
  assert.equal(decide({ timedOut: true }).action, 'continue');
});

test('runHook feeds the payload on stdin and KRONK_TOOL in the env', async () => {
  const h = hooks([{ command: node(`${readStdin}console.log(j.tool+"|"+j.args.cmd+"|"+process.env.KRONK_TOOL)})`) }]).pre[0];
  const r = await runHook(h, { tool: 'bash', args: { cmd: 'ls' }, cwd: '.' });
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), 'bash|ls|bash');
});

test('runHook kills a hook that outlives its timeout', async () => {
  const h = { command: node('setTimeout(()=>{},5000)'), timeoutMs: 200 };
  const r = await runHook(h, { tool: 'bash', args: {} });
  assert.equal(r.timedOut, true);
});

test('runPre: exit 2 blocks with the hook stderr; exit 0 passes', async () => {
  const block = hooks([{ match: 'bash', command: node('console.error("no rm -rf");process.exit(2)') }]);
  const r = await runPre(block, 'bash', { cmd: 'rm -rf /' });
  assert.deepEqual([r.blocked, r.message], [true, 'no rm -rf']);
  assert.equal((await runPre(block, 'read_file', {})).blocked, false);
  assert.equal((await runPre(hooks([{ command: 'true' }]), 'bash', {})).blocked, false);
});

test('runPre: a crashing hook follows onFailure', async () => {
  const bad = node('process.exit(1)');
  const r = await runPre(hooks([{ command: bad }]), 'bash', {});
  assert.equal(r.blocked, false);
  assert.equal(r.warnings.length, 1);
  assert.equal((await runPre(hooks([{ command: bad, onFailure: 'block' }]), 'bash', {})).blocked, true);
});

test('runPost: output is ignored, exit 2 becomes a note, result and ok are sent', async () => {
  const quiet = hooks([], [{ command: node('console.log("chatter")') }]);
  assert.equal((await runPost(quiet, 'bash', {}, 'fine')).note, '');
  const loud = hooks([], [{ command: node(`${readStdin}console.error(j.result+" ok="+j.ok);process.exit(2)})`) }]);
  assert.equal((await runPost(loud, 'bash', {}, 'error: x')).note, '[hook] error: x ok=false');
});

test('runHook returns at the timeout even when a grandchild holds the pipes open', async () => {
  const h = { command: `${node('setTimeout(()=>{},5000)')} | cat`, timeoutMs: 300 };
  const t = Date.now();
  const r = await runHook(h, { tool: 'bash', args: {} });
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - t < 2000, 'the hook outlived its timeout');
});
