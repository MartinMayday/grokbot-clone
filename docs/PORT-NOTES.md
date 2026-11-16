# Port notes — grokbot on GLM (Z.AI) + self-hosted E2B

This fork keeps upstream xAI/Orgo/Composio support but adds two self-hosting
swaps that can be enabled purely through configuration:

1. **Model provider: any OpenAI Chat Completions API** (e.g. Z.AI `glm-5.3`)
2. **Computers: self-hosted E2B sandboxes** instead of Orgo cloud computers

## What changed

| File | Change |
| --- | --- |
| `server/src/env.ts` | `XAI_BASE_URL`, auto `XAI_CHAT_MODE`, optional `COMPOSIO_API_KEY`/`ORGO_API_KEY`, new `E2B_*` config |
| `server/src/agent/chatbridge.ts` | **new** — converts Responses-API history/tools/streams ↔ Chat Completions at the model-call seam |
| `server/src/agent/loop.ts` | OpenAI client honors `XAI_BASE_URL`; `callModel` has a dual mode (Responses vs bridged Chat) |
| `server/src/agent/memory.ts` | compaction summary + memory consolidation calls work in both modes; xAI-only `/responses/compact` is skipped in chat mode |
| `server/src/orgo.ts` | rewritten as an **E2B adapter** with the identical exported surface (computers, screens, screenshot/click/type/key/scroll/drag, bash, exportFile, VNC) |
| `server/src/vnc.ts` | VNC relay prefers the adapter-provided `wsUrl` + `wsHeaders` (client-proxy header routing) over the Orgo websockify URL |
| `server/src/composio.ts` | `composio` is `null` and the catalog empty when `COMPOSIO_API_KEY` is unset |
| `server/env.example` | documented self-hosted configuration |

History, tool approvals, the web UI and the SQLite schema are untouched: the
bridge converts at the call boundary, and everything stored stays in the
upstream Responses-API item format (so a deployment can move back to xAI
without migration).

## Provider swap (GLM on Z.AI)

```env
XAI_API_KEY=<zai key>
XAI_MODEL=glm-5.3
XAI_BASE_URL=https://api.z.ai/api/coding/paas/v4
```

Chat mode is enabled automatically for non-x.ai base URLs. Known degradations
on chat-completions providers:

- xAI server-side tools (`web_search`, `x_search`) do not exist — they are dropped.
- Screenshots inside tool outputs are flattened to text placeholders (the
  Chat Completions `tool` role is text-only), so vision-driven computer use
  depends on the model accepting `image_url` parts in user messages.
- Voice (realtime/TTS/STT) remains xAI-only; voice features will fail politely.

## Computer swap (self-hosted E2B)

The adapter maps the Orgo model onto E2B sandboxes:

- one sandbox per user computer; bootstrap installs Xvfb, xdotool, x11vnc,
  websockify, openbox, chromium (Debian base template) at creation
- screens are Xvfb displays (`:0` is `default`, extras `:1..:3`), each with
  its own x11vnc + websockify port
- suspend kills the sandbox, start/resume provisions a fresh one under the
  same stable computer id (state in `data/e2b-computers.json`)
- VNC reaches the sandbox websockify through the E2B client proxy using
  `E2b-Sandbox-Id`/`E2b-Sandbox-Port` header routing (port-based addressing,
  no wildcard DNS required)
- `exportFile` inlines bytes as a `data:` URL (8 MB cap) — self-hosted E2B
  has no signed-URL storage

```env
E2B_API_KEY=<self-hosted key>
E2B_API_URL=http://<e2b-host>:3000
E2B_SANDBOX_URL=http://<e2b-host>:3002
E2B_TEMPLATE=base
```

First computer creation takes a few minutes (apt bootstrap); a custom E2B
template with the desktop stack pre-baked would remove that cold-start.
