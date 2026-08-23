import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);

const SCRIPT = new URL('../.github/scripts/wait-for-release.sh', import.meta.url).pathname;
const FAKE_GH_DIR = new URL('./fixtures/fake-gh/', import.meta.url).pathname;

/**
 * scorecard.yml's `gate` job cannot contain a `run:` step next to
 * ossf/scorecard-action (see the script's own comment for why), so the wait
 * loop lives in this standalone script instead. These tests exercise it the
 * same way the job does — as a subprocess, with a fake `gh` on PATH — rather
 * than parsing YAML, which is untestable in this harness.
 */
function runScript({ tagExists = false, sequence = 'none', extraEnv = {} } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'wait-for-release-'));
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ version: '9.9.9' }));
  const outputFile = join(cwd, 'github-output');
  writeFileSync(outputFile, '');
  const callLog = join(cwd, 'gh-call-log');

  const env = {
    ...process.env,
    PATH: `${FAKE_GH_DIR}:${process.env.PATH}`,
    GITHUB_EVENT_NAME: 'push',
    GITHUB_REPOSITORY: 'BardiaN/kronk-cli',
    GITHUB_SHA: 'deadbeef',
    GITHUB_OUTPUT: outputFile,
    GH_FAKE_TAG_EXISTS: tagExists ? '1' : '0',
    GH_FAKE_RUN_SEQUENCE: sequence,
    GH_FAKE_CALL_LOG: callLog,
    RELEASE_WAIT_TIMEOUT_SECONDS: '2',
    RELEASE_WAIT_INTERVAL_SECONDS: '1',
    ...extraEnv,
  };

  return run('bash', [SCRIPT], { cwd, env }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr, outputFile, callLog }),
    (err) => ({ code: err.code, stdout: err.stdout, stderr: err.stderr, outputFile, callLog }),
  );
}

function readOutputs(outputFile) {
  const body = readFileSync(outputFile, 'utf8');
  const outputs = {};
  for (const line of body.split('\n')) {
    const i = line.indexOf('=');
    if (i === -1) continue;
    outputs[line.slice(0, i)] = line.slice(i + 1);
  }
  return outputs;
}

test('no release for this commit: exits immediately and never polls', async () => {
  const { code, outputFile, callLog } = await runScript({ tagExists: true });
  assert.equal(code, 0);
  assert.equal(readOutputs(outputFile).proceed, 'true');
  assert.equal(existsSync(callLog), false, 'run list should never have been called');
});

test('release run succeeds: proceeds after it completes', async () => {
  const { code, outputFile } = await runScript({
    tagExists: false,
    sequence: 'in_progress:null,completed:success',
  });
  assert.equal(code, 0);
  assert.equal(readOutputs(outputFile).proceed, 'true');
});

test('release run fails: does not proceed', async () => {
  const { code, outputFile } = await runScript({
    tagExists: false,
    sequence: 'completed:failure',
  });
  assert.equal(code, 0, 'the script itself must not fail the job');
  assert.equal(readOutputs(outputFile).proceed, 'false');
});

test('timeout reached: falls back to proceeding rather than blocking forever', async () => {
  const { code, stdout, outputFile } = await runScript({
    tagExists: false,
    sequence: 'in_progress:null',
  });
  assert.equal(code, 0);
  assert.match(stdout, /timed out/);
  assert.equal(readOutputs(outputFile).proceed, 'true');
});

test('non-push event: skipped without touching gh at all', async () => {
  const { code, outputFile, callLog } = await runScript({
    tagExists: false,
    extraEnv: { GITHUB_EVENT_NAME: 'schedule' },
  });
  assert.equal(code, 0);
  assert.equal(readOutputs(outputFile).proceed, 'true');
  assert.equal(existsSync(callLog), false, 'run list should never have been called');
});
