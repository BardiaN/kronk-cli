import { test } from 'node:test';
import assert from 'node:assert/strict';
import { samplingOverride } from '../src/client.js';

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
