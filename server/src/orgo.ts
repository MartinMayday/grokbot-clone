/**
 * Computer backend on self-hosted E2B agent compute.
 *
 * Upstream grokbot drives Orgo cloud computers (www.orgo.ai). This module keeps
 * the exact same exported surface but backs it with E2B sandboxes on your own
 * infrastructure, so computer.ts / tools.ts / vnc.ts / routes-config.ts work
 * unchanged.
 *
 * Connection (picked up from the environment by the e2b SDK):
 *   E2B_API_KEY        api key of the self-hosted E2B deployment
 *   E2B_API_URL        orchestrator API   (e.g. http://192.168.100.252:3000)
 *   E2B_SANDBOX_URL    client proxy       (e.g. http://192.168.100.252:3002)
 *
 * Mapping:
 *   Orgo computer     -> one E2B sandbox (Debian base; Xvfb, xdotool, x11vnc,
 *                        websockify, openbox, chromium installed at creation)
 *   Orgo screen       -> one Xvfb display. "default" is :0 (always present);
 *                        extra screens are :1..:3, each with its own
 *                        x11vnc + websockify port pair.
 *   suspend / resume  -> kill the sandbox / create a fresh one under the same
 *                        computer id (E2B sandboxes are ephemeral; the id in
 *                        our state file is the stable handle).
 *   VNC websockify    -> the client proxy with E2b-Sandbox-Id /
 *                        E2b-Sandbox-Port header routing (port-based
 *                        addressing — no wildcard DNS needed).
 *   exportFile        -> file bytes inlined as a data: URL (self-hosted has no
 *                        signed-URL storage; capped at 8 MB).
 */
import { Sandbox } from 'e2b';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { env } from './env.js';

export class OrgoError extends Error {
  constructor(public status: number, public code: string | undefined, message: string, public body?: unknown) {
    super(message);
  }
}

export interface OrgoComputer {
  id: string;
  instance_id?: string;
  status: string;
  name: string;
  resolution?: string;
  vnc_password?: string | null;
  asleep?: { where: 'host' | 'storage'; waking?: { expected_seconds?: number } } | null;
}

export interface OrgoScreen { id: string; display: string; width: number; height: number; default: boolean }

// ---------- state (file-backed; sandbox ids change on every wake) ----------

interface ScreenRec { display: string; vncPort: number; wsPort: number }
interface ComputerRec {
  id: string;
  name: string;
  sandboxId: string | null;
  status: 'running' | 'stopped' | 'suspended';
  vncPassword: string;
  screens: Record<string, ScreenRec>;
}

const STATE_FILE = path.join(path.dirname(env.dbPath), 'e2b-computers.json');
let state: Record<string, ComputerRec> | null = null;

function loadState(): Record<string, ComputerRec> {
  if (!state) {
    try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { state = {}; }
  }
  return state!;
}
function saveState() {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(loadState(), null, 2));
}
function recOf(id: string): ComputerRec {
  const r = loadState()[id];
  if (!r) throw new OrgoError(404, 'not_found', `Computer ${id} not found`, { id });
  return r;
}

const [RES_W, RES_H] = (() => {
  const m = /^(\d+)x(\d+)/.exec(env.orgoResolution);
  return m ? [Number(m[1]), Number(m[2])] : [1280, 800];
})();

/** Self-hosted E2B caps sandbox lifetime at 1 h; stay just under and refresh
 *  the timer on every connect, so actively-used computers never expire. */
const SANDBOX_LIFETIME_MS = 55 * 60 * 1000;

