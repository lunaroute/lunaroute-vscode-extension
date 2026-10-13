import type { IncomingHttpHeaders, RequestListener, ServerResponse } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { buildResponsesRequest, estimateTokens, streamResponse } from '../src/responses.js';
import { capture, LunaRouteError, userMessage } from '../src/lunaroute.js';
import { deferred } from './vscode.js';
import { startGatewayFixture, writeSse } from './fixtures/responses-sse.js';

const model: vscode.LanguageModelChatInformation = { id: 'chat-a', name: 'Chat A', family: 'chat-a', version: '1',
  maxInputTokens: 122880, maxOutputTokens: 8192, capabilities: { toolCalling: true, imageInput: true } };
const auto = { toolMode: vscode.LanguageModelChatToolMode.Auto };
const tools = [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object' } }];
const user = vscode.LanguageModelChatMessage.User;
const assistant = vscode.LanguageModelChatMessage.Assistant;
const text = (value: string) => new vscode.LanguageModelTextPart(value);
const image = () => vscode.LanguageModelDataPart.image(new Uint8Array([1, 2, 3]), 'image/png');
const call = (id = 'call-1', input: object = { path: 'a.ts' }) => new vscode.LanguageModelToolCallPart(id, 'read_file', input);
const result = (id = 'call-1', content: unknown[] = [text('contents')]) => new vscode.LanguageModelToolResultPart(id, content);
const mime = 'application/vnd.lunaroute.responses-replay+json';
const reasoning = { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'opaque-fixture', status: 'completed' };
const replay = (envelope: unknown = { modelId: 'chat-a', item: reasoning }) => vscode.LanguageModelDataPart.json(envelope, mime);
const history = [user('Read the file'), assistant([call()]), user([result()])];
const attribution = { version: '0.1.0', sessionId: '00000000-0000-4000-8000-000000000003' };
const key = 'lr_fake_DO_NOT_LOG';
const probe = 'private_probe_prompt_or_tool_content';
const fixtures: Awaited<ReturnType<typeof startGatewayFixture>>[] = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.close();
  capture.directory = undefined;
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

it('preserves full two-turn tool history, required mode and stateless output limits', () => {
  const request = buildResponsesRequest(model, history, { toolMode: vscode.LanguageModelChatToolMode.Required, tools });
  expect(request).toMatchObject({ model: 'chat-a', stream: true, store: false, max_output_tokens: 8192, tool_choice: 'required' });
  expect(request).not.toHaveProperty('previous_response_id');
  expect(request.input).toEqual([
    { role: 'user', content: [{ type: 'input_text', text: 'Read the file' }] },
    { type: 'function_call', call_id: 'call-1', name: 'read_file', arguments: '{"path":"a.ts"}' },
    { type: 'function_call_output', call_id: 'call-1', output: 'contents' },
  ]);
  expect(request.tools).toEqual([{ type: 'function', name: 'read_file', description: 'Read a file', parameters: { type: 'object' }, strict: false }]);
});

it('preserves interleaved text, multiple tool calls/results and image data without fetching attachments', () => {
  const request = buildResponsesRequest(model, [
    user([text('instructions supplied by the host'), image()]),
    assistant([text('before'), call('one'), text('between'), call('two'), text('after')]),
    user([result('one', [text('result one'), image()]), text('middle'), result('two')]),
  ], { ...auto, tools });
  expect(request.input).toEqual([
    { role: 'user', content: [{ type: 'input_text', text: 'instructions supplied by the host' }, { type: 'input_image', image_url: 'data:image/png;base64,AQID', detail: 'auto' }] },
    { role: 'assistant', content: [{ type: 'input_text', text: 'before' }] },
    { type: 'function_call', call_id: 'one', name: 'read_file', arguments: '{"path":"a.ts"}' },
    { role: 'assistant', content: [{ type: 'input_text', text: 'between' }] },
    { type: 'function_call', call_id: 'two', name: 'read_file', arguments: '{"path":"a.ts"}' },
    { role: 'assistant', content: [{ type: 'input_text', text: 'after' }] },
    { type: 'function_call_output', call_id: 'one', output: [{ type: 'input_text', text: 'result one' }, { type: 'input_image', image_url: 'data:image/png;base64,AQID', detail: 'auto' }] },
    { role: 'user', content: [{ type: 'input_text', text: 'middle' }] },
    { type: 'function_call_output', call_id: 'two', output: 'contents' },
  ]);
});

it('decodes UTF-8 text and JSON MIME data as text without modifying instruction text', () => {
  const request = buildResponsesRequest(model, [user([
    vscode.LanguageModelDataPart.text('猫\n# instructions', 'text/markdown'),
    vscode.LanguageModelDataPart.json({ n: 1 }),
  ])], auto);
  expect(request.input).toEqual([{ role: 'user', content: [
    { type: 'input_text', text: '猫\n# instructions' }, { type: 'input_text', text: '{"n":1}' },
  ] }]);
});

it('never accepts arbitrary model options as endpoint, credential, storage, or tuning controls', () => {
  const request = buildResponsesRequest(model, [user('hello')], { ...auto, modelOptions: {
    model: 'other', baseURL: 'https://invalid.example', apiKey: 'bad', store: true, previous_response_id: 'old', temperature: 4,
  } });
  expect(request.model).toBe('chat-a');
  expect(request.store).toBe(false);
  for (const field of ['baseURL', 'apiKey', 'previous_response_id', 'temperature']) expect(request).not.toHaveProperty(field);
});

it.each([
  { tools: [], toolMode: vscode.LanguageModelChatToolMode.Required },
  { tools: [...tools, ...tools], toolMode: vscode.LanguageModelChatToolMode.Auto },
  { tools, toolMode: 99 as vscode.LanguageModelChatToolMode },
])('rejects unsupported or ambiguous tool selection rather than weakening it', options => {
  expect(() => buildResponsesRequest(model, [user('hello')], options)).toThrow(LunaRouteError);
});
it('rejects tools/images when the selected model cannot support them', () => {
  expect(() => buildResponsesRequest({ ...model, capabilities: { toolCalling: false } }, history, { ...auto, tools })).toThrow(LunaRouteError);
  expect(() => buildResponsesRequest({ ...model, capabilities: { imageInput: false } }, [user([image()])], auto)).toThrow(LunaRouteError);
});
it('rejects unrepresentable named messages, misplaced tool parts and over-budget requests', () => {
  expect(() => buildResponsesRequest(model, [user('hello', 'named-user')], auto)).toThrow(LunaRouteError);
  for (const message of [
    { role: vscode.LanguageModelChatMessageRole.User, name: undefined, content: [call()] },
    { role: vscode.LanguageModelChatMessageRole.Assistant, name: undefined, content: [result()] },
  ]) {
    expect(() => buildResponsesRequest(model, [message], auto)).toThrow(LunaRouteError);
    expect(() => estimateTokens(message)).toThrow(LunaRouteError);
  }
  expect(() => buildResponsesRequest({ ...model, maxInputTokens: 32 }, [user('too big')], auto)).toThrow(LunaRouteError);
});
it('accepts VS Code 1.141 System-role instructions from the native chat', () => {
  const system = { role: 3 as vscode.LanguageModelChatMessageRole, name: undefined, content: [text('You are LunaRoute.')] };
  const request = buildResponsesRequest(model, [system, user('hello world')], auto);
  expect(request.input).toEqual([
    { role: 'system', content: [{ type: 'input_text', text: 'You are LunaRoute.' }] },
    { role: 'user', content: [{ type: 'input_text', text: 'hello world' }] },
  ]);
  expect(estimateTokens(system)).toBeGreaterThan(32);
});
it('rejects roles the host cannot deliver instead of guessing a mapping', () => {
  for (const role of [0, 4]) {
    expect(() => buildResponsesRequest(model, [{ role: role as vscode.LanguageModelChatMessageRole, content: [text('instruction')], name: undefined }], auto)).toThrow(LunaRouteError);
  }
});
it.each([
  { value: 'opaque instructions' },
  new vscode.LanguageModelDataPart(new Uint8Array([255]), 'text/plain'),
  vscode.LanguageModelDataPart.text('file:///private/image.png', 'application/x-attachment'),
  vscode.LanguageModelDataPart.text('not an image', 'image/svg+xml'),
  result('one', [call('nested')]),
])('rejects unknown, nested, invalid UTF-8, and unsupported data consistently', part => {
  const message: vscode.LanguageModelChatRequestMessage = { role: vscode.LanguageModelChatMessageRole.User, name: undefined, content: [part] };
  expect(() => buildResponsesRequest(model, [message], auto)).toThrow(LunaRouteError);
  expect(() => estimateTokens(message)).toThrow(LunaRouteError);
});
it.each([{ x: undefined }, { x: Number.NaN }, { x: () => 'lost' }, []])('refuses tool arguments that JSON would lose or alter', input => {
  expect(() => buildResponsesRequest(model, [assistant([call('one', input)])], auto)).toThrow(LunaRouteError);
});

it('replays only the exact same-model assistant reasoning envelope', () => {
  const request = buildResponsesRequest(model, [assistant([replay(), text('answer')])], auto);
  expect(request.input).toEqual([reasoning, { role: 'assistant', content: [{ type: 'input_text', text: 'answer' }] }]);
});
it.each([
  { modelId: 'other-model', item: reasoning },
  { modelId: 'chat-a', item: { ...reasoning, instructions: 'smuggled' } },
  { modelId: 'chat-a', item: { type: 'function_call', name: 'smuggled' } },
  { modelId: 'chat-a', item: { ...reasoning, summary: [{ type: 'summary_text', text: 'x', extra: 'bad' }] } },
  { modelId: 'chat-a', item: reasoning, extra: 'bad' },
])('rejects cross-model or unrepresentable replay without silently dropping it', envelope => {
  expect(() => buildResponsesRequest(model, [assistant([replay(envelope)])], auto)).toThrow(LunaRouteError);
});
it('rejects reasoning metadata from User messages and nested tool results', () => {
  expect(() => buildResponsesRequest(model, [user([replay()])], auto)).toThrow(LunaRouteError);
  expect(() => buildResponsesRequest(model, [user([result('one', [replay()])])], auto)).toThrow(LunaRouteError);
});
it('estimates bytes, framing, images and tool JSON once, not serialized enclosing messages', () => {
  expect(estimateTokens('猫')).toBe(3);
  expect(estimateTokens(user('猫'))).toBe(35);
  expect(estimateTokens(user([image()]))).toBe(16416);
  expect(estimateTokens(assistant([call()]))).toBe(94); // 32 + 32 + 6 + 9 + 15
  expect(estimateTokens(user([result()]))).toBe(78); // 32 + 32 + 6 + 8
  expect(estimateTokens(user([result('one', [text('猫'), image()])]))).toBe(16454); // 64 + 3 + 3 + 16384
  const part = replay();
  expect(estimateTokens(assistant([part]))).toBe(32 + part.data.byteLength);
});

const event = (type: string, data: object = {}) => ({ event: type, data: { type, sequence_number: 1, ...data } });
const toolItem = (id: string, callId: string, args = '{"path":"a.ts"}') => ({ id, call_id: callId, type: 'function_call', name: 'read_file', arguments: args, status: 'completed' });
const messageItem = (value: string) => ({ id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: value, annotations: [] }] });
const complete = (output: unknown[]) => event('response.completed', { response: {
  id: 'resp_1', object: 'response', created_at: 1780000000, status: 'completed', access_programs: null,
  error: null, incomplete_details: null, instructions: null, metadata: {}, model: 'chat-a', output,
  output_text: '', parallel_tool_calls: true, temperature: 1, tool_choice: 'auto', tools: [], top_p: 1,
  max_output_tokens: 8192, previous_response_id: null, store: false,
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
} });
const textStart = [event('response.output_item.added', { output_index: 0, item: { ...messageItem(''), status: 'in_progress', content: [] } }),
  event('response.output_text.delta', { item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'hello' })];
