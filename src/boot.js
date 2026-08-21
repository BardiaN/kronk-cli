import { config, DEFAULT_MODEL } from './config.js';
import { listLoaded, warm } from './client.js';
import { c, spinner } from './ui.js';

/** Last resort when neither the flag nor DEFAULT_MODEL is being served. */
export function pickDefault(ids) {
  const chat = ids.filter((id) => !/embedding|rerank/i.test(id));
  const agent = chat.filter((id) => id.endsWith('/AGENT'));
  const pool = agent.length ? agent : chat;
  return pool.sort((a, b) => b.length - a.length)[0] ?? null;
}

/**
 * Get the chosen model resident before the first prompt.
 *
 * A freshly started Kronk serves model *ids* but holds nothing in VRAM — it
 * admits a model on its first inference request, and there is no endpoint that
 * does it sooner. Left alone, that 10–25 s cold load lands on the first thing
 * you type, looking like a hang. Do it here, where a spinner explains the wait
 * and where a model that will not fit can still fall back to one that will.
 *
 * Never fatal: if nothing warms, the original pick stands and the first turn
 * reports the real error. A warm-up is a convenience, not a gate.
 *
 * Returns the id left in `config.model`.
 */
export async function ensureLoaded(ids, log = console.error) {
  const loaded = await listLoaded();
  const resident = new Set((Array.isArray(loaded) ? loaded : []).map((l) => l.id));
  if (resident.has(config.model)) return config.model;

  const chosen = config.model;
  // chosen → configured default → best guess; each distinct id tried once.
  const chain = [...new Set([
    chosen,
    ids.includes(DEFAULT_MODEL) ? DEFAULT_MODEL : null,
    pickDefault(ids),
  ])].filter(Boolean);

  for (const id of chain) {
    if (resident.has(id)) { config.model = id; return id; }
    const t0 = Date.now();
    const spin = spinner(`loading ${id.split('/').pop()} — first run takes 10-30s`);
    try {
      await warm(id);
      spin.stop();
      const how = `${((Date.now() - t0) / 1000).toFixed(1)}s${id === chosen ? '' : ' · fallback'}`;
      log(c.grey(`  loaded   ${id} · ${how}`));
      config.model = id;
      return id;
    } catch (e) {
      spin.stop();
      log(c.yellow(`  ${id} failed to load — ${e.message.split('\n')[0].slice(0, 160)}`));
    }
  }
  // Nothing would load. Keep the original pick and let the first turn say why.
  config.model = chosen;
  return chosen;
}
