import { test } from 'node:test';
import assert from 'node:assert/strict';
import { samplingOverride, parseLimits, NO_LIMITS } from '../src/client.js';
import { config, applyLimits, DEFAULT_MAX_TOKENS } from '../src/config.js';

// Metadata as Kronk actually reports it (strings), matched against the
// effective sampling-parameters block (numbers) for the same model.
const AGREES = { 'general.sampling.temp': '1', 'general.sampling.top_k': '20', 'general.sampling.top_p': '0.95' };
const EFFECTIVE_AGREES = { temperature: 1, top_k: 20, top_p: 0.95 };

test('1. a pinned value that differs from the model produces one entry naming both numbers', () => {
  const diff = samplingOverride(AGREES, { ...EFFECTIVE_AGREES, temperature: 0.6 });
  assert.deepEqual(diff, [{ param: 'temperature', model: 1, effective: 0.6 }]);
});

test('2. metadata and effective agree on all three → null', () => {
  assert.equal(samplingOverride(AGREES, EFFECTIVE_AGREES), null);
});

test('3. metadata absent entirely → null', () => {
  assert.equal(samplingOverride(undefined, EFFECTIVE_AGREES), null);
  assert.equal(samplingOverride({}, EFFECTIVE_AGREES), null);
});

test('4. two parameters disagree → one array naming both, not one call each', () => {
  const diff = samplingOverride(AGREES, { temperature: 0.6, top_k: 10, top_p: 0.95 });
  assert.deepEqual(diff, [
    { param: 'temperature', model: 1, effective: 0.6 },
    { param: 'top_k', model: 20, effective: 10 },
  ]);
});

// Case 5 (a failing /kronk/models/{id}) belongs to modelLimits(), not this
// pure function — covered in test/boot.test.js against a real HTTP stub.

test('6. string-versus-number equality: "1" and 1 compare equal', () => {
  assert.equal(samplingOverride({ 'general.sampling.temp': '1' }, { temperature: 1 }), null);
});

test('7. floating-point round-trip noise does not warn', () => {
  assert.equal(samplingOverride({ 'general.sampling.top_p': '0.95' }, { top_p: 0.9500001 }), null);
});

test('8. a real difference just outside the tolerance still warns', () => {
  const diff = samplingOverride({ 'general.sampling.temp': '1' }, { temperature: 0.6 });
  assert.deepEqual(diff, [{ param: 'temperature', model: 1, effective: 0.6 }]);
});

test('a non-numeric metadata value is "no opinion", not a difference', () => {
  assert.equal(samplingOverride({ 'general.sampling.temp': 'auto' }, { temperature: 0.6 }), null);
});

test('a missing effective value is "no opinion", not a difference', () => {
  assert.equal(samplingOverride({ 'general.sampling.temp': '1' }, {}), null);
});

test('an unparsable effective object (null) is "no opinion", not a difference', () => {
  assert.equal(samplingOverride(AGREES, null), null);
});

// Number(null) and Number('') are both 0, so a guard that coerces first and
// checks Number.isFinite afterwards reads an unset parameter as a deliberate
// zero and warns about it. Kronk really does return both shapes inside
// model_config, so these are reachable, not theoretical.
test('an effective value of null is no opinion, not zero', () => {
  assert.equal(samplingOverride(AGREES, { temperature: null, top_k: 20, top_p: 0.95 }), null);
});

test('a metadata value of null is no opinion, not zero', () => {
  assert.equal(
    samplingOverride({ ...AGREES, 'general.sampling.temp': null }, EFFECTIVE_AGREES),
    null,
  );
});

test('an empty-string value on either side is no opinion, not zero', () => {
  assert.equal(
    samplingOverride({ ...AGREES, 'general.sampling.temp': '' }, EFFECTIVE_AGREES),
    null,
  );
  assert.equal(samplingOverride(AGREES, { ...EFFECTIVE_AGREES, top_k: '' }), null);
});

// ---- parseLimits: every limit comes from the named model's own profile ----

/** The shape /v1/kronk/models/{id} really returns, trimmed to what we read. */
const payload = (contextWindow, maxTokens, { native = '262144', template = 'preserve_thinking' } = {}) => ({
  model_config: {
    'context-window': contextWindow,
    'sampling-parameters': { max_tokens: maxTokens, temperature: 1, top_k: 20, top_p: 0.95 },
  },
  metadata: { 'qwen35moe.context_length': native, 'tokenizer.chat_template': template },
});

test('the window and the output cap are read per model, not assumed', () => {
  const big = parseLimits(payload(131072, 16384));
  assert.equal(big.configured, 131072);
  assert.equal(big.maxTokens, 16384, "the profile's cap, not the program's default");
  assert.equal(big.native, 262144);
  assert.equal(big.preserveThinking, true);

  const small = parseLimits(payload(32768, 0, { native: '32768', template: 'no such kwarg' }));
  assert.equal(small.configured, 32768);
  assert.equal(small.preserveThinking, false);
});

test('max_tokens 0 is "no opinion", not a cap of zero', () => {
  assert.equal(parseLimits(payload(32768, 0)).maxTokens, null);
  assert.equal(parseLimits(payload(32768, '')).maxTokens, null);
  assert.equal(parseLimits(payload(32768, undefined)).maxTokens, null);
});

test('a model with no profile answers unknown rather than guessing', () => {
  assert.deepEqual(parseLimits({}), {
    configured: null, native: null, preserveThinking: false, samplingDiff: null, maxTokens: null,
  });
  assert.deepEqual(parseLimits(undefined), NO_LIMITS);
});

// ---- applyLimits: the user's number wins, then the profile's, then ours ----

test('the profile sets the output cap when the user has not', () => {
  config.maxTokensExplicit = false;
  applyLimits(parseLimits(payload(131072, 16384)));
  assert.equal(config.maxTokens, 16384);
  assert.equal(config.contextWindow, 131072);
  assert.equal(config.templatePreservesThinking, true);
});

test('a cap the user typed is never overruled by a profile', () => {
  config.maxTokensExplicit = true;
  config.maxTokens = 2048;
  applyLimits(parseLimits(payload(131072, 16384)));
  assert.equal(config.maxTokens, 2048);
  assert.equal(config.contextWindow, 131072, 'the rest still follows the model');
});

test('a profile with no cap of its own falls back to the default', () => {
  config.maxTokensExplicit = false;
  applyLimits(parseLimits(payload(32768, 0)));
  assert.equal(config.maxTokens, DEFAULT_MAX_TOKENS);
});

test('switching to a model with no profile clears the previous model’s limits', () => {
  config.maxTokensExplicit = false;
  applyLimits(parseLimits(payload(131072, 16384)));
  applyLimits(parseLimits({}));
  assert.equal(config.contextWindow, null, 'a stale 131k window is worse than none');
  assert.equal(config.templatePreservesThinking, false);
  assert.equal(config.maxTokens, DEFAULT_MAX_TOKENS);
});
