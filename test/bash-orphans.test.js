import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const tools = fileURLToPath(new URL('../src/tools.js', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function alive(needle) {
  try { execFileSync('pgrep', ['-f', needle], { stdio: 'pipe' }); return true; }
  catch { return false; }
}

/** Start a process that is mid-way through a foreground `sleep`, then end it with `how`. */
async function endWith(how, tag) {
  const script = `
    import { runBash, session } from ${JSON.stringify(tools)};
    session.root = session.cwd = process.cwd();
    process.stdout.write('ready\\n');
    runBash('sleep ${tag}');
    setInterval(() => {}, 1000);
    ${how === 'exit' ? "setTimeout(() => process.exit(0), 600);" : ''}
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((r) => child.stdout.once('data', r));
  await sleep(500);
  assert.ok(alive(`sleep ${tag}`), 'the command is running');
  if (how !== 'exit') child.kill(how);
  await new Promise((r) => child.once('exit', r));
  await sleep(200);
  return alive(`sleep ${tag}`);
}

for (const [how, tag] of [['SIGTERM', '32.1'], ['SIGHUP', '32.2'], ['exit', '32.3']]) {
  test(`${how} leaves no foreground command behind`, async () => {
    assert.equal(await endWith(how, tag), false);
  });
}
