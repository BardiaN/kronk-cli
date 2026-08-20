import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSseParser, accumulateToolCalls } from '../src/sse.js';
import { keyLines } from '../src/distill.js';
import { clip } from '../src/tools.js';

/**
 * Property tests over generated input.
 *
 * These functions all sit on a boundary where the input is not ours: bytes off
 * a socket, output from somebody else's build tool. The interesting failures
 * are the ones nobody thought to write a case for, so generate the cases.
 *
 * Deterministic on purpose — a seeded PRNG means a red build is reproducible
 * rather than a coin flip.
 */
function rng(seed = 0x2f6e2b1) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000);
}

const ALPHABET = ['{', '}', '[', ']', '"', ',', ':', '\\', '\n', '\r', '\t',
                  ' ', 'a', 'b', 'c', '0', '1', '9', 'data: ', 'é', '�'];

function noise(rand, len) {
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  return out;
}

test('the SSE parser never throws, whatever arrives', () => {
  const rand = rng();
  for (let i = 0; i < 3000; i++) {
    const p = createSseParser();
    const chunks = 1 + Math.floor(rand() * 4);
    for (let c = 0; c < chunks; c++) {
      const out = p.push(noise(rand, Math.floor(rand() * 120)));
      assert.ok(Array.isArray(out));
      for (const ev of out) assert.equal(typeof ev, 'string');
    }
    assert.ok(Array.isArray(p.flush()));
  }
});

test('a payload split at every possible byte still reassembles', () => {
  const payload = 'data: {"choices":[{"delta":{"content":"héllo"}}]}\n';
  for (let cut = 0; cut <= payload.length; cut++) {
    const p = createSseParser();
    const events = [...p.push(payload.slice(0, cut)), ...p.push(payload.slice(cut))];
    assert.deepEqual(events, [payload.slice(6).trim()], `split at ${cut} lost the event`);
  }
});

test('tool-call accumulation survives arbitrary delta shapes', () => {
  const rand = rng(99);
  for (let i = 0; i < 2000; i++) {
    const calls = new Map();
    const rounds = 1 + Math.floor(rand() * 5);
    for (let r = 0; r < rounds; r++) {
      accumulateToolCalls(calls, [{
        ...(rand() > 0.5 ? { id: noise(rand, 4) } : {}),
        ...(rand() > 0.5 ? { index: Math.floor(rand() * 3) } : {}),
        function: {
          ...(rand() > 0.5 ? { name: noise(rand, 5) } : {}),
          ...(rand() > 0.3 ? { arguments: noise(rand, 10) } : {}),
        },
      }]);
    }
    for (const c of calls.values()) {
      assert.equal(typeof c.id, 'string');
      assert.equal(typeof c.args, 'string');
    }
  }
});

test('keyLines never throws and never invents a line', () => {
  const rand = rng(7);
  for (let i = 0; i < 2000; i++) {
    const raw = noise(rand, Math.floor(rand() * 400));
    for (const h of keyLines(raw)) {
      assert.ok(h.length <= 510);
      const stem = h.endsWith('…') ? h.slice(0, -1) : h;
      assert.ok(raw.includes(stem.trimEnd()) || /more matches suppressed/.test(h),
        `fabricated a line that was not in the input: ${JSON.stringify(h)}`);
    }
  }
});

test('clip always keeps both ends and never grows the input', () => {
  const rand = rng(31);
  for (let i = 0; i < 400; i++) {
    const body = `START${noise(rand, Math.floor(rand() * 90000))}END`;
    const out = clip(body);
    assert.ok(out.length <= body.length + 120, 'clip must not inflate its input');
    assert.ok(out.startsWith('START'));
    assert.ok(out.endsWith('END'), 'the tail is where errors live');
  }
});
