import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

const RC = join(homedir(), '.kronk-cli.json');

function fileConfig() {
  try { return JSON.parse(readFileSync(RC, 'utf8')); } catch { return {}; }
}

const file = fileConfig();

/** Used when nothing is passed on the command line or in the environment. */
export const DEFAULT_MODEL = 'unsloth/Qwen3.6-35B-A3B-UD-Q4_K_M/AGENT';

export const config = {
  baseUrl: process.env.KRONK_URL   ?? file.baseUrl ?? 'http://localhost:11435/v1',
  token:   process.env.KRONK_TOKEN ?? file.token   ?? 'kronk',
  model:   process.env.KRONK_MODEL ?? file.model   ?? null,   // null → DEFAULT_MODEL, then auto-pick
  maxTokens: Number(process.env.KRONK_MAX_TOKENS ?? file.maxTokens ?? 8192),
  // Unlimited by default — a run stops when the model is done or you press Ctrl-C.
  // Set --steps / KRONK_MAX_STEPS to opt into a cap.
  maxSteps: Number(process.env.KRONK_MAX_STEPS ?? file.maxSteps ?? Infinity),
  showThinking: (process.env.KRONK_THINKING ?? String(file.showThinking ?? 'true')) !== 'false',
  noThink: (process.env.KRONK_NO_THINK ?? String(file.noThink ?? '')) === '1',
  autoCompact: (process.env.KRONK_AUTO_COMPACT ?? String(file.autoCompact ?? 'true')) !== 'false',
  compactAt: Number(process.env.KRONK_COMPACT_AT ?? file.compactAt ?? 0.85),
  // Large tool output is summarized in a throwaway context so the raw text
  // never enters the conversation. Set KRONK_DISTILL=false to keep it whole.
  distill: (process.env.KRONK_DISTILL ?? String(file.distill ?? 'true')) !== 'false',
  distillAt: Number(process.env.KRONK_DISTILL_AT ?? file.distillAt ?? 8000),
  lastUsed: 0,
  contextWindow: null,   // filled in at boot from Kronk
  nativeContext: null,
  rcPath: RC,
};

/**
 * File contents and command output leave this process in request bodies, which
 * is the whole job. Over loopback that is fine. Pointed at a remote host over
 * plain HTTP it is not, so say so once rather than letting it pass silently.
 */
export function warnIfInsecure(warn = console.error) {
  let url;
  try { url = new URL(config.baseUrl); } catch { return false; }

  const local = ['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(url.hostname)
    || url.hostname.endsWith('.local')
    || url.hostname === 'host.docker.internal';

  if (url.protocol === 'https:' || local) return false;

  warn(`  warning: ${config.baseUrl} is remote and unencrypted.`);
  warn('  File contents and command output will cross the network in clear text.');
  warn('  Use https, or an SSH tunnel to keep the endpoint on localhost.');
  return true;
}

export const headers = () => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${config.token}`,
});
