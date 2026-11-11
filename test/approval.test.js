import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveApprovalMode, decideApproval, deniedBySettingsMessage, DENIED_BY_SETTINGS,
} from '../src/approval.js';
import { parseArgv } from '../src/argv.js';

test('no flag asks; --yes and --auto allow; --deny denies', () => {
  assert.equal(resolveApprovalMode({}).mode, 'ask');
  assert.equal(resolveApprovalMode({ yes: true }).mode, 'allow');
  assert.equal(resolveApprovalMode({ auto: true }).mode, 'allow');
  assert.equal(resolveApprovalMode({ deny: true }).mode, 'deny');
});

test('the configured default denies, but an explicit --yes/--auto overrides it', () => {
  assert.equal(resolveApprovalMode({ denyDefault: true }).mode, 'deny');
  assert.equal(resolveApprovalMode({ denyDefault: true, yes: true }).mode, 'allow');
  assert.equal(resolveApprovalMode({ denyDefault: true, auto: true }).mode, 'allow');
});

test('--deny with --yes or --auto is a contradiction, not a precedence rule', () => {
  const a = resolveApprovalMode({ deny: true, yes: true });
  assert.equal(a.mode, null);
  assert.match(a.error, /--deny cannot be combined with --yes/);
  assert.match(resolveApprovalMode({ deny: true, auto: true }).error, /--auto/);
});

test('decideApproval: allow is true, deny is the settings sentinel, ask is left to the caller', () => {
  assert.equal(decideApproval('allow'), true);
  assert.equal(decideApproval('deny'), DENIED_BY_SETTINGS);
  assert.equal(decideApproval('ask'), null);
});

test('the model is told it is the settings, not a person, and not to retry', () => {
  const m = deniedBySettingsMessage('bash');
  assert.match(m, /^error: the user's settings deny bash without approval/);
  assert.match(m, /Do not retry/);
});

test('argv: --deny parses, and combining it with -y or -a is a usage error in either order', () => {
  assert.equal(parseArgv(['--deny', 'x']).deny, true);
  for (const argv of [['--deny', '-y', 'x'], ['-a', '--deny', 'x'], ['--yes', 'x', '--deny']]) {
    assert.match(parseArgv(argv).error, /--deny cannot be combined/, argv.join(' '));
  }
});
