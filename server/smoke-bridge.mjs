import OpenAI from 'openai';
import { toChatMessages, toChatTools, chatStreamToResponses } from './dist/agent/chatbridge.js';
const xai = new OpenAI({ apiKey: process.env.ZAI_KEY, baseURL: 'https://api.z.ai/api/coding/paas/v4', timeout: 120_000 });
const input = [
  { role: 'system', content: 'You are a test bot. Use the ping tool when asked.' },
  { role: 'user', content: 'Call the ping tool with host example.com now.' },
];
const tools = [{ type: 'function', name: 'ping', description: 'Ping a host', parameters: { type: 'object', properties: { host: { type: 'string' } }, required: ['host'] } }];
const body = { model: 'glm-5.3', messages: toChatMessages(input), tools: toChatTools(tools), stream: true, stream_options: { include_usage: true } };
const raw = await xai.chat.completions.create(body);
let text = '', final = null;
for await (const ev of chatStreamToResponses(raw)) {
  if (ev.type === 'response.output_text.delta') text += ev.delta;
  if (ev.type === 'response.completed') final = ev.response;
}
console.log('text:', JSON.stringify(text) || '(none)');
console.log('output items:', final.output.map((o) => o.type + (o.name ? ':' + o.name : '')));
const call = final.output.find((o) => o.type === 'function_call');
console.log('call args:', call?.arguments);
console.log('usage:', JSON.stringify(final.usage));
if (!call || JSON.parse(call.arguments).host !== 'example.com') { console.log('SMOKE_FAIL'); process.exit(1); }
console.log('SMOKE_PASS');