const shq = (s: string) => `'` + String(s).replace(/'/g, `'\\''`) + `'`;

function requireE2B() {
  if (!process.env.E2B_API_KEY && !env.e2bApiKey) {
    throw new OrgoError(500, 'e2b_unconfigured', 'E2B_API_KEY is not set — self-hosted computers are unavailable');
  }
}

async function connectSandbox(sandboxId: string | null): Promise<Sandbox | null> {
  if (!sandboxId) return null;
  try {
    const sbx = await Sandbox.connect(sandboxId);
    await sbx.commands.run('true', { timeoutMs: 8_000, user: 'root' });
    void sbx.setTimeout(SANDBOX_LIFETIME_MS).catch(() => {});
    return sbx;
  } catch {
    return null;
  }
}

async function liveSandbox(id: string): Promise<{ sbx: Sandbox; rec: ComputerRec }> {
  const r = recOf(id);
  const sbx = await connectSandbox(r.sandboxId);
  if (!sbx) throw new OrgoError(409, 'not_running', `Computer ${id} is not running`, { id });
  return { sbx, rec: r };
}

async function run(sbx: Sandbox, cmd: string, opts: { timeoutMs?: number; envs?: Record<string, string>; root?: boolean } = {}) {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  return sbx.commands.run(cmd, {
    timeoutMs,
    // The SDK caps the whole request at 60s by default; long commands need it raised too.
    requestTimeoutMs: timeoutMs + 15_000,
    envs: opts.envs,
    ...(opts.root === false ? {} : { user: 'root' as const }),
  });
}

// ---------- in-sandbox desktop setup ----------

const BOOT_APT = [
  'set -e',
  'export DEBIAN_FRONTEND=noninteractive',
  'if ! command -v Xvfb >/dev/null 2>&1 || ! command -v xdotool >/dev/null 2>&1; then',
  '  apt-get update -qq >/dev/null 2>&1 || true',
  '  # One big apt-get install trips dpkg in this sandbox; sequential groups are reliable.',
  '  for pkgs in "xvfb xdotool x11vnc" "imagemagick" "websockify" "openbox" "chromium"; do',
  '    apt-get install -y -qq $pkgs >/dev/null 2>&1 || true',
  '  done',
  '  dpkg --configure -a >/dev/null 2>&1 || true',
  'fi',
  'command -v Xvfb >/dev/null && echo X_OK || echo X_MISSING',
  'command -v chromium >/dev/null 2>&1 || command -v chromium-browser >/dev/null 2>&1 && echo BROWSER_OK || echo BROWSER_MISSING',
].join('\n');

function startDisplayCmd(display: string, vncPort: number, wsPort: number, password: string) {
  return [
    `pkill -f "Xvfb ${display}" 2>/dev/null || true`,
    `pkill -f "x11vnc.*rfbport ${vncPort}" 2>/dev/null || true`,
    `pkill -f "websockify.*${wsPort}" 2>/dev/null || true`,
    'sleep 0.3',
    `nohup Xvfb ${display} -screen 0 ${RES_W}x${RES_H}x24 -nolisten tcp >/dev/null 2>&1 &`,
    'sleep 0.6',
    'if command -v openbox >/dev/null 2>&1; then DISPLAY=' + display + ' nohup openbox >/dev/null 2>&1 & sleep 0.4; fi',
    `nohup x11vnc -display ${display} -rfbport ${vncPort} -passwd ${shq(password)} -forever -shared -noxdamage -bg >/dev/null 2>&1`,
    'sleep 0.4',
    `nohup websockify ${wsPort} localhost:${vncPort} >/dev/null 2>&1 &`,
    'sleep 0.5',
    `curl -s -o /dev/null http://127.0.0.1:${wsPort}/ 2>/dev/null; echo started_${display}`,
  ].join('\n');
}

const screenObj = (id: string, r: ScreenRec): OrgoScreen =>
  ({ id, display: r.display, width: RES_W, height: RES_H, default: id === 'default' });

const displayFor = (r: ComputerRec, screen?: string) =>
  screen && screen !== 'default' ? r.screens[screen]?.display ?? ':0' : r.screens['default']?.display ?? ':0';

/** Create a fresh sandbox and bring up every recorded display on it. */
async function provisionSandbox(rec: ComputerRec): Promise<void> {
  requireE2B();
  const sbx = await Sandbox.create(env.e2bTemplate, { timeoutMs: SANDBOX_LIFETIME_MS });
  try {
    const boot = await run(sbx, BOOT_APT, { timeoutMs: 300_000 });
    if (!String(boot.stdout).includes('X_OK')) {
      throw new OrgoError(500, 'bootstrap_failed', `Could not install a desktop stack in the sandbox (got: ${String(boot.stdout).trim() || boot.stderr})`);
    }
    for (const [screenId, s] of Object.entries(rec.screens)) {
      await run(sbx, startDisplayCmd(s.display, s.vncPort, s.wsPort, rec.vncPassword), { timeoutMs: 30_000 });
      if (screenId !== 'default') void screenId;
    }
  } catch (e) {
    void sbx.kill().catch(() => {});
    throw e;
  }
  rec.sandboxId = sbx.sandboxId;
  rec.status = 'running';
  saveState();
}

// ---------- the orgo-compatible surface ----------

export const orgo = {
  workspaces: async (): Promise<any> => [{ id: 'e2b', name: 'Self-hosted E2B' }],

  createComputer: async (name: string, _idempotencyKey: string): Promise<OrgoComputer> => {
    requireE2B();
    const rec: ComputerRec = {
      id: 'e2b-' + randomBytes(5).toString('hex'),
      name,
      sandboxId: null,
      status: 'stopped',
      vncPassword: randomBytes(4).toString('hex'), // VNC auth uses 8 chars max
      screens: { default: { display: ':0', vncPort: 5900, wsPort: 6080 } },
    };
    loadState()[rec.id] = rec;
    await provisionSandbox(rec);
    return { id: rec.id, instance_id: rec.sandboxId!, status: 'running', name, resolution: `${RES_W}x${RES_H}x24` };
  },

  getComputer: async (id: string): Promise<OrgoComputer> => {
    const r = recOf(id);
    if (r.status === 'running') {
      const alive = await connectSandbox(r.sandboxId);
      if (!alive) { r.status = 'stopped'; saveState(); }
    }
    return { id: r.id, instance_id: r.sandboxId ?? undefined, status: r.status === 'running' ? 'running' : r.status, name: r.name, resolution: `${RES_W}x${RES_H}x24` };
  },

  start: async (id: string) => { const r = recOf(id); await provisionSandbox(r); return {}; },
  resume: async (id: string) => { const r = recOf(id); await provisionSandbox(r); return {}; },
  suspend: async (id: string) => {
    const r = recOf(id);
    const sbx = await connectSandbox(r.sandboxId);
    if (sbx) await sbx.kill().catch(() => {});
    r.sandboxId = null;
    r.status = 'suspended';
    saveState();
    return {};
  },

  /** VNC access. On E2B the websockify endpoint is reached through the client
   *  proxy with header routing, so we hand back a ws url + headers pair. */
  vncPassword: async (id: string, screen?: string): Promise<{ password: string; desktop_api_token: string; wsUrl?: string; wsHeaders?: Record<string, string> }> => {
    const { sbx, rec: r } = await liveSandbox(id);
    void sbx;
    const s = (screen && screen !== 'default' ? r.screens[screen] : undefined) ?? r.screens['default'];
    const base = (process.env.E2B_SANDBOX_URL || 'http://192.168.100.252:3002').replace(/^http/, 'ws').replace(/\/$/, '');
    return {
      password: r.vncPassword,
      desktop_api_token: '',
      wsUrl: `${base}/`,
      wsHeaders: { 'E2b-Sandbox-Id': r.sandboxId!, 'E2b-Sandbox-Port': String(s.wsPort) },
    };
  },

  listScreens: async (id: string): Promise<OrgoScreen[]> => {
    const r = recOf(id);
    return Object.entries(r.screens).map(([sid, s]) => screenObj(sid, s));
  },
  createScreen: async (id: string): Promise<OrgoScreen> => {
    const { sbx, rec: r } = await liveSandbox(id);
    const extras = Object.keys(r.screens).filter((s) => s !== 'default');
    if (extras.length >= 3) throw new OrgoError(400, 'limit_reached', 'This computer already has the maximum of 4 screens');
    const n = extras.length + 1;
    const sid = `screen-${n}`;
    const s: ScreenRec = { display: `:${n}`, vncPort: 5900 + n, wsPort: 6080 + n };
    await run(sbx, startDisplayCmd(s.display, s.vncPort, s.wsPort, r.vncPassword), { timeoutMs: 30_000 });
    r.screens[sid] = s;
    saveState();
    return screenObj(sid, s);
  },
  getScreen: async (id: string, screen: string): Promise<OrgoScreen> => {
    const r = recOf(id);
    const s = r.screens[screen];
    if (!s) throw new OrgoError(404, 'not_found', `Screen ${screen} not found`, { id, screen });
    return screenObj(screen, s);
  },
  deleteScreen: async (id: string, screen: string): Promise<void> => {
    const { sbx, rec: r } = await liveSandbox(id);
    const s = r.screens[screen];
    if (!s) return;
    if (screen === 'default') throw new OrgoError(400, 'bad_request', 'The default screen cannot be deleted');
    await run(sbx, `pkill -f "Xvfb ${s.display}" 2>/dev/null; pkill -f "x11vnc.*rfbport ${s.vncPort}" 2>/dev/null; pkill -f "websockify.*${s.wsPort}" 2>/dev/null; true`, { timeoutMs: 15_000 });
    delete r.screens[screen];
    saveState();
  },

  screenshot: async (id: string, screen?: string) => {
    const { sbx, rec: r } = await liveSandbox(id);
    const res = await run(sbx, 'import -window root -quality 75 jpeg:- 2>/dev/null | base64 -w0', {
      timeoutMs: 20_000,
      envs: { DISPLAY: displayFor(r, screen) },
      root: false,
    });
    return { image: String(res.stdout).trim(), mime_type: 'image/jpeg', width: RES_W, height: RES_H };
  },

  click: async (id: string, screen: string | undefined, b: { x: number; y: number; button?: string; double?: boolean }) => {
    const { sbx, rec: r } = await liveSandbox(id);
    const btn = b.button === 'right' ? 3 : b.button === 'middle' ? 2 : 1;
    await run(sbx, `xdotool mousemove ${Math.round(b.x)} ${Math.round(b.y)} click ${b.double ? '--repeat 2 --delay 150' : ''} ${btn}`, { timeoutMs: 10_000, envs: { DISPLAY: displayFor(r, screen) }, root: false });
  },
  move: async (id: string, screen: string | undefined, b: { x: number; y: number }) => {
    const { sbx, rec: r } = await liveSandbox(id);
    await run(sbx, `xdotool mousemove ${Math.round(b.x)} ${Math.round(b.y)}`, { timeoutMs: 10_000, envs: { DISPLAY: displayFor(r, screen) }, root: false });
  },
  drag: async (id: string, screen: string | undefined, b: { start_x: number; start_y: number; end_x: number; end_y: number }) => {
    const { sbx, rec: r } = await liveSandbox(id);
    await run(sbx, `xdotool mousemove ${Math.round(b.start_x)} ${Math.round(b.start_y)} mousedown 1 mousemove --sync ${Math.round(b.end_x)} ${Math.round(b.end_y)} mouseup 1`, { timeoutMs: 20_000, envs: { DISPLAY: displayFor(r, screen) }, root: false });
  },
  type: async (id: string, screen: string | undefined, text: string) => {
    const { sbx, rec: r } = await liveSandbox(id);
    for (let i = 0; i < text.length; i += 1200) {
      await run(sbx, `xdotool type --delay 12 -- ${shq(text.slice(i, i + 1200))}`, { timeoutMs: 60_000, envs: { DISPLAY: displayFor(r, screen) }, root: false });
    }
  },
  key: async (id: string, screen: string | undefined, key: string) => {
    const { sbx, rec: r } = await liveSandbox(id);
    await run(sbx, `xdotool key ${shq(key)}`, { timeoutMs: 10_000, envs: { DISPLAY: displayFor(r, screen) }, root: false });
  },
  scroll: async (id: string, screen: string | undefined, b: { x: number; y: number; direction: 'up' | 'down'; amount: number }) => {
    const { sbx, rec: r } = await liveSandbox(id);
    const wheel = b.direction === 'up' ? 4 : 5;
    const amt = Math.max(1, Math.min(10, Math.round(b.amount ?? 3)));
    await run(sbx, `xdotool mousemove ${Math.round(b.x)} ${Math.round(b.y)} click --repeat ${amt} ${wheel}`, { timeoutMs: 10_000, envs: { DISPLAY: displayFor(r, screen) }, root: false });
  },

  bash: async (id: string, screen: string | undefined, command: string, timeout = 120) => {
    const { sbx, rec: r } = await liveSandbox(id);
    const res = await run(sbx, command, {
      timeoutMs: Math.min(Math.max(timeout, 5), 280) * 1000,
      envs: { DISPLAY: displayFor(r, screen) },
    });
    const output = (String(res.stdout ?? '') + String(res.stderr ?? '')).slice(0, 200_000);
    return { success: res.exitCode === 0, output, exit_code: res.exitCode ?? 1 };
  },

  /** Copy a file off a running computer. Self-hosted variant: inline as a data: URL. */
  exportFile: async (id: string, p: string) => {
    const { sbx } = await liveSandbox(id);
    const buf = Buffer.from(await sbx.files.read(p) as any);
    if (buf.length > 8 * 1024 * 1024) throw new OrgoError(413, 'too_large', 'File exceeds the 8 MB inline download limit');
    const name = path.basename(p);
    return { url: `data:application/octet-stream;name=${encodeURIComponent(name)};base64,${buf.toString('base64')}` };
  },
};
