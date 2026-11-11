// Saved prompt presets: named prompts invoked as `/<name> [extra text]`.
//
// Everything here is pure or takes its directories as arguments, so tests can
// point it at temp dirs. A preset only ever becomes a user message — it cannot
// run anything itself, so every tool call it leads to still goes through the
// normal approval prompt.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const NAME = /^[a-z0-9-]+$/;

// Every REPL command src/index.js dispatches on. A preset with one of these
// names is dropped rather than replacing the command: a prompt file in a
// cloned repo must not be able to take over `/auto` or `/exit`.
export const BUILTINS = new Set([
  'help', 'clear', 'steps', 'auto', 'think', 'thinking', 'agents', 'theme',
  'models', 'tasks', 'mcp', 'compact', 'context', 'model', 'file', 'exit',
  'quit', 'presets',
]);

export const userPromptsDir = () => join(homedir(), '.config', 'kronk-cli', 'prompts');
export const projectPromptsDir = (cwd) => join(cwd, '.kronk', 'prompts');

/** Read `<name>.md` files from a directory; a missing directory is just empty. */
function readDir(dir) {
  const out = {};
  let entries;
  try { entries = readdirSync(dir); } catch { return out; }
  for (const f of entries) {
    if (!f.endsWith('.md')) continue;
    const name = f.slice(0, -3);
    if (!NAME.test(name)) continue;
    let text;
    try { text = readFileSync(join(dir, f), 'utf8'); } catch { continue; }
    text = text.trim();
    if (text) out[name] = text;
  }
  return out;
}

/**
 * Merge the three sources, later winning: the config file's `presets`
 * object, the user's prompts directory, then the project's. Returns
 * `{ presets, shadowed }` where `shadowed` lists names that collide with a
 * built-in command and so were left out.
 */
export function loadPresets({ fromConfig, userDir, projectDir } = {}) {
  const merged = {};
  if (fromConfig && typeof fromConfig === 'object' && !Array.isArray(fromConfig)) {
    for (const [name, text] of Object.entries(fromConfig)) {
      if (NAME.test(name) && typeof text === 'string' && text.trim()) merged[name] = text.trim();
    }
  }
  if (userDir) Object.assign(merged, readDir(userDir));
  if (projectDir) Object.assign(merged, readDir(projectDir));

  const shadowed = [];
  const presets = {};
  for (const name of Object.keys(merged).sort()) {
    if (BUILTINS.has(name)) shadowed.push(name);
    else presets[name] = merged[name];
  }
  return { presets, shadowed };
}

/** `$ARGS` replaced by the extra text; with no placeholder the text is appended. */
export function expandPreset(text, extra = '') {
  const rest = extra.trim();
  // A function replacement keeps `$&` and friends in the user's text literal.
  if (text.includes('$ARGS')) return text.replaceAll('$ARGS', () => rest).trim();
  return rest ? `${text}\n\n${rest}` : text;
}

/** If `input` is `/<name> ...` for a known preset, the expanded prompt; else null. */
export function resolveInvocation(input, presets) {
  const m = /^\/([a-z0-9-]+)(?:\s+([\s\S]*))?$/.exec(input);
  if (!m || !Object.hasOwn(presets, m[1])) return null;
  return expandPreset(presets[m[1]], m[2] ?? '');
}

/** One line per preset: the name and the first non-empty line, truncated. */
export function listPresets(presets, width = 70) {
  return Object.entries(presets).map(([name, text]) => {
    const first = text.split('\n').find((l) => l.trim())?.trim() ?? '';
    const preview = first.length > width ? `${first.slice(0, width - 1)}…` : first;
    return `/${name}  ${preview}`;
  });
}

/** The command word of a slash input (`/steps 5` -> `steps`), or null. */
export function commandWord(input) {
  const m = /^\/(\S+)/.exec(input);
  return m ? m[1] : null;
}