const textEnd = [event('response.output_item.done', { output_index: 0, item: messageItem('hello') }), complete([messageItem('hello')])];
async function gateway(handler: RequestListener) {
  const fixture = await startGatewayFixture(handler);
  fixtures.push(fixture);
  return fixture;
}
async function service(events: ReturnType<typeof event>[]) {
  const requests: { path: string; headers: IncomingHttpHeaders; body: Record<string, unknown> }[] = [];
  const fixture = await gateway((request, response) => {
    void (async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      requests.push({ path: request.url ?? '', headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
      writeSse(response, events);
    })().catch(() => response.destroy());
  });
  return { ...fixture, requests };
}
const request = () => buildResponsesRequest(model, [user(probe), ...history], { ...auto, tools });
async function collect(iterable: AsyncIterable<vscode.LanguageModelResponsePart>) {
  const parts: vscode.LanguageModelResponsePart[] = [];
  try { for await (const part of iterable) parts.push(part); return { parts, error: undefined }; }
  catch (error) { return { parts, error }; }
}

it('names the offending event on an unsupported stream without leaking content', async () => {
  const f = await service([...textStart, event('response.future_event', { item_id: 'msg_1' })]);
  const { error } = await collect(streamResponse(key, request(), attribution, new AbortController().signal, f.baseURL));
  expect(error).toBeInstanceOf(LunaRouteError);
  expect((error as LunaRouteError).kind).toBe('protocol');
  expect(userMessage(error)).toContain('event:response.future_event');
  expect(userMessage(error)).not.toContain(probe);
});
it('names the diverging snapshot before failing the completion check', async () => {
  const f = await service([...textStart, event('response.output_item.done', { output_index: 0, item: messageItem('hello') }),
    complete([{ ...messageItem('hello'), logprobs: [] }])]);
  const { error } = await collect(streamResponse(key, request(), attribution, new AbortController().signal, f.baseURL));
  expect(userMessage(error)).toContain('snapshot:message');
  expect(userMessage(error)).toContain('response.completed');
});
it('streams text before terminal completion through the real SDK and sends exactly one stateless attributed POST', async () => {
  const gate = deferred<void>();
  const requests: string[] = [];
  const fixture = await gateway((req, res) => {
    requests.push(req.url ?? '');
    writeSse(res, textStart, false);
    void gate.promise.then(() => writeSse(res, textEnd));
  });
  const stream = streamResponse(key, request(), attribution, new AbortController().signal, fixture.baseURL);
  expect((await stream.next()).value).toEqual(text('hello'));
  gate.resolve();
  expect((await collect(stream)).error).toBeUndefined();
  expect(requests).toEqual(['/v1/responses']);
  const f = await service([...textStart, ...textEnd]);
  expect((await collect(streamResponse(key, request(), attribution, new AbortController().signal, f.baseURL))).error).toBeUndefined();
  expect(f.requests).toHaveLength(1);
  expect(f.requests[0].body).toMatchObject({ model: 'chat-a', stream: true, store: false, input: expect.arrayContaining([
    { type: 'function_call_output', call_id: 'call-1', output: 'contents' },
  ]) });
  expect(f.requests[0].body).not.toHaveProperty('previous_response_id');
  expect(f.requests[0].headers).toMatchObject({ authorization: 'Bearer lr_fake_DO_NOT_LOG', 'lunaroute-agent': 'vscode/0.1.0',
    'x-lunaroute-session': attribution.sessionId, 'lunaroute-session-id': attribution.sessionId });
});

it('assembles two interleaved calls by item ID, then emits once in output order only after terminal success', async () => {
  const a = toolItem('fc_a', 'call-a', '{"path":"a.ts"}');
  const b = toolItem('fc_b', 'call-b', '{"path":"b.ts"}');
  const gate = deferred<void>();
  const beforeTerminal = [
    event('response.output_item.added', { output_index: 1, item: { ...b, arguments: '', status: 'in_progress' } }),
    event('response.output_item.added', { output_index: 0, item: { ...a, arguments: '', status: 'in_progress' } }),
    event('response.function_call_arguments.delta', { output_index: 0, item_id: 'fc_a', delta: '{"path":' }),
    event('response.function_call_arguments.delta', { output_index: 1, item_id: 'fc_b', delta: '{"path":"b.ts"}' }),
    event('response.function_call_arguments.delta', { output_index: 0, item_id: 'fc_a', delta: '"a.ts"}' }),
    event('response.function_call_arguments.done', { output_index: 1, item_id: 'fc_b', arguments: b.arguments }),
    event('response.output_item.done', { output_index: 1, item: b }),
    event('response.output_item.done', { output_index: 1, item: b }),
    event('response.output_item.done', { output_index: 0, item: a }),
  ];
  const f = await gateway((_req, res) => { writeSse(res, beforeTerminal, false); void gate.promise.then(() => writeSse(res, [complete([a, b])])); });
  const parts: vscode.LanguageModelResponsePart[] = [];
  const stream = streamResponse(key, request(), attribution, new AbortController().signal, f.baseURL);
  const first = stream.next();
  let returned = false;
  const observed = first.then(part => { returned = true; return part; }, error => { returned = true; return { error }; });
  await new Promise(resolve => setTimeout(resolve, 30));
  expect(returned).toBe(false);
  gate.resolve();
  const firstPart = await observed;
  if ('error' in firstPart) throw firstPart.error;
  parts.push(firstPart.value!);
  for await (const part of stream) parts.push(part);
  expect(parts).toEqual([call('call-a', { path: 'a.ts' }), call('call-b', { path: 'b.ts' })]);
});

it.each(['eof', 'error', 'malformed', 'array', 'bad-second'])('never emits a tool or retries after partial text followed by %s', async failure => {
  const a = toolItem('fc_a', 'call-a', failure === 'malformed' ? '{bad' : failure === 'array' ? '[]' : '{}');
  const extra = failure === 'bad-second' ? [toolItem('fc_b', 'call-b', '{bad')] : [];
  const events = [...textStart, event('response.output_item.added', { output_index: 1, item: { ...a, arguments: '', status: 'in_progress' } }),
    event('response.output_item.done', { output_index: 1, item: a })];
  if (failure === 'error') events.push(event('error', { error: { message: probe, code: 'upstream_failure' } }));
  else if (failure !== 'eof') events.push(complete([messageItem('hello'), a, ...extra]));
  const f = await service(events);
  const result = await collect(streamResponse(key, request(), attribution, new AbortController().signal, f.baseURL));
  expect(result.parts).toEqual([text('hello')]);
  expect(result.error).toBeInstanceOf(LunaRouteError);
  expect(String(result.error)).not.toContain(probe);
  expect(result.error).not.toHaveProperty('cause');
  expect(f.requests).toHaveLength(1);
});

it('round-trips completed opaque reasoning without rendering it as answer text', async () => {
  const f = await service([event('response.output_item.added', { output_index: 0, item: { ...reasoning, encrypted_content: 'partial', status: 'in_progress' } }),
    event('response.output_item.done', { output_index: 0, item: reasoning }), complete([reasoning])]);
  const result = await collect(streamResponse(key, request(), attribution, new AbortController().signal, f.baseURL));
  expect(result.error).toBeUndefined();
  expect(result.parts).toHaveLength(1);
  expect(result.parts[0]).toBeInstanceOf(vscode.LanguageModelDataPart);
  const part = result.parts[0] as vscode.LanguageModelDataPart;
  expect(part.mimeType).toBe(mime);
  expect(JSON.parse(new TextDecoder().decode(part.data))).toEqual({ modelId: 'chat-a', item: reasoning });
  expect(buildResponsesRequest(model, [assistant([part])], auto).input).toEqual([reasoning]);
});

it('keeps completed reasoning before subsequent answer text in replay history', async () => {
  const f = await service([
    event('response.output_item.added', { output_index: 0, item: { ...reasoning, status: 'in_progress' } }),
    event('response.output_item.done', { output_index: 0, item: reasoning }),
    event('response.output_item.added', { output_index: 1, item: { ...messageItem(''), status: 'in_progress', content: [] } }),
    event('response.output_text.delta', { item_id: 'msg_1', output_index: 1, content_index: 0, delta: 'hello' }),
    event('response.output_item.done', { output_index: 1, item: messageItem('hello') }),
    complete([reasoning, messageItem('hello')]),
  ]);
  const result = await collect(streamResponse(key, request(), attribution, new AbortController().signal, f.baseURL));
  expect(result.error).toBeUndefined();
  expect(result.parts[0]).toBeInstanceOf(vscode.LanguageModelDataPart);
  expect(result.parts[1]).toEqual(text('hello'));
  expect(buildResponsesRequest(model, [new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.Assistant, result.parts)], auto).input)
    .toEqual([reasoning, { role: 'assistant', content: [{ type: 'input_text', text: 'hello' }] }]);
});
it.each(['response.failed', 'response.incomplete', 'empty', 'empty-message', 'phase', 'unknown-tool'])('fails closed for %s without tool activity', async failure => {
  const output = failure === 'phase' ? [{ ...messageItem('hello'), phase: 'commentary' }]
    : failure === 'empty-message' ? [messageItem('')]
    : failure === 'unknown-tool' ? [{ ...toolItem('fc_bad', 'bad'), name: 'not_offered' }] : [];
  const f = await service(failure.startsWith('response.')
    ? [event(failure, { response: { status: failure.slice(9), error: { message: probe } } })] : [complete(output)]);
  const result = await collect(streamResponse(key, request(), attribution, new AbortController().signal, f.baseURL));
  expect(result.error).toBeInstanceOf(LunaRouteError);
  expect(result.parts).toEqual([]);
  expect(f.requests).toHaveLength(1);
});

