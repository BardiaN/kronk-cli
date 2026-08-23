#!/usr/bin/env node
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { readFile } from 'node:fs/promises';
import { config, DEFAULT_MODEL, warnIfInsecure } from './config.js';
import { listModels, listModelDetails, listLoaded, modelLimits, tokenize } from './client.js';
import { pickDefault, ensureLoaded } from './boot.js';
import { runTurn, SYSTEM, SYSTEM_AUTO } from './agent.js';
import { c, banner, fmtContext, statusLine } from './ui.js';
import { projectContext } from './context.js';
import { forRequest } from './reasoning.js';
import { compact, report } from './compact.js';
import { loadServers, McpHub, reportFailures } from './mcp.js';
import { resolveSandbox, sandbox } from './tools.js';
import { parseArgv } from './argv.js';
import { runSetup } from './setup.js';

// ---- argv -------------------------------------------------------------
const args = parseArgv(process.argv.slice(2));
if (args.error) {
  // A usage error is not a conversation: stderr, exit 2, nothing sent anywhere.
  console.error(`\n${args.error}\n`);
  process.exit(2);
}

if (args.help) {
  console.log(`
  kronk-cli — a terminal agent for local models served by Kronk

  USAGE
    kronk-cli                       start the interactive REPL
    kronk-cli "<prompt>"            run one prompt and exit
    <cmd> | kronk-cli "<prompt>"    pipe stdin in as extra context

  SUBCOMMANDS
    kronk-cli setup [--model <id>] [--context <n>] [-y] [--dry-run]
                                    pull the model, write its /AGENT profile to
                                    ~/.kronk/models/model_config.yaml, restart Kronk

  OPTIONS
    -l, --models        list the models Kronk is serving, then exit
        --no-context    skip the startup scan of the working directory
        --no-compact    never auto-compact; fail instead when the window fills
        --no-warm       don't preload the model; let the first prompt trigger it
        --mcp [names]   attach MCP servers; bare for all, or a comma list
        --mcp-list      show configured MCP servers and their tools, then exit
    -m, --model <id>    model to use; substring is enough, /AGENT profiles win
                        default: ${DEFAULT_MODEL}
    -a, --auto          autonomous: approve tools automatically, finish the task
    -y, --yes           approve tools automatically (no autonomous prompt)
        --no-think      disable the model's reasoning pass (faster)
        --steps <n>     cap tool calls per task (default: unlimited)
    -h, --help          this message
        --              end option parsing; everything after is the prompt

  ENVIRONMENT
    KRONK_URL           default http://localhost:11435/v1
    KRONK_TOKEN         any non-empty value when Kronk runs open
    KRONK_MODEL         overrides the default model
    KRONK_MODEL_CONFIG  path to Kronk's model_config.yaml, used by setup
    KRONK_MAX_TOKENS    output cap per response (default 8192)
    KRONK_MAX_STEPS     cap on tool calls per task (default unlimited)
    KRONK_NO_THINK      set to 1 to disable reasoning
    KRONK_PRESERVE_THINKING
                        false to stop pinning earlier think blocks in the
                        prompt (smaller prompts, cache lost on every turn)
    KRONK_WARM          false to skip the boot-time model preload
    KRONK_AUTO_COMPACT  false to disable automatic compaction
    KRONK_COMPACT_AT    fraction of the window that triggers it (default 0.85)

  Config file: ~/.kronk-cli.json
`);
  process.exit(0);
}

// --auto: run the whole task unattended (implies --yes)
const AUTO = args.auto;
const AUTO_YES = args.yes || AUTO;
const SHOW_MODELS = args.models;
const SHOW_MCP = args.mcpList;
const NO_CONTEXT = args.noContext;
// `--mcp` alone attaches everything configured; `--mcp nx,kronk` narrows it.
const MCP_ON = args.mcp;
const MCP_WANTED = args.mcpNames;

