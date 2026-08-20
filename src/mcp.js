import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { c } from './ui.js';

const PROTOCOL = '2025-06-18';
const CLIENT = { name: 'kronk-cli', version: '0.1.0' };
const CALL_TIMEOUT = 120_000;
const START_TIMEOUT = 20_000;

/* ------------------------------------------------------------------ config */

/**
 * Read MCP servers from the places a developer already keeps them:
 * Claude Code's global and per-project config, a project `.mcp.json`, and
 * kronk-cli's own rc file. Later sources win on name collision.
 */
export async function loadServers(cwd = process.cwd()) {
  const out = {};
  const merge = (obj) => { for (const [k, v] of Object.entries(obj ?? {})) out[k] = v; };

  const readJson = async (p) => {
    try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; }
  };

  const claude = await readJson(join(homedir(), '.claude.json'));
  if (claude) {
    merge(claude.mcpServers);
    merge(claude.projects?.[cwd]?.mcpServers);
  }
  merge((await readJson(join(cwd, '.mcp.json')))?.mcpServers);
  merge((await readJson(join(homedir(), '.kronk-cli.json')))?.mcpServers);
  merge((await readJson(join(cwd, '.kronk-cli.json')))?.mcpServers);

  // `"disabled": true` keeps an entry in the file but out of this session.
  for (const [k, v] of Object.entries(out)) if (v?.disabled) delete out[k];
  return out;
}

/* --------------------------------------------------------------- transports */

/** Newline-delimited JSON-RPC over a child process's stdio. */
function stdioTransport(spec, name) {
  const child = spawn(spec.command, spec.args ?? [], {
    env: { ...process.env, ...(spec.env ?? {}) },
    cwd: spec.cwd ?? process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const pending = new Map();
  let buf = '';
  let stderrTail = '';

  child.stdout.on('data', (d) => {
    buf += d.toString();
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }   // servers log to stdout sometimes
      const p = pending.get(msg.id);
      if (!p) continue;
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message ?? 'mcp error')) : p.resolve(msg.result);
    }
  });

  // Keep the last of stderr so a crash can be explained.
  child.stderr.on('data', (d) => { stderrTail = (stderrTail + d.toString()).slice(-2000); });

  const fail = (e) => {
    for (const p of pending.values()) p.reject(e);
    pending.clear();
  };
  child.on('error', (e) => fail(new Error(`${name}: ${e.message}`)));
  child.on('exit', (code) => fail(new Error(`${name}: exited (${code}) ${stderrTail.trim()}`)));

  // A live child with piped stdio holds the event loop open, so the CLI would
  // print its answer and then hang instead of exiting. Unref everything; we
  // kill the child explicitly on close.
  child.unref();
  child.stdout.unref?.();
  child.stderr.unref?.();
  child.stdin.unref?.();

  return {
    kind: 'stdio',
    async send(msg, timeout) {
      if (msg.id === undefined) {                            // notification
        child.stdin.write(`${JSON.stringify(msg)}\n`);
        return undefined;
      }
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => {
          pending.delete(msg.id);
          reject(new Error(`${name}: timed out after ${timeout}ms`));
        }, timeout);
        pending.set(msg.id, {
          resolve: (v) => { clearTimeout(t); resolve(v); },
          reject: (e) => { clearTimeout(t); reject(e); },
        });
        child.stdin.write(`${JSON.stringify(msg)}\n`);
      });
    },
    close() { child.kill(); },
  };
}