it.each([307, 429, 503])('does not follow or retry HTTP %i and sanitizes SDK diagnostics', async status => {
  const requests: string[] = [];
  const f = await gateway((req, res) => {
    requests.push(req.url ?? '');
    res.writeHead(status, { Location: '/must-not-follow', 'Retry-After': '13', 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `${key} ${probe}` } }));
  });
  const result = await collect(streamResponse(key, request(), attribution, new AbortController().signal, f.baseURL));
  expect(result.error).toMatchObject({ kind: status === 307 ? 'network' : status === 429 ? 'rate-limit' : 'upstream' });
  if (status === 429) expect(result.error).toMatchObject({ retryAfterSeconds: 13 });
  expect(result.error).not.toHaveProperty('cause');
  expect(String(result.error)).not.toContain(key);
  expect(requests).toEqual(['/v1/responses']);
});

it('keeps SDK/app logs private even with OPENAI_LOG=debug and malformed SSE', async () => {
  vi.stubEnv('OPENAI_LOG', 'debug');
  const logs: unknown[][] = [];
  for (const name of ['debug', 'info', 'log', 'warn', 'error'] as const) vi.spyOn(console, name).mockImplementation((...args) => { logs.push(args); });
  const f = await gateway((_req, res) => { res.setHeader('Content-Type', 'text/event-stream'); res.end(`data: {malformed ${key} ${probe}\n\n`); });
  const result = await collect(streamResponse(key, request(), attribution, new AbortController().signal, f.baseURL));
  expect(result.error).toBeInstanceOf(LunaRouteError);
  expect(JSON.stringify(logs)).not.toContain(key);
  expect(JSON.stringify(logs)).not.toContain(probe);
  expect(logs).toEqual([]);
});
it('does not inherit unrelated OpenAI environment credentials or custom headers', async () => {
  vi.stubEnv('OPENAI_CUSTOM_HEADERS', 'Authorization: Bearer wrong\nCookie: private-cookie\nx-unrequested: private');
  vi.stubEnv('OPENAI_ORG_ID', 'other-org');
  vi.stubEnv('OPENAI_PROJECT_ID', 'other-project');
  const f = await service([...textStart, ...textEnd]);
  expect((await collect(streamResponse(key, request(), attribution, new AbortController().signal, f.baseURL))).error).toBeUndefined();
  expect(f.requests[0].headers.authorization).toBe(`Bearer ${key}`);
  for (const header of ['cookie', 'x-unrequested', 'openai-organization', 'openai-project']) expect(f.requests[0].headers).not.toHaveProperty(header);
});

