import { db } from '../db.js';
import { env } from '../env.js';
import OpenAI from 'openai';

/**
 * Runtime model selection (the web model picker). The choice is stored in the
 * `settings` table and takes effect on every model call from the next turn on;
 * env.XAI_MODEL remains the boot default.
 */

const DEFAULT_CATALOG = [
  'glm-5.3', 'glm-5.3-flash', 'glm-5.3-flashx', 'glm-5.2', 'glm-5.1',
  'glm-5', 'glm-4.7', 'glm-4.6', 'grok-4.7',
];

export function currentModel(): string {
  try {
    const r = db.prepare("SELECT value FROM settings WHERE key='model'").get() as any;
    if (r?.value) return String(r.value);
  } catch { /* settings table not there yet */ }
  return env.xaiModel;
}

export function setModel(m: string): void {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('model', m);
}

let cache: { at: number; models: string[]; source: 'live' | 'fallback' } | null = null;
const CACHE_MS = 5 * 60_000;

/** Live /models from the provider when reachable (5-min cache), curated fallback otherwise. */
export async function modelCatalog(): Promise<{ models: string[]; source: 'live' | 'fallback' }> {
  if (cache && Date.now() - cache.at < CACHE_MS) {
    const models = cache.models.includes(currentModel()) ? cache.models : [...cache.models, currentModel()];
    return { models, source: cache.source };
  }
  try {
    const client = new OpenAI({ apiKey: env.xaiKey, baseURL: env.xaiBaseUrl, timeout: 15_000 });
    const page = await client.models.list();
    const ids: string[] = [];
    for await (const m of page as any) if (m?.id) ids.push(String(m.id));
    if (!ids.length) throw new Error('empty model list');
    cache = { at: Date.now(), models: ids, source: 'live' };
  } catch {
    cache = { at: Date.now(), models: DEFAULT_CATALOG, source: 'fallback' };
  }
  const models = cache.models.includes(currentModel()) ? cache.models : [...cache.models, currentModel()];
  return { models, source: cache.source };
}