if (args.noThink) config.noThink = true;
if (args.noCompact) config.autoCompact = false;
if (args.noWarm) config.warm = false;
if (args.model) config.model = args.model;
if (args.steps !== null) config.maxSteps = args.steps;

async function boot() {
  let ids;
  try {
    ids = await listModels();
  } catch (e) {
    console.error(c.red(`\n  Cannot reach Kronk at ${config.baseUrl}`));
    console.error(c.grey(`  ${e.message}`));
    console.error(c.grey('  Start it with:  kronk server start --detach\n'));
    process.exit(1);
  }
  if (!ids.length) {
    console.error(c.red('\n  Kronk is running but has no models.'));
    console.error(c.grey('  Pull one:  kronk model pull unsloth/Qwen3.6-35B-A3B-UD-Q4_K_M\n'));
    process.exit(1);
  }
  // Fall back to the configured default before guessing.
  if (!config.model && ids.includes(DEFAULT_MODEL)) config.model = DEFAULT_MODEL;

  if (config.model) {
    // exact id wins; otherwise accept a unique-enough substring
    // Exact id wins. Otherwise take a substring match, preferring an /AGENT
    // profile — each profile is a SEPARATE resident copy in the pool, so
    // picking the wrong one silently loads a second 20 GB instance.
    const subs = ids.filter((id) => id.includes(config.model));
    const hit = ids.find((id) => id === config.model)
             ?? subs.find((id) => id.endsWith('/AGENT'))
             ?? subs[0];
    if (hit) config.model = hit;
    else {
      console.error(c.yellow(`  no model matching "${config.model}" — falling back`));
      config.model = null;
    }
  }
  if (!config.model) config.model = pickDefault(ids);

  if (config.warm) await ensureLoaded(ids);

  const {
    configured, native, preserveThinking, samplingDiff,
  } = await modelLimits(config.model);
  config.contextWindow = configured;
  config.nativeContext = native;
  config.templatePreservesThinking = preserveThinking;
  config.samplingOverride = samplingDiff;
  return ids;
}

const gb = (n) => `${(n / 1e9).toFixed(1)} GB`;

/** Connect the MCP servers the user asked for. Never fatal. */
async function startMcp() {
  if (!MCP_ON) return null;
  const all = await loadServers(process.cwd());
  const specs = MCP_WANTED
    ? Object.fromEntries(Object.entries(all).filter(([n]) => MCP_WANTED.includes(n)))
    : all;

  const missing = (MCP_WANTED ?? []).filter((n) => !all[n]);
  for (const n of missing) console.log(c.yellow(`  mcp ${n}: not configured`));
  if (!Object.keys(specs).length) return null;

  const hub = await new McpHub().connect(specs);
  reportFailures(hub.failures);
  const n = hub.routes.size;
  if (n) {
    console.log(c.grey('  mcp      ') + hub.summary() + c.grey(` · ${n} tools`));
    if (n > 25) {
      console.log(c.yellow(`  ${n} MCP tools is a lot for a local model — narrow it with --mcp <names>`));
    }
  }
  process.on('exit', () => hub.close());
  return hub;
}

/** `--mcp-list` — what is configured, what connects, what it exposes. */
async function showMcp() {
  const specs = await loadServers(process.cwd());
  const names = Object.keys(specs);
  if (!names.length) {
    console.log(c.grey('\n  No MCP servers configured.'));
    console.log(c.grey('  Looked in ~/.claude.json, ./.mcp.json, ~/.kronk-cli.json, ./.kronk-cli.json\n'));
    return;
  }
  console.log(c.grey(`\n  ${names.length} configured — connecting…\n`));
  const hub = await new McpHub().connect(specs);
  for (const name of names) {
    const server = hub.servers.get(name);
    const spec = specs[name];
    const via = spec.url ?? `${spec.command} ${(spec.args ?? []).join(' ')}`.trim();
    if (!server) {
      const f = hub.failures.find((x) => x.name === name);
      console.log(`  ${c.red('✗')} ${c.bold(name)}  ${c.grey(via)}`);
      console.log(c.red(`      ${f?.error.slice(0, 200) ?? 'failed'}`));
      continue;
    }
    console.log(`  ${c.green('●')} ${c.bold(name)}  ${c.grey(via)}`);
    for (const t of server.tools) {
      console.log(`      ${c.grey(`${name}__`)}${t.name}`);
    }
  }
  console.log(c.grey(`\n  attach with: kronk-cli --mcp ${names.slice(0, 2).join(',')}\n`));
  hub.close();
}

