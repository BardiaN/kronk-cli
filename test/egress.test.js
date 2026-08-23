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
  // Match the import, not the word: a file that only *names* the module in a
  // comment cannot spawn anything, and a substring match made that a failure.
  const imports = /from\s+['"](?:node:)?child_process['"]|require\(['"](?:node:)?child_process['"]\)/;
  const spawners = sources
    .filter(({ body }) => imports.test(body))
    .map(({ name }) => name);
  // setup.js is on the list because `kronk-cli setup` drives the kronk binary —
  // pull, server stop, server start — through one helper. Every other file that
  // wants to run a command still has to be added here deliberately.
  assert.deepEqual(spawners.sort(), ['context.js', 'mcp.js', 'setup.js', 'tools.js'].sort(),
    'a new file gained the ability to run commands');
});

test('warns when the endpoint is remote and unencrypted', async () => {
  const { config, warnIfInsecure } = await import('../src/config.js');
  const seen = [];
  const capture = (m) => seen.push(m);
  const original = config.baseUrl;

  for (const url of ['http://localhost:11435/v1', 'http://127.0.0.1:11435/v1', 'https://kronk.example.com/v1']) {
    config.baseUrl = url;
    seen.length = 0;
    assert.equal(warnIfInsecure(capture), false, `${url} should be accepted quietly`);
  }

  config.baseUrl = 'http://kronk.example.com/v1';
  seen.length = 0;
  assert.equal(warnIfInsecure(capture), true, 'remote plain http must warn');
  assert.match(seen.join(' '), /clear text/);

  config.baseUrl = original;
});
