function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

/**
 * Dual provider support. Upstream grokbot speaks the xAI Responses API; self-hosted
 * forks can point XAI_BASE_URL at any OpenAI Chat Completions provider (e.g. Z.AI GLM),
 * in which case agent/chatbridge.ts converts histories and streams on the fly.
 */
const xaiBaseUrl = process.env.ZAI_BASE_URL ?? process.env.XAI_BASE_URL ?? 'https://api.x.ai/v1';
const xaiChatMode =
  process.env.XAI_CHAT_MODE !== undefined
    ? /^(1|true|yes)$/i.test(process.env.XAI_CHAT_MODE)
    : !xaiBaseUrl.includes('api.x.ai');

export const env = {
  port: Number(process.env.PORT ?? 8787),
  appUrl: process.env.APP_URL ?? 'http://localhost:5173',
  /** Public URL of this server, used for OAuth callbacks. */
  serverUrl: process.env.SERVER_URL ?? `http://localhost:${process.env.PORT ?? 8787}`,
  /** ZAI_API_KEY is the self-hosted spelling; XAI_API_KEY kept for upstream compatibility. */
  xaiKey: process.env.ZAI_API_KEY ?? req('XAI_API_KEY'),
  xaiModel: process.env.XAI_MODEL ?? 'grok-4.7',
  xaiBaseUrl,
  xaiChatMode,
  /** Optional on self-hosted forks: tool integrations degrade gracefully when unset. */
  composioKey: process.env.COMPOSIO_API_KEY ?? '',
  /** Kept for Orgo-cloud deployments; the E2B adapter ignores it. */
  orgoKey: process.env.ORGO_API_KEY ?? '',
  /** E2B self-hosted agent compute (replaces Orgo cloud computers). */
  e2bApiKey: process.env.E2B_API_KEY ?? '',
  e2bDomain: process.env.E2B_DOMAIN ?? '',
  e2bTemplate: process.env.E2B_TEMPLATE ?? 'base',
  /** Orgo workspace that holds every user's box. */
  orgoWorkspaceId: process.env.ORGO_WORKSPACE_ID ?? '',
  /** Orgo box size for new users. */
  orgoRamGb: Number(process.env.ORGO_RAM_GB ?? 8),
  orgoCpu: Number(process.env.ORGO_CPU ?? 2),
  orgoResolution: process.env.ORGO_RESOLUTION ?? '1280x800x24',
  sessionSecret: req('SESSION_SECRET'),
  devLogin: process.env.DEV_LOGIN === '1',
  dbPath: process.env.DB_PATH ?? new URL('../../data/grokbot.db', import.meta.url).pathname,
};