/** `kronk-cli --models` — what Kronk is serving, and what is resident. */
async function showModels() {
  let ids, details, loaded;
  try {
    [ids, details, loaded] = await Promise.all([listModels(), listModelDetails(), listLoaded()]);
  } catch (e) {
    console.error(c.red(`  Cannot reach Kronk at ${config.baseUrl}`));
    console.error(c.grey(`  ${e.message}`));
    process.exit(1);
  }
  if (!ids.length) {
    console.log(c.yellow('  Kronk is running but serving no models.'));
    console.log(c.grey('  kronk model pull unsloth/Qwen3.6-35B-A3B-UD-Q4_K_M'));
    return;
  }

  const byId = new Map(details.map((d) => [d.id, d]));
  const live = new Map((Array.isArray(loaded) ? loaded : []).map((l) => [l.id, l]));
  const selected = config.model ?? (ids.includes(DEFAULT_MODEL) ? DEFAULT_MODEL : ids[0]);
  const w = Math.max(...ids.map((i) => i.length));

  console.log();
  for (const id of ids) {
    const d = byId.get(id);
    const l = live.get(id);
    const mark = id === selected ? c.green('●') : c.grey('○');
    const tags = [];
    if (d?.size) tags.push(gb(d.size));
    if (d?.has_projection) tags.push('vision');
    if (l) tags.push(c.cyan(`loaded ${gb(l.vram_total)}${l.active_streams ? ` · ${l.active_streams} active` : ''}`));
    console.log(`  ${mark} ${id.padEnd(w)}  ${c.grey(tags.join(' · '))}`);
  }

  const totalLive = [...live.values()].reduce((a, b) => a + (b.vram_total ?? 0), 0);
  if (totalLive) console.log(c.grey(`\n  resident: ${gb(totalLive)}`));
  console.log(c.grey(`  default:  ${selected}`));
  console.log(c.grey(`  select:   kronk-cli -m <substring>\n`));
}

const HELP = `
  ${c.bold('/models')}          list models Kronk is serving
  ${c.bold('/model <id>')}      switch model
  ${c.bold('/file <path>')}     add a file to the conversation as context
  ${c.bold('/thinking')}        show/hide the model's reasoning
  ${c.bold('/think')}           turn reasoning off entirely (much faster)
  ${c.bold('/auto')}            autonomous mode: auto-approve tools, run to completion
  ${c.bold('/steps [n|off]')}   cap tool calls per task (default: unlimited)
  ${c.bold('/mcp')}             list attached MCP servers and their tools
  ${c.bold('/context')}         how much of the context window is used
  ${c.bold('/compact')}         replace the conversation with a summary of itself
  ${c.bold('/clear')}           reset the conversation
  ${c.bold('/exit')}            quit
`;

/**
 * System prompt plus a primer about the directory we were launched in: layout,
 * git state, and any AGENTS.md / CLAUDE.md the project ships. Gathered once so
 * the model does not have to spend its first tool call working out where it is.
 */