it.each(['unknown-part', 'orphan-reasoning', 'missing-reasoning'])('does not discard nonempty %s events', async failure => {
  const events = failure === 'missing-reasoning' ? [
    event('response.output_item.added', { output_index: 0, item: { ...reasoning, status: 'in_progress', encrypted_content: null } }),
    event('response.reasoning_text.delta', { output_index: 0, item_id: 'rs_1', content_index: 0, delta: 'must retain this reasoning' }),
    event('response.output_item.done', { output_index: 0, item: { ...reasoning, encrypted_content: null } }),
    complete([{ ...reasoning, encrypted_content: null }]),
  ] : [
    textStart[0],
    failure === 'unknown-part'
      ? event('response.content_part.added', { output_index: 0, item_id: 'msg_1', content_index: 0, part: { type: 'output_audio', data: probe } })
      : event('response.reasoning_text.delta', { output_index: 0, item_id: 'missing', content_index: 0, delta: probe }),
    complete([messageItem('hello')]),
  ];
  const f = await service(events);
  const result = await collect(streamResponse(key, request(), attribution, new AbortController().signal, f.baseURL));
  expect(result.error).toMatchObject({ kind: 'protocol' });
  expect(result.parts).toEqual([]);
});
it('waits for earlier messages before publishing ready reasoning, then preserves later text', async () => {
  const last = { ...messageItem('later'), id: 'msg_2' };
  const f = await service([
    textStart[0],
    event('response.output_item.added', { output_index: 1, item: { ...reasoning, status: 'in_progress' } }),
    event('response.output_item.done', { output_index: 1, item: reasoning }),
    textStart[1],
    event('response.output_item.done', { output_index: 0, item: messageItem('hello') }),
    event('response.output_item.added', { output_index: 2, item: { ...last, content: [], status: 'in_progress' } }),
    event('response.output_text.delta', { output_index: 2, item_id: 'msg_2', content_index: 0, delta: 'later' }),
    event('response.output_item.done', { output_index: 2, item: last }),
    complete([messageItem('hello'), reasoning, last]),
  ]);
  const result = await collect(streamResponse(key, request(), attribution, new AbortController().signal, f.baseURL));
  expect(result.error).toBeUndefined();
  expect(result.parts).toEqual([text('hello'), replay(), text('later')]);
});

