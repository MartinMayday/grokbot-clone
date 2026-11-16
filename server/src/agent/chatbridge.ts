/**
 * Chat Completions bridge.
 *
 * grokbot's agent loop, history store and UI are built around the xAI Responses API
 * item shapes ({type:'function_call'}, {role:'user'}, output_text deltas, ...).
 * Self-hosted forks run on providers that only expose OpenAI Chat Completions
 * (e.g. Z.AI GLM). This module converts on the fly at the model-call seam so that
 * nothing else in the server has to change:
 *
 *   - toChatTools:      Responses tool defs / ToolDefs -> chat `tools` format
 *                       (xAI server-side tools like web_search are dropped: they
 *                       have no Chat Completions equivalent).
 *   - toChatMessages:   stored Responses history -> chat messages
 *                       (assistant tool_calls + role:'tool' replies; images inside
 *                       tool outputs are flattened to text placeholders because the
 *                       Chat Completions tool role is text-only).
 *   - chatStreamToResponses: a chat.completions stream -> Responses-API events
 *                       (response.output_text.delta / output_item.done /
 *                       response.completed), synthesizing a Responses-shaped
 *                       `final.output` so history stays in the upstream format.
 */

export function toChatTools(tools: any[]): any[] {
  const out: any[] = [];
  for (const t of tools ?? []) {
    if (t?.type === 'function' && t.name) {
      out.push({ type: 'function', function: { name: t.name, description: t.description ?? '', parameters: t.parameters ?? { type: 'object', properties: {} } } });
    } else if (t?.type === 'function' && t.function?.name) {
      out.push(t); // already chat-shaped (e.g. Composio)
    }
  }
  return out;
}

function partsToChat(content: any): any {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : String(content);
  const parts: any[] = [];
  for (const c of content) {
    if (c?.type === 'input_text' || c?.type === 'output_text' || c?.type === 'text') parts.push({ type: 'text', text: String(c.text ?? '') });
    else if (c?.type === 'input_image' && c.image_url) parts.push({ type: 'image_url', image_url: { url: c.image_url, detail: c.detail ?? 'high' } });
  }
  return parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts;
}

function partsToPlainText(content: any): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : String(content);
  return content
    .map((c: any) =>
      c?.type === 'input_text' || c?.type === 'output_text' || c?.type === 'text'
        ? String(c.text ?? '')
        : c?.type === 'input_image'
          ? '[screenshot omitted: tool outputs are text-only on this provider]'
          : '',
    )
    .join('');
}

/** Convert a stored Responses-API history (as built by loop.ts) into Chat Completions messages. */
export function toChatMessages(input: any[]): any[] {
  const msgs: any[] = [];
  let pendingCalls: any[] = [];
  const flushCalls = () => {
    if (pendingCalls.length) {
      msgs.push({ role: 'assistant', content: null, tool_calls: pendingCalls });
      pendingCalls = [];
    }
  };
  for (const it of input ?? []) {
    if (it?.type === 'reasoning' || it?.type === 'compaction' || it?.type === 'web_search_call' || it?.type === 'x_search_call') continue;
    if (it?.type === 'function_call') {
      pendingCalls.push({ id: it.call_id, type: 'function', function: { name: it.name, arguments: String(it.arguments ?? '{}') } });
      continue;
    }
    if (it?.type === 'function_call_output') {
      flushCalls();
      msgs.push({ role: 'tool', tool_call_id: it.call_id, content: partsToPlainText(it.output) });
      continue;
    }
    if (it?.type === 'message' || it?.role === 'assistant') {
      flushCalls();
      msgs.push({ role: 'assistant', content: partsToChat(it.content) });
      continue;
    }
    if (it?.role === 'user' || it?.role === 'system') {
      flushCalls();
      msgs.push({ role: it.role, content: partsToChat(it.content) });
      continue;
    }
  }
  flushCalls();
  return msgs;
}

/** One-shot (non-streaming) helper returning plain text, used by memory compaction. */
export function chatOnceText(xai: any, model: string, system: string, user: string, lowPriority = false): Promise<string> {
  return xai.chat.completions
    .create({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] })
    .then((res: any) => String(res?.choices?.[0]?.message?.content ?? '').trim());
}

/**
 * Wrap a chat.completions stream so the consumer sees Responses-API events.
 * Emits exactly the event shapes loop.ts handles, ending with response.completed
 * carrying a Responses-shaped output array (assistant message + function_call items).
 */
export async function* chatStreamToResponses(stream: AsyncIterable<any>): AsyncGenerator<any> {
  let text = '';
  let started = false;
  const toolAcc = new Map<number, { id: string; name: string; args: string }>();
  let usage: any = null;
  for await (const chunk of stream) {
    if (chunk?.usage) usage = chunk.usage;
    const choice = chunk?.choices?.[0];
    if (!choice) continue;
    const d = choice.delta ?? {};
    if (d.content) {
      if (!started) {
        started = true;
        yield { type: 'response.output_item.added', item: { type: 'message' } };
      }
      text += d.content;
      yield { type: 'response.output_text.delta', delta: d.content };
    }
    for (const tc of d.tool_calls ?? []) {
      const cur = toolAcc.get(tc.index) ?? { id: '', name: '', args: '' };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name += tc.function.name;
      if (tc.function?.arguments) cur.args += tc.function.arguments;
      toolAcc.set(tc.index, cur);
    }
  }
  const output: any[] = [];
  if (text) {
    const item = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text, annotations: [] }] };
    yield { type: 'response.output_item.done', item };
    output.push(item);
  }
  for (const [, tc] of [...toolAcc.entries()].sort((a, b) => a[0] - b[0])) {
    if (!tc.id) tc.id = 'call_' + Math.random().toString(36).slice(2, 14);
    if (!tc.name) tc.name = 'unknown_tool';
    output.push({ type: 'function_call', call_id: tc.id, name: tc.name, arguments: tc.args || '{}' });
  }
  yield {
    type: 'response.completed',
    response: {
      usage: usage ? { input_tokens: usage.prompt_tokens, output_tokens: usage.completion_tokens } : undefined,
      output,
    },
  };
}