async function systemMessage(auto) {
  const base = auto ? SYSTEM_AUTO : SYSTEM;
  if (NO_CONTEXT) return { content: base, ctx: null };
  const ctx = await projectContext(process.cwd());
  const budget = config.contextWindow
    ? `\n\nYour context window is ${config.contextWindow.toLocaleString()} tokens, shared by `
      + `everything in this conversation: these instructions, file contents you read, command `
      + `output, and your own replies. When you plan work that must fit in one context, size it `
      + `against that number and say what you assumed.`
    : '';
  return { content: `${base}${budget}\n\n---\n\n${ctx.text}`, ctx };
}

/**
 * Read piped stdin, if any.
 *
 * Guarded by a timeout: when this runs under CI, a background job, or any shell
 * that hands us an open-but-idle pipe, an unguarded `for await` never returns
 * and the process hangs before printing anything.
 */
async function readStdin(timeoutMs) {
  if (stdin.isTTY) return '';
  let timer;
  const collect = (async () => {
    let out = '';
    for await (const chunk of stdin) out += chunk;
    return out.trim();
  })();
  const bail = new Promise((res) => {
    timer = setTimeout(() => res(''), timeoutMs);
    timer.unref?.();
  });
  try { return await Promise.race([collect, bail]); }
  finally { clearTimeout(timer); }
}

/** One prompt, one answer, exit — for scripts and pipes. */
async function oneShot(prompt) {
  await boot();
  const mcp = await startMcp();
  const { content } = await systemMessage(AUTO);
  const messages = [
    { role: 'system', content },
    { role: 'user', content: prompt },
  ];
  const ac = new AbortController();
  process.on('SIGINT', () => ac.abort());

  // One shot prints no banner, so the mode that auto-approves every command was
  // also the one that said nothing about what was confining them. On stderr, so
  // piping the answer somewhere still gets just the answer.
  if (resolveSandbox() === 'none' && AUTO_YES) {
    console.error(c.yellow(`  warning: shell commands run unconfined — ${sandbox.reason}`));
  }

  const approve = async (name) => {
    if (AUTO_YES) return true;
    console.log(c.yellow(`  ✗ ${name} needs approval; re-run with --yes to allow it`));
    return false;
  };
  try {
    await runTurn({ messages, model: config.model, signal: ac.signal, approve, mcp, auto: AUTO });
  } catch (e) {
    if (e.name !== 'AbortError') { console.error(c.red(`  ${e.message}`)); process.exitCode = 1; }
  } finally {
    mcp?.close();
  }
}

