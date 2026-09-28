import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveModel } from '../src/resolve.js';
import { chatModels, pickDefault } from '../src/boot.js';

const IDS = [
  'unsloth/Qwen3.6-35B-A3B-UD-Q4_K_M',
  'unsloth/Qwen3.6-35B-A3B-UD-Q4_K_M/AGENT',
  'stub/small',
];

test('an exact id wins outright, even when a substring match also exists', () => {
  assert.equal(resolveModel('unsloth/Qwen3.6-35B-A3B-UD-Q4_K_M', IDS),
    'unsloth/Qwen3.6-35B-A3B-UD-Q4_K_M', 'not the /AGENT profile — the caller typed the whole id');
});

test('a substring prefers the /AGENT profile over the bare id', () => {
  assert.equal(resolveModel('Qwen3.6', IDS), 'unsloth/Qwen3.6-35B-A3B-UD-Q4_K_M/AGENT');
});

test('a substring with no /AGENT match falls back to the first hit', () => {
  assert.equal(resolveModel('stub', IDS), 'stub/small');
});

test('no match at all is null, not a throw', () => {
  assert.equal(resolveModel('nothing-like-this', IDS), null);
  assert.equal(resolveModel('', IDS), null, 'an empty want is not a match-everything wildcard');
  assert.equal(resolveModel('Qwen3.6', []), null, 'nothing served, nothing to resolve against');
  assert.equal(resolveModel('Qwen3.6', undefined), null);
});

test('the enum a delegated task is offered keeps every chat model, profiled or not', () => {
  const ids = ['x/Qwen3-Embedding-0.6B', 'x/chat', 'x/chat/AGENT', 'x/reranker-v2', 'y/small'];
  assert.deepEqual(chatModels(ids), ['x/chat/AGENT', 'y/small'],
    'embedding and reranking models are never offered, and a bare id loses to its own profile');

  // The whole point of letting a task name a model is that a survey can be
  // sent to the small fast one. That model is precisely the one least likely
  // to have an /AGENT profile written for it, so `pickDefault`'s rule —
  // "the profiles, if there are any" — must not be the rule here: it would
  // leave a menu of nothing but the large models, on a pool that holds one
  // large model at a time.
  const real = [
    'ggml-org/qwen2.5-coder-1.5b-q8_0',
    'ornith-ai/Ornith-1.5-35B-Q4_K_M', 'ornith-ai/Ornith-1.5-35B-Q4_K_M/AGENT',
    'unsloth/Qwen3.6-35B-A3B-UD-Q4_K_M', 'unsloth/Qwen3.6-35B-A3B-UD-Q4_K_M/AGENT',
  ];
  assert.ok(chatModels(real).includes('ggml-org/qwen2.5-coder-1.5b-q8_0'),
    'the one small model served must be offerable');
  assert.deepEqual(chatModels(real).filter((id) => id.endsWith('/AGENT')).length, 2);
  assert.ok(!chatModels(real).includes('unsloth/Qwen3.6-35B-A3B-UD-Q4_K_M'),
    'but not twice, once per profile of the same weights');

  // And the default pick is untouched by any of that.
  assert.equal(pickDefault(ids), 'x/chat/AGENT');
  assert.equal(pickDefault(['a/b', 'a/b/AGENT']), 'a/b/AGENT');
});
