import { readdir, readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';

const exec = promisify(execFile);

/** Files that, by convention, tell an agent how to work in this repo. */
const AGENT_FILES = ['AGENTS.md', 'CLAUDE.md', 'KRONK.md', '.cursorrules', 'CONVENTIONS.md'];
const AGENT_FILE_CAP = 6000;
const LISTING_CAP = 60;

const SKIP = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'target', 'vendor',
  '.next', '.venv', '__pycache__', '.DS_Store', 'coverage', '.turbo',
]);

async function sh(cmd, args, cwd) {
  try {
    const { stdout } = await exec(cmd, args, { cwd, timeout: 5000 });
    return stdout.trim();
  } catch { return ''; }
}

async function gitContext(cwd) {
  const inside = await sh('git', ['rev-parse', '--is-inside-work-tree'], cwd);
  if (inside !== 'true') return null;

  const [branch, status, recent] = await Promise.all([
    sh('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd),
    sh('git', ['status', '--porcelain'], cwd),
    sh('git', ['log', '-5', '--oneline', '--no-decorate'], cwd),
  ]);

  const changed = status ? status.split('\n').filter(Boolean) : [];
  return {
    branch,
    dirty: changed.length,
    changed: changed.slice(0, 20),
    recent: recent ? recent.split('\n') : [],
  };
}

async function listing(cwd) {
  let names;
  try { names = await readdir(cwd); } catch { return []; }
  const kept = names.filter((n) => !SKIP.has(n) && !n.startsWith('.git'));
  const rows = await Promise.all(kept.slice(0, LISTING_CAP).map(async (n) => {
    try { return (await stat(join(cwd, n))).isDirectory() ? `${n}/` : n; }
    catch { return n; }
  }));
  rows.sort();
  if (kept.length > LISTING_CAP) rows.push(`…and ${kept.length - LISTING_CAP} more`);
  return rows;
}

async function agentFile(cwd) {
  for (const name of AGENT_FILES) {
    try {
      const body = await readFile(join(cwd, name), 'utf8');
      if (!body.trim()) continue;
      const clipped = body.length > AGENT_FILE_CAP
        ? `${body.slice(0, AGENT_FILE_CAP)}\n…[truncated]`
        : body;
      return { name, body: clipped };
    } catch { /* next */ }
  }
  return null;
}

/**
 * A short primer describing where the agent is standing, gathered once at
 * startup. Saves the model a round trip and stops it guessing about layout.
 */
export async function projectContext(cwd = process.cwd()) {
  const [files, git, agents] = await Promise.all([listing(cwd), gitContext(cwd), agentFile(cwd)]);

  const parts = [`Working directory: ${cwd}`, `Platform: ${process.platform}`];

  if (git) {
    parts.push(`Git: branch ${git.branch}, ${git.dirty} uncommitted change(s)`);
    if (git.changed.length) parts.push(`Modified:\n${git.changed.map((l) => `  ${l}`).join('\n')}`);
    if (git.recent.length) parts.push(`Recent commits:\n${git.recent.map((l) => `  ${l}`).join('\n')}`);
  } else {
    parts.push('Git: not a repository');
  }

  if (files.length) parts.push(`Top level:\n${files.map((f) => `  ${f}`).join('\n')}`);

  if (agents) {
    parts.push(`Project instructions from ${agents.name} — follow these:\n\n${agents.body}`);
  }

  return { text: parts.join('\n\n'), agentFile: agents?.name ?? null, isGit: Boolean(git) };
}