async function main() {
  // Before anything reaches the network, on every path through the program.
  warnIfInsecure();

  // Subcommands are dispatched before the one-shot path below, so `setup` is
  // never mistaken for a one-word prompt and sent to the model.
  if (args.words[0] === 'setup') {
    if (args.words.length > 1) {
      console.error(`\n  setup takes no arguments — got: ${args.words.slice(1).join(' ')}\n`);
      process.exitCode = 2;
      return;
    }
    process.exitCode = await runSetup({
      model: args.model,
      context: args.context,
      yes: args.yes,
      dryRun: args.dryRun,
    });
    return;
  }

  if (SHOW_MODELS) { await showModels(); return; }
  if (SHOW_MCP) { await showMcp(); process.exit(0); }

  // non-interactive: `kronk-cli "prompt"` or `echo prompt | kronk-cli`
  const inline = args.words.join(' ').trim();
  // With an inline prompt, stdin is optional extra context — don't block on it.
  // Without one, stdin IS the prompt, so wait longer before giving up.
  const piped = await readStdin(inline ? 200 : 10_000);
  const oneShotPrompt = inline && piped ? `${inline}\n\n${piped}` : (inline || piped);
  if (oneShotPrompt) {
    // stdin has given us everything it is going to. When it is a pipe the
    // caller never closes — a script, an editor task, a CI step — the read
    // above stays pending and its handle would keep the process alive long
    // after the answer was printed. Let go of it before answering.
    stdin.pause();
    stdin.unref?.();
    await oneShot(oneShotPrompt);
    return;
  }

  const rl = readline.createInterface({ input: stdin, output: stdout, historySize: 500 });
  await boot();
  const { content, ctx } = await systemMessage(AUTO);
  console.log(banner(config.model, config.baseUrl));

  // Information, not a failure: the profile is doing exactly what it was
  // told to, it's just not what the model's own GGUF recommends. One-shot
  // mode never reaches this line because it never prints the banner either.
  if (config.samplingOverride) {
    const named = config.samplingOverride
      .map((d) => `${d.param} ${d.effective} (model recommends ${d.model})`)
      .join(', ');
    console.log(c.grey(`  note     profile overrides the model's own sampling: ${named}`));
  }

  const mcp = await startMcp();

  if (ctx) {
    const bits = [process.cwd().replace(process.env.HOME ?? '', '~')];
    if (ctx.isGit) bits.push('git');
    if (ctx.agentFile) bits.push(c.green(ctx.agentFile));
    if (config.contextWindow) bits.push(c.grey(`${(config.contextWindow / 1000).toFixed(0)}k ctx`));
    console.log(c.grey(`  context`) + `  ${bits.join(c.grey(' · '))}`);
  }

  // Say which of the two confinements is actually in force. Printing nothing
  // would let the README's word "sandbox" stand in for a guarantee the kernel
  // is not making on this machine.
  const backend = resolveSandbox();
  console.log(`${c.grey('  sandbox')}  ${backend === 'none'
    ? c.yellow(`paths only — ${sandbox.reason}, shell commands are unconfined`)
    : c.grey(`paths + ${backend}`)}\n`);

  const messages = [{ role: 'system', content }];
  // The system prompt is the one record of which mode we are in — /auto rewrites
  // it — so both the status line and the turn read the answer from there.
  const isAuto = () => messages[0].content.startsWith(SYSTEM_AUTO);

  // Ctrl-C aborts the in-flight request instead of killing the process.
  let ac = null;
  rl.on('SIGINT', () => {
    if (ac) { ac.abort(); ac = null; console.log(c.yellow('\n  interrupted')); }
    else { console.log(); rl.close(); }
  });

  let autoApprove = AUTO_YES;
  const approve = async (name) => {
    if (autoApprove) return true;
    const a = (await rl.question(c.yellow(`  approve ${name}? [y/N] `))).trim().toLowerCase();
    return a === 'y' || a === 'yes';
  };

  for (;;) {
    const status = statusLine({
      model: config.model,
      auto: autoApprove && isAuto(),
      yes: autoApprove,
      noThink: config.noThink,
      // Only news when the model could have had it and the user said no.
      noPreserve: config.templatePreservesThinking && !config.noThink && !config.preserveThinking,
      mcp: mcp?.routes.size ? [...mcp.servers.keys()].join(',') : null,
      steps: config.maxSteps,
      used: config.lastUsed,
      window: config.contextWindow,
    });

    let line;
    try { line = await rl.question(`\n${status}\n${c.cyan('›')} `); }
    catch { break; }                       // rl closed
    const input = line.trim();
    if (!input) continue;

    if (input === '/exit' || input === '/quit') break;
    if (input === '/help') { console.log(HELP); continue; }
    if (input === '/clear') {
      messages.length = 1;
      config.lastUsed = 0;
      console.log(c.grey('  conversation cleared'));
      continue;
    }
    if (input.startsWith('/steps')) {
      const raw = input.split(/\s+/)[1];
      if (raw !== undefined) {
        config.maxSteps = /^(0|off|none|inf|unlimited)$/i.test(raw) ? Infinity : Number(raw);
      }
      console.log(c.grey(`  step cap: ${Number.isFinite(config.maxSteps) ? config.maxSteps : 'unlimited'}`));
      continue;
    }
    if (input === '/auto') {
      const now = !isAuto();
      const primer = messages[0].content.slice((isAuto() ? SYSTEM_AUTO : SYSTEM).length);
      messages[0] = { role: 'system', content: (now ? SYSTEM_AUTO : SYSTEM) + primer };
      autoApprove = now;
      console.log(c.grey(`  autonomous mode ${now ? 'on — tools auto-approved, runs to completion' : 'off'}`));
      continue;
    }
    if (input === '/think') {
      config.noThink = !config.noThink;
      console.log(c.grey(`  reasoning ${config.noThink ? 'disabled (faster)' : 'enabled'}`));
      continue;
    }
    if (input === '/thinking') {
      config.showThinking = !config.showThinking;
      console.log(c.grey(`  thinking display ${config.showThinking ? 'on' : 'off'}`));
      continue;
    }
    if (input === '/models') { await showModels(); continue; }
    if (input === '/mcp') {
      if (!mcp || !mcp.routes.size) { console.log(c.grey('  no MCP servers attached — start with --mcp')); continue; }
      for (const [name, server] of mcp.servers) {
        console.log(c.green(`  ● ${name}`) + c.grey(` · ${server.tools.length} tools`));
        for (const t of server.tools) console.log(c.grey(`      ${name}__${t.name}`));
      }
      continue;
    }
    if (input === '/compact') {
      if (messages.length < 2) { console.log(c.grey('  nothing to compact')); continue; }
      const sp = new AbortController();
      const res = await compact(messages, { model: config.model, signal: sp.signal });
      if (res.failed) { console.log(c.red('  compaction produced nothing — conversation unchanged')); continue; }
      if (!res.skipped) messages.splice(0, messages.length, ...res.messages);
      console.log(report(res));
      continue;
    }
    if (input === '/context') {
      // Count what the next request would actually carry, replayed reasoning
      // included — the history holds reasoning that is never sent, and a meter
      // that charged for it would read high for the whole session.
      const used = await tokenize(config.model, forRequest(messages)
        .map((m) => `${m.reasoning_content ?? ''}${m.content ?? ''}`).join('\n'));
      console.log(`  ${fmtContext(used, config.contextWindow) || c.grey('unknown')}`);
      console.log(c.grey(`  window: ${config.contextWindow?.toLocaleString() ?? '?'} tokens`
        + (config.nativeContext ? ` · model supports up to ${config.nativeContext.toLocaleString()}` : '')));
      console.log(c.grey(`  messages: ${messages.length}`));
      continue;
    }
    if (input.startsWith('/model ')) {
      const want = input.slice(7).trim();
      const all = await listModels();
      const subs = all.filter((m) => m.includes(want));
      const hit = all.find((m) => m === want)
               ?? subs.find((m) => m.endsWith('/AGENT'))
               ?? subs[0];
      if (!hit) { console.log(c.red(`  no model matching "${want}"`)); continue; }
      config.model = hit;
      console.log(c.green(`  switched to ${hit}`));
      continue;
    }
    if (input.startsWith('/file ')) {
      const path = input.slice(6).trim();
      try {
        const body = await readFile(path, 'utf8');
        messages.push({ role: 'user', content: `Contents of ${path}:\n\n\`\`\`\n${body}\n\`\`\`` });
        console.log(c.grey(`  added ${path} (${body.length} bytes)`));
      } catch (e) { console.log(c.red(`  ${e.message}`)); }
      continue;
    }
    if (input.startsWith('/')) { console.log(c.red(`  unknown command — /help`)); continue; }

    messages.push({ role: 'user', content: input });
    ac = new AbortController();
    try {
      await runTurn({ messages, model: config.model, signal: ac.signal, approve, mcp, auto: isAuto() });
    } catch (e) {
      if (e.name === 'AbortError') messages.push({ role: 'assistant', content: '(interrupted)' });
      else console.error(c.red(`\n  ${e.message}`));
    } finally {
      ac = null;
    }
  }

  rl.close();
  mcp?.close();
  console.log(c.grey('  bye'));
}

main();
