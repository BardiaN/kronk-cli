import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadServers, qualify, McpHub } from '../src/mcp.js';

test('qualified names stay valid OpenAI function names', () => {
  assert.equal(qualify('nx', 'nx_docs'), 'nx__nx_docs');
  assert.match(qualify('my server', 'do.thing'), /^[a-zA-Z0-9_-]+$/);
  assert.ok(qualify('a'.repeat(80), 'b'.repeat(80)).length <= 64);
});

test('reads mcpServers from a project .mcp.json', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kronk-mcp-'));
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({
    mcpServers: { local: { command: 'echo', args: ['hi'] } },
  }));
  const servers = await loadServers(dir);
  assert.ok(servers.local, 'project config should be picked up');
  assert.equal(servers.local.command, 'echo');
});

test('a disabled server is filtered out', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kronk-mcp-'));
  writeFileSync(join(dir, '.mcp.json'), JSON.stringify({
    mcpServers: {
      on: { command: 'echo' },
      off: { command: 'echo', disabled: true },
    },
  }));
  const servers = await loadServers(dir);
  assert.ok(servers.on);
  assert.ok(!servers.off);
});

test('malformed json is ignored rather than fatal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kronk-mcp-'));
  writeFileSync(join(dir, '.mcp.json'), '{ not json');
  await assert.doesNotReject(() => loadServers(dir));
});

test('a server that cannot start is recorded, not thrown', async () => {
  const hub = await new McpHub().connect({
    broken: { command: 'definitely-not-a-real-binary-xyz' },
  });
  assert.equal(hub.servers.size, 0);
  assert.equal(hub.failures.length, 1);
  assert.equal(hub.failures[0].name, 'broken');
  hub.close();
});

test('one broken server does not stop the others being reported', async () => {
  const hub = await new McpHub().connect({
    brokenA: { command: 'nope-xyz-a' },
    brokenB: { command: 'nope-xyz-b' },
  });
  assert.equal(hub.failures.length, 2);
  assert.equal(hub.toolDefs().length, 0);
  hub.close();
});

test('calling an unknown tool returns an error string, not a throw', async () => {
  const hub = new McpHub();
  assert.match(await hub.call('nope__thing', {}), /^error: unknown MCP tool/);
});
