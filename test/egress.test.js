import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Guards the claim the README makes: this tool talks to your Kronk server and
 * to MCP servers you configured, and to nothing else. These are cheap static
 * checks, but they fail loudly the moment someone adds a call to a third party
 * — which is exactly the change that would otherwise slip through review.
 */

const SRC = new URL('../src/', import.meta.url).pathname;
const files = readdirSync(SRC).filter((f) => f.endsWith('.js'));
const sources = files.map((f) => ({ name: f, body: readFileSync(join(SRC, f), 'utf8') }));

/** The only literal endpoint the program may carry. */
const ALLOWED_URLS = new Set(['http://localhost:11435/v1']);

test('src contains no URL literal other than the local default', () => {
  const found = new Set();
  for (const { body } of sources) {
    for (const m of body.matchAll(/https?:\/\/[^'"`\s)]+/g)) found.add(m[0]);
  }
  const unexpected = [...found].filter((u) => !ALLOWED_URLS.has(u));
  assert.deepEqual(unexpected, [],
    `unexpected endpoint(s) in src/: ${unexpected.join(', ')}`);
});

test('the only outbound calls are fetch, and every one uses a configured host', () => {
  const offenders = [];
  for (const { name, body } of sources) {
    for (const [i, line] of body.split('\n').entries()) {
      if (!/\bfetch\(/.test(line)) continue;
      // Permitted targets: the configured Kronk base URL, or an MCP server's url.
      const ok = /fetch\(\s*`\$\{base\(\)\}|fetch\(\s*`\$\{config\.baseUrl\}|fetch\(\s*spec\.url/.test(line);
      if (!ok) offenders.push(`${name}:${i + 1}  ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, [],
    `fetch to something other than the configured host:\n${offenders.join('\n')}`);
});

test('no other network transport is imported', () => {
  const banned = /require\(['"](net|dgram|tls|http|https|node:net|node:dgram|node:tls|node:http|node:https)['"]\)|from\s+['"]node:(net|dgram|tls|http|https)['"]/;
  for (const { name, body } of sources) {
    assert.ok(!banned.test(body), `${name} imports a raw network module`);
  }
});

test('no telemetry-shaped identifiers anywhere in src', () => {
  const smell = /\b(telemetry|analytics|posthog|mixpanel|segment\.io|sentry|amplitude|datadog|bugsnag|phoneHome|beacon)\b/i;
  for (const { name, body } of sources) {
    assert.ok(!smell.test(body), `${name} mentions a telemetry service`);
  }
});

test('the package ships with no runtime dependencies', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(pkg.dependencies ?? {}, {},
    'a runtime dependency can do anything this test forbids; add it deliberately or not at all');
});

test('child processes are only spawned by the tool layer', () => {
  const spawners = sources
    .filter(({ body }) => /child_process/.test(body))
    .map(({ name }) => name);
  assert.deepEqual(spawners.sort(), ['context.js', 'mcp.js', 'tools.js'].sort(),
    'a new file gained the ability to run commands');
});
