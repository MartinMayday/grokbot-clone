/**
 * Custom model providers (Settings → Model providers).
 *
 * The deployment's default provider comes from the environment (ZAI_API_KEY /
 * ZAI_BASE_URL, xAI-compatible XAI_* spellings also accepted). Users can add
 * more OpenAI-compatible providers at runtime; their models are discoverable
 * via GET {base}/models and selectable per bot in the composer's model picker.
 *
 * Model routing convention: a bot's `model` is either
 *   - "glm-5.3"                    -> served by the default (env) provider
 *   - "prv_ab12cd34/glm-4.7"       -> served by that custom provider
 */
import OpenAI from 'openai';
import { db, now } from './db.js';
import { env } from './env.js';

import type { ModelProviderView } from './types.js';
export type { ModelProviderView };

export const DEFAULT_PROVIDER_ID = 'default';

const cache = new Map<string, { at: number; models: string[] }>();
const CACHE_MS = 5 * 60_000;

async function fetchModels(baseUrl: string, apiKey: string): Promise<string[]> {
  const r = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  const j: any = await r.json();
  const ids: string[] = (j?.data ?? j?.models ?? [])
    .map((m: any) => (typeof m === 'string' ? m : m?.id))
    .filter((x: any) => typeof x === 'string' && x);
  return [...new Set(ids)].sort();
}

const providerRows = (userId: string) =>
  db.prepare('SELECT * FROM model_providers WHERE user_id=? ORDER BY created_at').all(userId) as any[];

/** Every provider visible to the user (default env provider first). Never returns API keys. */
export async function providersView(userId: string): Promise<ModelProviderView[]> {
  const out: ModelProviderView[] = [];
  {
    let models: string[] = [];
    let error: string | undefined;
    const c = cache.get(DEFAULT_PROVIDER_ID);
    if (c && Date.now() - c.at < CACHE_MS) models = c.models;
    else {
      try {
        models = await fetchModels(env.xaiBaseUrl, env.xaiKey);
        cache.set(DEFAULT_PROVIDER_ID, { at: Date.now(), models });
      } catch (e: any) {
        error = String(e?.message ?? e);
        models = [env.xaiModel];
      }
    }
    out.push({ id: DEFAULT_PROVIDER_ID, name: env.xaiChatMode ? 'Default (environment)' : 'Default (xAI)', baseUrl: env.xaiBaseUrl, models, ok: !error, error, isDefault: true });
  }
  for (const r of providerRows(userId)) {
    let models: string[] = [];
    let error: string | undefined;
    const c = cache.get(r.id);
    if (c && Date.now() - c.at < CACHE_MS) models = c.models;
    else {
      try {
        models = await fetchModels(r.base_url, r.api_key);
        cache.set(r.id, { at: Date.now(), models });
        db.prepare('UPDATE model_providers SET models_cache=?, last_error=NULL WHERE id=?').run(JSON.stringify(models), r.id);
      } catch (e: any) {
        error = String(e?.message ?? e);
        try { models = JSON.parse(r.models_cache ?? '[]'); } catch { models = []; }
        db.prepare('UPDATE model_providers SET last_error=? WHERE id=?').run(error, r.id);
      }
    }
    out.push({ id: r.id, name: r.name, baseUrl: r.base_url, models, ok: !error, error });
  }
  return out;
}

export function createProvider(userId: string, name: string, baseUrl: string, apiKey: string): string {
  const id = 'prv_' + Math.random().toString(36).slice(2, 10);
  db.prepare('INSERT INTO model_providers(id,user_id,name,base_url,api_key,created_at) VALUES (?,?,?,?,?,?)')
    .run(id, userId, name.trim(), baseUrl.trim().replace(/\/$/, ''), apiKey ?? '', now());
  return id;
}

export function deleteProvider(userId: string, id: string): boolean {
  return db.prepare('DELETE FROM model_providers WHERE id=? AND user_id=?').run(id, userId).changes > 0;
}

export function providerById(userId: string, id: string): any | null {
  return (db.prepare('SELECT * FROM model_providers WHERE id=? AND user_id=?').get(id, userId) as any) ?? null;
}

// ---------- model routing ----------

const clientCache = new Map<string, OpenAI>();

/** Resolve a bot's model string to the client/model that serves it.
 *  `fallbackNotice` is set when a custom provider had to be bypassed, so the
 *  caller can surface it to the user instead of routing silently. */
export function resolveModel(modelStr: string | null | undefined, userId?: string): { client: OpenAI; model: string; baseURL: string; chatMode: boolean; fallbackNotice?: string } {
  let baseURL = env.xaiBaseUrl;
  let apiKey = env.xaiKey;
  let model = (modelStr || env.xaiModel).trim();
  let fallbackNotice: string | undefined;
  if (model.startsWith('prv_') && model.includes('/')) {
    const [pid, ...rest] = model.split('/');
    model = rest.join('/') || env.xaiModel;
    const p = userId ? providerById(userId, pid) : null;
    if (p) { baseURL = p.base_url; apiKey = p.api_key; }
    else {
      model = env.xaiModel; // provider deleted: fall back to the default (with a notice)
      fallbackNotice = `Model provider "${pid}" no longer exists — using the default provider (${env.xaiModel}) instead.`;
    }
  }
  const chatMode = !baseURL.includes('api.x.ai');
  const key = `${baseURL}\u0000${apiKey}`;
  let client = clientCache.get(key);
  if (!client) {
    client = new OpenAI({ apiKey, baseURL, timeout: 360_000 });
    clientCache.set(key, client);
  }
  return { client, model, baseURL, chatMode, fallbackNotice };
}

/** Short label for the UI ("glm-5.3", not "prv_ab12cd34/glm-5.3"). */
export const modelLabel = (m: string | null | undefined) => (m ? m.split('/').pop()! : '');
