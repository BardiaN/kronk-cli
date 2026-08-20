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

export const headers = () => ({
  'Content-Type': 'application/json',
  Authorization: `Bearer ${config.token}`,
});