it('tolerates provider reasoning-part bookkeeping events that never carry answer text', async () => {
  const item = { ...reasoning, encrypted_content: null, content: [{ type: 'reasoning_text', text: 'hidden reasoning' }] };
  const f = await service([
    event('response.output_item.added', { output_index: 0, item: { ...reasoning, encrypted_content: null, status: 'in_progress' } }),
    event('response.reasoning_part.added', { output_index: 0, item_id: 'rs_1', content_index: 0, part: { type: 'reasoning_text', text: '' } }),
    event('response.reasoning_part.done', { output_index: 0, item_id: 'rs_1', content_index: 0, part: { type: 'reasoning_text', text: 'hidden reasoning' } }),
    event('response.output_item.done', { output_index: 0, item }), complete([item]),
  ]);
  const result = await collect(streamResponse(key, request(), attribution, new AbortController().signal, f.baseURL));
  expect(result.error).toBeUndefined();
  expect(result.parts).toHaveLength(1);
  expect(JSON.parse(new TextDecoder().decode((result.parts[0] as vscode.LanguageModelDataPart).data))).toEqual({ modelId: 'chat-a', item });
});
it('still fails closed on unknown non-reasoning events and names them', async () => {
  const f = await service([...textStart, event('response.future_kind.added', { item_id: 'msg_1' })]);
  const { error } = await collect(streamResponse(key, request(), attribution, new AbortController().signal, f.baseURL));
  expect(userMessage(error)).toContain('event:response.future_kind.added');
});
it('reconciles a terminal snapshot that regenerated item ids, matching by type and streamed order', async () => {
  const f = await service([...textStart, event('response.output_item.done', { output_index: 0, item: messageItem('hello') }),
    complete([{ ...messageItem('hello'), id: 'msg_regenerated' }])]);
  const result = await collect(streamResponse(key, request(), attribution, new AbortController().signal, f.baseURL));
  expect(result.error).toBeUndefined();
  expect(result.parts).toEqual([text('hello')]);
});
it('reconciles terminal output reordered across item types', async () => {
  const f = await service([
    textStart[0],
    event('response.output_text.delta', { item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'hello' }),
    event('response.output_item.added', { output_index: 1, item: { id: 'fc_1', type: 'function_call', call_id: 'call-1', name: 'read_file', arguments: '' } }),
    event('response.function_call_arguments.delta', { item_id: 'fc_1', output_index: 1, delta: '{"path":"a.ts"}' }),
    event('response.output_item.done', { output_index: 1, item: toolItem('fc_1', 'call-1') }),
    event('response.output_item.done', { output_index: 0, item: messageItem('hello') }),
    complete([toolItem('fc_1', 'call-1'), messageItem('hello')]),
  ]);
  const result = await collect(streamResponse(key, request(), attribution, new AbortController().signal, f.baseURL));
  expect(result.error).toBeUndefined();
  expect(result.parts).toEqual([text('hello'), call()]);
});
it('fails closed when terminal text contradicts what was streamed', async () => {
  const f = await service([...textStart, event('response.output_item.done', { output_index: 0, item: messageItem('hello') }),
    complete([messageItem('HELLO')])]);
  const result = await collect(streamResponse(key, request(), attribution, new AbortController().signal, f.baseURL));
  expect(userMessage(result.error)).toContain('unsupported');
});
it('captures the exact request and response for preview diagnostics without credentials', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lunaroute-capture-'));
  try {
    const f = await service([...textStart, ...textEnd]);
    capture.directory = directory;
    const result = await collect(streamResponse(key, request(), attribution, new AbortController().signal, f.baseURL));
    expect(result.error).toBeUndefined();
    const files = readdirSync(directory).sort();
    expect(files.some(name => name.endsWith('-request.json'))).toBe(true);
    expect(files.some(name => name.endsWith('-response.meta.json'))).toBe(true);
    expect(files.some(name => name.endsWith('-response.sse'))).toBe(true);
    const saved = files.map(name => readFileSync(join(directory, name), 'utf8')).join('\n');
    expect(saved).toContain('"model":"chat-a"');
    expect(saved).toContain('response.completed');
    expect(saved).not.toContain(key);
    expect(saved.toLowerCase()).not.toContain('authorization');
    expect(capture.directory).toBeUndefined();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
it('records only safe metadata when a captured exchange fails', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'lunaroute-capture-fail-'));
  try {
    const f = await service([...textStart, event('response.future_kind.added', { item_id: 'msg_1' })]);
    capture.directory = directory;
    const result = await collect(streamResponse(key, request(), attribution, new AbortController().signal, f.baseURL));
    expect(result.error).toBeInstanceOf(LunaRouteError);
    const saved = readdirSync(directory).filter(name => name.endsWith('-error.txt')).map(name => readFileSync(join(directory, name), 'utf8')).join('\n');
    expect(saved).toContain('protocol');
    expect(saved).toContain('response.future_kind.added');
    expect(saved).not.toContain(probe);
    expect(capture.directory).toBeUndefined();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
it('treats the completed response as authoritative for terminal item status', async () => {
  const f = await service([...textStart, event('response.output_item.done', { output_index: 0, item: messageItem('hello') }),
    complete([{ ...messageItem('hello'), status: 'in_progress' }])]);
  const result = await collect(streamResponse(key, request(), attribution, new AbortController().signal, f.baseURL));
  expect(result.error).toBeUndefined();
  expect(result.parts).toEqual([text('hello')]);
});
it('validates real reasoning content/summary fragments without rendering them as answer text', async () => {
  const item = { ...reasoning, encrypted_content: null,
    content: [{ type: 'reasoning_text', text: 'hidden reasoning' }], summary: [{ type: 'summary_text', text: 'summary' }] };
  const f = await service([
    event('response.output_item.added', { output_index: 0, item: { ...reasoning, encrypted_content: null, status: 'in_progress' } }),
    event('response.content_part.added', { output_index: 0, item_id: 'rs_1', content_index: 0, part: { type: 'reasoning_text', text: '' } }),
    event('response.reasoning_text.delta', { output_index: 0, item_id: 'rs_1', content_index: 0, delta: 'hidden reasoning' }),
    event('response.reasoning_text.done', { output_index: 0, item_id: 'rs_1', content_index: 0, text: 'hidden reasoning' }),
    event('response.content_part.done', { output_index: 0, item_id: 'rs_1', content_index: 0, part: { type: 'reasoning_text', text: 'hidden reasoning' } }),
    event('response.reasoning_summary_part.added', { output_index: 0, item_id: 'rs_1', summary_index: 0, part: { type: 'summary_text', text: '' } }),
    event('response.reasoning_summary_text.delta', { output_index: 0, item_id: 'rs_1', summary_index: 0, delta: 'summ' }),
    event('response.reasoning_summary_text.done', { output_index: 0, item_id: 'rs_1', summary_index: 0, text: 'summary' }),
    event('response.reasoning_summary_part.done', { output_index: 0, item_id: 'rs_1', summary_index: 0, part: { type: 'summary_text', text: 'summary' } }),
    event('response.output_item.done', { output_index: 0, item }), complete([item]),
  ]);
  const result = await collect(streamResponse(key, request(), attribution, new AbortController().signal, f.baseURL));
  expect(result.error).toBeUndefined();
  expect(result.parts).toHaveLength(1);
  expect(result.parts[0]).toBeInstanceOf(vscode.LanguageModelDataPart);
  expect(JSON.parse(new TextDecoder().decode((result.parts[0] as vscode.LanguageModelDataPart).data))).toEqual({ modelId: 'chat-a', item });
});
it.each(['part', 'item'])('rejects a late %s text suffix instead of reordering already-emitted content', async via => {
  const item = { ...messageItem(''), content: [
    { type: 'output_text', text: 'AA', annotations: [] }, { type: 'output_text', text: 'B', annotations: [] },
  ] };
  const f = await service([
    textStart[0],
    event('response.output_text.delta', { output_index: 0, item_id: 'msg_1', content_index: 0, delta: 'A' }),
    event('response.output_text.delta', { output_index: 0, item_id: 'msg_1', content_index: 1, delta: 'B' }),
    ...(via === 'part' ? [event('response.content_part.done', { output_index: 0, item_id: 'msg_1', content_index: 0, part: item.content[0] })] : []),
    event('response.output_item.done', { output_index: 0, item }), complete([item]),
  ]);
  const result = await collect(streamResponse(key, request(), attribution, new AbortController().signal, f.baseURL));
  expect(result.error).toMatchObject({ kind: 'protocol' });
  expect(result.parts).toEqual([text('A'), text('B')]);
});
it('does not confuse empty pre-announced text parts with already-emitted content', async () => {
  const item = { ...messageItem(''), content: [
    { type: 'output_text', text: 'A', annotations: [] }, { type: 'output_text', text: 'B', annotations: [] },
  ] };
  const f = await service([
    textStart[0],
    event('response.content_part.added', { output_index: 0, item_id: 'msg_1', content_index: 1, part: { type: 'output_text', text: '', annotations: [] } }),
    event('response.output_text.delta', { output_index: 0, item_id: 'msg_1', content_index: 0, delta: 'A' }),
    event('response.output_text.delta', { output_index: 0, item_id: 'msg_1', content_index: 1, delta: 'B' }),
    event('response.output_text.done', { output_index: 0, item_id: 'msg_1', content_index: 1, text: 'B' }),
    event('response.output_item.done', { output_index: 0, item }), complete([item]),
  ]);
  const result = await collect(streamResponse(key, request(), attribution, new AbortController().signal, f.baseURL));
  expect(result.error).toBeUndefined();
  expect(result.parts).toEqual([text('A'), text('B')]);
});

it('renders refusal text as a refusal rather than silently returning an empty answer', async () => {
  const refusal = { ...messageItem(''), content: [{ type: 'refusal', refusal: 'Cannot do that' }] };
  const f = await service([
    event('response.output_item.added', { output_index: 0, item: { ...refusal, content: [], status: 'in_progress' } }),
    event('response.refusal.delta', { output_index: 0, item_id: 'msg_1', content_index: 0, delta: 'Cannot do that' }),
    event('response.output_item.done', { output_index: 0, item: refusal }), complete([refusal]),
  ]);
  const result = await collect(streamResponse(key, request(), attribution, new AbortController().signal, f.baseURL));
  expect(result.error).toBeUndefined();
  expect(result.parts).toEqual([text('Cannot do that')]);
});
it('closes the network stream when its consumer stops reading', async () => {
  const closed = deferred<void>();
  const f = await gateway((_req, res) => { res.on('close', () => closed.resolve()); writeSse(res, textStart, false); });
  const stream = streamResponse(key, request(), attribution, new AbortController().signal, f.baseURL);
  expect((await stream.next()).value).toEqual(text('hello'));
  await stream.return(undefined);
  await closed.promise;
});

it('cancels after a text delta without retrying or publishing buffered calls', async () => {
  let response: ServerResponse | undefined;
  const f = await gateway((_req, res) => { response = res; writeSse(res, textStart, false); });
  const controller = new AbortController();
  const stream = streamResponse(key, request(), attribution, controller.signal, f.baseURL);
  expect((await stream.next()).value).toEqual(text('hello'));
  const next = stream.next().catch(error => error);
  controller.abort();
  expect(await next).toMatchObject({ kind: 'cancelled' });
  response?.end();
});
it('rechecks cancellation between multiple text parts from one completed snapshot', async () => {
  const item = { ...messageItem(''), content: [
    { type: 'output_text', text: 'A', annotations: [] }, { type: 'output_text', text: 'B', annotations: [] },
  ] };
  const f = await service([textStart[0], event('response.output_item.done', { output_index: 0, item }), complete([item])]);
  const controller = new AbortController();
  const stream = streamResponse(key, request(), attribution, controller.signal, f.baseURL);
  try {
    expect((await stream.next()).value).toEqual(text('A'));
    controller.abort();
    await expect(stream.next()).rejects.toMatchObject({ kind: 'cancelled' });
  } finally { await stream.return(undefined); }
});

it('does not start an already-cancelled request', async () => {
  let requests = 0;
  const f = await gateway((_req, res) => { requests++; writeSse(res, [...textStart, ...textEnd]); });
  const controller = new AbortController();
  controller.abort();
  const result = await collect(streamResponse(key, request(), attribution, controller.signal, f.baseURL));
  expect(result.error).toMatchObject({ kind: 'cancelled' });
  expect(requests).toBe(0);
});
it('bounds connection wait to 120000 ms without retry', async () => {
  const received = deferred<void>();
  let requests = 0;
  const f = await gateway(() => { requests++; received.resolve(); });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const response = collect(streamResponse(key, request(), attribution, new AbortController().signal, f.baseURL));
  await Promise.race([received.promise, response.then(result => { if (result.error) throw result.error; })]);
  await vi.advanceTimersByTimeAsync(120000);
  expect((await response).error).toMatchObject({ kind: 'network' });
  expect(requests).toBe(1);
});
it('resets the stream-idle deadline on progress instead of imposing a whole-response timeout', async () => {
  let response: ServerResponse | undefined;
  const f = await gateway((_req, res) => { response = res; writeSse(res, textStart, false); });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const stream = streamResponse(key, request(), attribution, new AbortController().signal, f.baseURL);
  expect((await stream.next()).value).toEqual(text('hello'));
  const progress = stream.next();
  await vi.advanceTimersByTimeAsync(110000);
  writeSse(response!, [event('response.output_text.delta', { output_index: 0, item_id: 'msg_1', content_index: 0, delta: '!' })], false);
  expect((await progress).value).toEqual(text('!'));
  let finished = false;
  const next = stream.next().catch(error => error).then(value => { finished = true; return value; });
  await vi.advanceTimersByTimeAsync(119999);
  expect(finished).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await next).toMatchObject({ kind: 'network' });
});
it('aborts an idle stream at 120000 ms, not before', async () => {
  const f = await gateway((_req, res) => writeSse(res, textStart, false));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const stream = streamResponse(key, request(), attribution, new AbortController().signal, f.baseURL);
  expect((await stream.next()).value).toEqual(text('hello'));
  let finished = false;
  const next = stream.next().catch(error => error).then(value => { finished = true; return value; });
  await vi.advanceTimersByTimeAsync(119999);
  expect(finished).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await next).toMatchObject({ kind: 'network' });
});