/** Streamable HTTP: POST JSON-RPC, accept either JSON or an SSE stream back. */
function httpTransport(spec, name) {
  let sessionId = null;

  return {
    kind: 'http',
    async send(msg, timeout) {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), timeout);
      try {
        const res = await fetch(spec.url, {
          method: 'POST',
          signal: ac.signal,
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
            ...(spec.headers ?? {}),
          },
          body: JSON.stringify(msg),
        });
        const sid = res.headers.get('mcp-session-id');
        if (sid) sessionId = sid;
        if (msg.id === undefined) return undefined;
        if (!res.ok) throw new Error(`${name}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);

        const body = await res.text();
        // SSE framing when the server streams; plain JSON otherwise.
        const payload = body.startsWith('event:') || body.startsWith('data:')
          ? body.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('')
          : body;
        const parsed = JSON.parse(payload);
        if (parsed.error) throw new Error(parsed.error.message ?? 'mcp error');
        return parsed.result;
      } finally { clearTimeout(t); }
    },
    close() {},
  };
}

/* ------------------------------------------------------------------ client */

class Server {
  constructor(name, spec) {
    this.name = name;
    this.spec = spec;
    this.tools = [];
    this.nextId = 1;
  }

  async start() {
    const isHttp = this.spec.url || this.spec.type === 'http' || this.spec.type === 'sse';
    if (!isHttp && !this.spec.command) throw new Error('needs a command or a url');
    this.transport = isHttp
      ? httpTransport(this.spec, this.name)
      : stdioTransport(this.spec, this.name);

    await this.rpc('initialize', {
      protocolVersion: PROTOCOL,
      capabilities: { tools: {} },
      clientInfo: CLIENT,
    }, START_TIMEOUT);

    await this.transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' }, START_TIMEOUT);

    const { tools } = await this.rpc('tools/list', {}, START_TIMEOUT);
    this.tools = tools ?? [];
    return this.tools;
  }

  rpc(method, params, timeout = CALL_TIMEOUT) {
    return this.transport.send(
      { jsonrpc: '2.0', id: this.nextId++, method, params },
      timeout,
    );
  }

  close() { this.transport?.close(); }
}

/** Function names must match ^[a-zA-Z0-9_-]{1,64}$ for the chat API. */
export const qualify = (server, tool) =>
  `${server}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);

export class McpHub {
  constructor() {
    this.servers = new Map();
    this.routes = new Map();   // qualified name -> { server, tool }
    this.failures = [];
  }

  /** Start every configured server. One failing never blocks the others. */
  async connect(specs) {
    const entries = Object.entries(specs);
    await Promise.all(entries.map(async ([name, spec]) => {
      const server = new Server(name, spec);
      try {
        const tools = await server.start();
        this.servers.set(name, server);
        for (const t of tools) this.routes.set(qualify(name, t.name), { server, tool: t.name });
      } catch (e) {
        this.failures.push({ name, error: e.message });
        server.close();
      }
    }));
    return this;
  }

  /** MCP tool definitions in OpenAI function-calling shape. */
  toolDefs() {
    const defs = [];
    for (const [qualified, { server, tool }] of this.routes) {
      const def = server.tools.find((t) => t.name === tool);
      defs.push({
        type: 'function',
        function: {
          name: qualified,
          description: `[${server.name}] ${def?.description ?? tool}`.slice(0, 1024),
          parameters: def?.inputSchema ?? { type: 'object', properties: {} },
        },
      });
    }
    return defs;
  }

  has(name) { return this.routes.has(name); }

  async call(name, args) {
    const route = this.routes.get(name);
    if (!route) return `error: unknown MCP tool ${name}`;
    try {
      const res = await route.server.rpc('tools/call', { name: route.tool, arguments: args ?? {} });
      const text = (res?.content ?? [])
        .map((part) => {
          if (part.type === 'text') return part.text;
          if (part.type === 'resource') return part.resource?.text ?? `[resource ${part.resource?.uri}]`;
          return `[${part.type}]`;
        })
        .join('\n')
        .trim();
      const body = text || JSON.stringify(res?.structuredContent ?? res ?? {}).slice(0, 4000);
      return res?.isError ? `error: ${body}` : body;
    } catch (e) {
      return `error: ${e.message}`;
    }
  }

  summary() {
    const parts = [...this.servers.values()].map((s) => `${s.name}(${s.tools.length})`);
    return parts.join(' · ');
  }

  close() { for (const s of this.servers.values()) s.close(); }
}

export function reportFailures(failures) {
  for (const f of failures) console.log(c.yellow(`  mcp ${f.name}: ${f.error.slice(0, 160)}`));
}
