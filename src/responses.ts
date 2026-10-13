import { isDeepStrictEqual } from 'node:util';
import { join } from 'node:path';
import { appendFileSync, writeFileSync } from 'node:fs';
import * as vscode from 'vscode';
import OpenAI from 'openai';
import { abortReason, buildHeaders, capture, httpError, LunaRouteError, ROUTING_URL, type Attribution } from './lunaroute.js';

const REPLAY_MIME = 'application/vnd.lunaroute.responses-replay+json';
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);
const inputError = () => new LunaRouteError('input');
const bytes = (value: string) => Buffer.byteLength(value, 'utf8');

function json(value: unknown): string {
  const active = new Set<object>();
  const check = (item: unknown): void => {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (!record(item) && !Array.isArray(item)) throw inputError();
    if (active.has(item) || Object.getOwnPropertySymbols(item).length) throw inputError();
    if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) throw inputError();
    active.add(item);
    for (const child of Array.isArray(item) ? item : Object.values(item)) check(child);
    active.delete(item);
  };
  check(value);
  return JSON.stringify(value);
}
function decode(part: vscode.LanguageModelDataPart): string {
  if (!(part.data instanceof Uint8Array)) throw inputError();
  try { return decoder.decode(part.data); } catch { throw inputError(); }
}
function validReasoning(value: unknown): value is OpenAI.Responses.ResponseReasoningItem {
  if (!record(value) || value.type !== 'reasoning' || !identity(value.id)
    || !Object.keys(value).every(key => ['id', 'type', 'summary', 'content', 'encrypted_content', 'status'].includes(key))) return false;
  const segments = (parts: unknown, type: string) => Array.isArray(parts) && parts.every(part => record(part)
    && part.type === type && typeof part.text === 'string' && Object.keys(part).every(key => ['type', 'text'].includes(key)));
  return segments(value.summary, 'summary_text')
    && (value.content === undefined || segments(value.content, 'reasoning_text'))
    && (value.encrypted_content === undefined || value.encrypted_content === null || typeof value.encrypted_content === 'string')
    // JSON null means unspecified, matching the gateway's absent-field convention (kata nhz1).
    && (value.status === undefined || value.status === null || value.status === 'completed');
}
function replayItem(part: vscode.LanguageModelDataPart, role: vscode.LanguageModelChatMessageRole, modelId?: string) {
  if (role !== vscode.LanguageModelChatMessageRole.Assistant) throw inputError();
  const envelope: unknown = JSON.parse(decode(part));
  if (!record(envelope) || !Object.keys(envelope).every(key => ['modelId', 'item'].includes(key))
    || !identity(envelope.modelId) || (modelId !== undefined && envelope.modelId !== modelId) || !validReasoning(envelope.item)) throw inputError();
  return envelope.item;
}
type Leaf = { text: string } | { image: vscode.LanguageModelDataPart };
function leaf(part: unknown): Leaf {
  if (part instanceof vscode.LanguageModelTextPart && typeof part.value === 'string') return { text: part.value };
  if (part instanceof vscode.LanguageModelDataPart && typeof part.mimeType === 'string') {
    if (IMAGE_MIMES.has(part.mimeType)) {
      if (!(part.data instanceof Uint8Array) || !part.data.byteLength) throw inputError();
      return { image: part };
    }
    if (/^text\/[a-z0-9.+-]+(?:;\s*charset=utf-8)?$/i.test(part.mimeType) || part.mimeType === 'application/json') return { text: decode(part) };
  }
  throw inputError();
}
const leafTokens = (part: Leaf) => 'text' in part ? bytes(part.text) : 16384;
function leafInput(part: Leaf, model: vscode.LanguageModelChatInformation): OpenAI.Responses.ResponseInputText | OpenAI.Responses.ResponseInputImage {
  if ('text' in part) return { type: 'input_text', text: part.text };
  if (!model.capabilities?.imageInput) throw inputError();
  return { type: 'input_image', detail: 'auto', image_url: `data:${part.image.mimeType};base64,${Buffer.from(part.image.data).toString('base64')}` };
}

// VS Code 1.141 delivers native-chat instructions as LanguageModelChatMessageRole.System
// (role 3); @types/vscode@1.140 predates that member, so the value is named here.
const SYSTEM_ROLE = 3 as vscode.LanguageModelChatMessageRole;

// Counting uses the same validation without allocating image data URLs.
function messageInput(message: vscode.LanguageModelChatRequestMessage, model?: vscode.LanguageModelChatInformation) {
  const role = message.role === vscode.LanguageModelChatMessageRole.User ? 'user'
    : message.role === vscode.LanguageModelChatMessageRole.Assistant ? 'assistant'
    : message.role === SYSTEM_ROLE ? 'system' : undefined;
  if (!role || !Array.isArray(message.content) || (message.name !== undefined && message.name !== '')) throw inputError();
  const items: OpenAI.Responses.ResponseInput = [];
  let content: OpenAI.Responses.ResponseInputMessageContentList = [];
  let tokens = 32;
  const flush = () => { if (content.length) { items.push({ role, content }); content = []; } };
  for (const part of message.content) {
    if (part instanceof vscode.LanguageModelToolCallPart) {
      if (role !== 'assistant' || !identity(part.callId) || !identity(part.name) || !record(part.input)
        || (model && !model.capabilities?.toolCalling)) throw inputError();
      const args = json(part.input);
      tokens += 32 + bytes(part.callId) + bytes(part.name) + bytes(args);
      flush();
      if (model) items.push({ type: 'function_call', call_id: part.callId, name: part.name, arguments: args });
    } else if (part instanceof vscode.LanguageModelToolResultPart) {
      if (role !== 'user' || !identity(part.callId) || !Array.isArray(part.content) || (model && !model.capabilities?.toolCalling)) throw inputError();
      const parts = part.content.map(leaf);
      tokens += 32 + bytes(part.callId) + parts.reduce((count, value) => count + leafTokens(value), 0);
      flush();
      if (model) items.push({ type: 'function_call_output', call_id: part.callId,
        output: parts.every(part => 'text' in part) ? parts.map(part => part.text).join('') : parts.map(part => leafInput(part, model)) });
    } else if (part instanceof vscode.LanguageModelDataPart && part.mimeType === REPLAY_MIME) {
      const item = replayItem(part, message.role, model?.id);
      tokens += part.data.byteLength;
      flush();
      if (model) items.push(item);
    } else {
      const value = leaf(part);
      tokens += leafTokens(value);
      if (model) content.push(leafInput(value, model));
    }
  }
  flush();
  return { items, tokens };
}

export function buildResponsesRequest(model: vscode.LanguageModelChatInformation, messages: readonly vscode.LanguageModelChatRequestMessage[],
  options: vscode.ProvideLanguageModelChatResponseOptions): OpenAI.Responses.ResponseCreateParamsStreaming {
  try {
    if (!identity(model.id) || !Number.isSafeInteger(model.maxInputTokens) || model.maxInputTokens <= 0
      || !Number.isSafeInteger(model.maxOutputTokens) || model.maxOutputTokens <= 0) throw inputError();
    if (![vscode.LanguageModelChatToolMode.Auto, vscode.LanguageModelChatToolMode.Required].includes(options.toolMode)) throw inputError();
    const converted = messages.map(message => messageInput(message, model));
    const tools: OpenAI.Responses.FunctionTool[] = [];
    const names = new Set<string>();
    let tokens = converted.reduce((count, message) => count + message.tokens, 0);
    for (const tool of options.tools ?? []) {
      if (!model.capabilities?.toolCalling || !identity(tool.name) || names.has(tool.name) || typeof tool.description !== 'string') throw inputError();
      names.add(tool.name);
      if (tool.inputSchema !== undefined && !record(tool.inputSchema)) throw inputError();
      const schema = tool.inputSchema === undefined ? 'null' : json(tool.inputSchema);
      tokens += 32 + bytes(tool.name) + bytes(tool.description) + bytes(schema);
      tools.push({ type: 'function', name: tool.name, description: tool.description, parameters: JSON.parse(schema), strict: false });
    }
    if (tokens > model.maxInputTokens || (options.toolMode === vscode.LanguageModelChatToolMode.Required && !tools.length)) throw inputError();
    return { model: model.id, input: converted.flatMap(message => message.items), stream: true, store: false,
      max_output_tokens: model.maxOutputTokens, tool_choice: options.toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' : 'auto',
      ...(tools.length ? { tools } : {}), include: ['reasoning.encrypted_content'] };
  } catch { throw inputError(); }
}

export function estimateTokens(input: string | vscode.LanguageModelChatRequestMessage): number {
  // shortcut: UTF-8 bytes plus fixed framing/image budgets; upgrade when model-aware tokenization is available and calibrated.
  try { return typeof input === 'string' ? bytes(input) : messageInput(input).tokens; } catch { throw inputError(); }
}
const STREAM_IDLE_MS = 120000;
// Preview diagnostics: raw request/response capture into the folder the user picked (opt-in). The
// files contain the conversation; credentials live in request headers and are never written.
function captureWrite(directory: string, name: string, value: string | Uint8Array) {
  try { if (typeof value === 'string') writeFileSync(join(directory, name), value); else appendFileSync(join(directory, name), value); }
  catch (error) {
    void vscode.window.showWarningMessage(`LunaRoute diagnostics capture failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
}
const protocolError = (detail?: string) => new LunaRouteError('protocol', undefined, undefined, detail);
const indexValue = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
type StreamItem = { index: number; item: Record<string, unknown>; args: string; complete?: Record<string, unknown>;
  text: Map<number, { type: string; value: string }>;
  reasoning: Map<string, { field: 'content' | 'summary'; index: number; value: string }>; replayed: boolean };

export async function* streamResponse(key: string, request: OpenAI.Responses.ResponseCreateParamsStreaming,
  attribution: Attribution, signal: AbortSignal, baseURL = ROUTING_URL): AsyncGenerator<vscode.LanguageModelResponsePart> {
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  const directory = capture.directory;
  const stamp = directory ? new Date().toISOString().replace(/[:.]/g, '-') : '';
  let captured = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let terminal = false;
  let closed = false;
  const touch = () => {
    clearTimeout(timer);
    if (!closed && !terminal && !combined.aborted) timer = setTimeout(() => controller.abort(new LunaRouteError('network', 408)), STREAM_IDLE_MS);
  };
  try {
    if (combined.aborted) throw abortReason(combined);
    const modelId = request.model;
    if (!identity(modelId) || !identity(key)) throw inputError();
    const client = new OpenAI({ apiKey: key, baseURL, organization: null, project: null, adminAPIKey: null, webhookSecret: null,
      maxRetries: 0, logLevel: 'off', timeout: STREAM_IDLE_MS,
      fetch: async (url, init) => {
        if (directory) {
          const payload = typeof init?.body === 'string' ? init.body
            : init?.body instanceof Uint8Array ? decoder.decode(init.body) : '';
          captureWrite(directory, `${stamp}-request.json`, payload);
          captured = true;
        }
        const response = await fetch(url, { ...init, redirect: 'error', headers: {
          ...buildHeaders(key, attribution), 'Content-Type': 'application/json', Accept: 'text/event-stream',
        } });
        touch();
        if (!response.body) return response;
        if (directory) captureWrite(directory, `${stamp}-response.meta.json`,
          `${JSON.stringify({ url: String(url), status: response.status, headers: [...response.headers] }, null, 2)}\n`);
        const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, output) { touch(); if (directory) captureWrite(directory, `${stamp}-response.sse`, chunk); output.enqueue(chunk); },
        }), { signal: combined });
        return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
      },
    });
    const items = new Map<string, StreamItem>();
    const positions = new Map<number, string>();
    const allowedTools = new Set(request.tools?.filter(tool => tool.type === 'function').map(tool => tool.name));
    let lastImmediateIndex = -1;
    const itemKind = (item: unknown): string => {
      const kind = record(item) && typeof item.type === 'string' ? item.type : 'malformed';
      if (!record(item) || !identity(item.id) || !['message', 'function_call', 'reasoning'].includes(kind)) throw protocolError(`item:${kind}`);
      if (item.type === 'message' && (item.role !== 'assistant' || (item.phase !== undefined && item.phase !== null))) throw protocolError('item:message');
      if (item.type === 'function_call' && (!identity(item.call_id) || !identity(item.name) || typeof item.arguments !== 'string'
        || item.async === true || item.namespace || (item.caller !== undefined && (!record(item.caller) || item.caller.type !== 'direct')))) throw protocolError('item:function_call');
      return kind;
    };
    const stateFor = (item: unknown, index: unknown): StreamItem => {
      const kind = itemKind(item);
      const value = item as Record<string, unknown>;
      if (!indexValue(index)) throw protocolError(`item:${kind}`);
      const existing = items.get(value.id as string);
      if (existing) {
        if (existing.index !== index || existing.item.type !== value.type || (value.type === 'function_call'
          && (existing.item.call_id !== value.call_id || existing.item.name !== value.name))) throw protocolError(`item:${kind}`);
        return existing;
      }
      if (positions.has(index)) throw protocolError('item:index');
      const state: StreamItem = { index, item: value, args: value.type === 'function_call' ? value.arguments as string : '',
        text: new Map(), reasoning: new Map(), replayed: false };
      items.set(value.id as string, state);
      positions.set(index, value.id as string);
      return state;
    };
    const eventState = (event: Record<string, unknown>, type: string) => {
      const state = typeof event.item_id === 'string' ? items.get(event.item_id) : undefined;
      if (!state || state.item.type !== type || event.output_index !== state.index) throw protocolError(`event-state:${type}`);
      return state;
    };
    const pendingBefore = (state: StreamItem) => [...items.values()].some(other => other.index < state.index
      && (other.item.type === 'function_call' || (other.item.type === 'reasoning' && !other.replayed)));
    const eagerOrder = (state: StreamItem) => {
      if (state.index < lastImmediateIndex || pendingBefore(state)) throw protocolError();
      lastImmediateIndex = state.index;
    };
    const laterText = (state: StreamItem, index: number) => [...state.text].some(([other, part]) => other > index && part.value.length > 0);
    const replayPart = (state: StreamItem) => {
      state.replayed = true;
      return vscode.LanguageModelDataPart.json({ modelId, item: state.complete }, REPLAY_MIME);
    };
    const validateReasoningFragments = (state: StreamItem, item: Record<string, unknown>) => {
      for (const segment of state.reasoning.values()) {
        if (!segment.value) continue;
        const values = item[segment.field];
        const part = Array.isArray(values) ? values[segment.index] : undefined;
        if (record(part) && typeof part.text === 'string' && part.text.startsWith(segment.value)) continue;
        if (segment.field === 'content' && typeof item.encrypted_content === 'string' && item.encrypted_content.length) continue;
        throw protocolError('reasoning:fragments');
      }
    };
    const reasoningFragment = (event: Record<string, unknown>, field: 'content' | 'summary', index: unknown, value: unknown, delta = false) => {
      const state = eventState(event, 'reasoning');
      if (!indexValue(index) || typeof value !== 'string' || (delta && state.complete)) throw protocolError('reasoning:fragments');
      const key = `${field}:${index}`;
      const previous = state.reasoning.get(key)?.value ?? '';
      const next = delta ? previous + value : value;
      if (!next.startsWith(previous)) throw protocolError('reasoning:fragments');
      state.reasoning.set(key, { field, index, value: next });
      if (state.complete) validateReasoningFragments(state, state.complete);
    };
    const snapshotParts = (state: StreamItem, item: Record<string, unknown>, final: boolean): vscode.LanguageModelResponsePart[] => {
      // The completed response is authoritative for its own items: providers rebuild the terminal
      // snapshot and may leave per-item status behind (vllm/ollama); stream-level events stay strict.
      if (!final && item.status !== undefined && item.status !== 'completed') throw protocolError('snapshot:status');
    // Terminal snapshots are authoritative and providers rebuild them: item ids get regenerated
    // (vllm#59834/#59307), per-item status is left behind, and fields such as an empty `summary`
    // appear or disappear (verified against a real sglang-style stream). Content consistency is
    // still enforced below by the prefix/fragment rules, which is what protects the user.
    const sameItem = (value: Record<string, unknown>) =>
      isDeepStrictEqual({ ...state.complete, id: undefined }, { ...value, id: undefined });
      const parts: vscode.LanguageModelResponsePart[] = [];
      if (item.type === 'function_call') {
        if (typeof item.arguments !== 'string' || !item.arguments.startsWith(state.args)
          || (state.complete && state.complete.arguments !== item.arguments)) throw protocolError('snapshot:function_call');
        state.args = item.arguments;
      } else if (item.type === 'reasoning') {
        if (!validReasoning(item)) throw protocolError('snapshot:reasoning');
        // The SDK contract makes the done item authoritative for encrypted replay.
        if (final && state.complete) item = state.complete;
        else if (state.complete && !sameItem(item)) throw protocolError('snapshot:reasoning');
        validateReasoningFragments(state, item);
      } else {
        if (!Array.isArray(item.content)) throw protocolError('snapshot:message');
        for (const [index, part] of item.content.entries()) {
          if (!record(part) || !['output_text', 'refusal'].includes(String(part.type))) throw protocolError('snapshot:part');
          const value = part.type === 'output_text' ? part.text : part.refusal;
          if (typeof value !== 'string' || (part.annotations !== undefined && (!Array.isArray(part.annotations) || part.annotations.length))) throw protocolError('snapshot:part');
          const previous = state.text.get(index);
          if (previous && (previous.type !== part.type || !value.startsWith(previous.value))) throw protocolError('snapshot:part');
          const rest = value.slice(previous?.value.length ?? 0);
          if (rest) {
            if (laterText(state, index)) throw protocolError('snapshot:order');
            parts.push(new vscode.LanguageModelTextPart(rest));
          }
          state.text.set(index, { type: part.type as string, value });
        }
        if ([...state.text.keys()].some(index => index >= (item.content as unknown[]).length)) throw protocolError('snapshot:part');
        // Only streamed snapshots must agree field-for-field; the terminal item is the authority.
        if (state.complete && !final && !sameItem(item)) throw protocolError('snapshot:message');
      }
      state.complete = item;
      return parts;
    };
    const completeTool = (state: StreamItem) => {
      const item = state.complete;
      if (!item || !identity(item.call_id) || !identity(item.name) || !allowedTools.has(item.name)) throw protocolError('completed:tool');
      let input: unknown;
      try { input = JSON.parse(state.args); if (!record(input)) throw protocolError('completed:tool'); json(input); } catch { throw protocolError('completed:tool'); }
      return new vscode.LanguageModelToolCallPart(item.call_id, item.name, input);
    };
    touch();
    const stream = await client.responses.create(request, { signal: combined });
    for await (const raw of stream) {
      if (combined.aborted) throw abortReason(combined);
      const event: unknown = raw;
      if (!record(event) || typeof event.type !== 'string') throw protocolError('event:malformed');
      try {
        switch (event.type) {
        case 'response.output_item.added': {
          const state = stateFor(event.item, event.output_index);
          if (state.item.type === 'message' && Array.isArray(state.item.content) && state.item.content.length) throw protocolError();
          break;
        }
        case 'response.output_text.delta':
        case 'response.refusal.delta': {
          const state = eventState(event, 'message');
          if (!indexValue(event.content_index) || typeof event.delta !== 'string' || state.complete) throw protocolError();
          eagerOrder(state);
          if (event.delta && laterText(state, event.content_index)) throw protocolError();
          const type = event.type === 'response.refusal.delta' ? 'refusal' : 'output_text';
          const previous = state.text.get(event.content_index);
          if (previous && previous.type !== type) throw protocolError();
          state.text.set(event.content_index, { type, value: (previous?.value ?? '') + event.delta });
          if (event.delta) yield new vscode.LanguageModelTextPart(event.delta);
          break;
        }
        case 'response.function_call_arguments.delta':
        case 'response.function_call_arguments.done': {
          const state = eventState(event, 'function_call');
          if (event.type.endsWith('.delta')) {
            if (typeof event.delta !== 'string' || state.complete) throw protocolError();
            state.args += event.delta;
          } else {
            if (typeof event.arguments !== 'string' || !event.arguments.startsWith(state.args)) throw protocolError();
            state.args = event.arguments;
          }
          break;
        }
        case 'response.output_item.done': {
          const state = stateFor(event.item, event.output_index);
          const parts = snapshotParts(state, event.item as Record<string, unknown>, false);
          if (parts.length) {
            eagerOrder(state);
            for (const part of parts) { if (combined.aborted) throw abortReason(combined); yield part; }
          }
          for (const ready of [...items.values()].sort((a, b) => a.index - b.index)) {
            if (ready.item.type !== 'reasoning' || !ready.complete || ready.replayed) continue;
            const earlier = [...items.values()].filter(other => other.index < ready.index);
            if (earlier.length !== ready.index || earlier.some(other => !other.complete) || pendingBefore(ready)) continue;
            if (combined.aborted) throw abortReason(combined);
            eagerOrder(ready);
            yield replayPart(ready);
          }
          break;
        }
        case 'response.completed': {
          const response = event.response;
          if (!record(response) || response.status !== 'completed' || response.error != null || response.incomplete_details != null
            || !Array.isArray(response.output) || !response.output.length) throw protocolError('completed:shape');
          const parts: vscode.LanguageModelResponsePart[] = [];
          const calls = new Set<string>();
          // Providers (vLLM/ollama, and OpenAI-compatible upstreams) may rebuild the terminal snapshot
          // with regenerated item ids or reordered output, so match each item to its streamed
          // counterpart by id, then by type and streamed order; content rules below stay strict.
          const queues = new Map<string, StreamItem[]>();
          for (const state of [...items.values()].sort((a, b) => a.index - b.index)) {
            const type = state.item.type as string;
            queues.set(type, [...(queues.get(type) ?? []), state]);
          }
          const matched = new Set<StreamItem>();
          for (const [position, raw] of response.output.entries()) {
            const kind = itemKind(raw);
            const item = raw as Record<string, unknown>;
            const exact = items.get(item.id as string);
            const streamed = exact && !matched.has(exact) && exact.item.type === kind ? exact
              : (queues.get(kind) ?? []).find(candidate => !matched.has(candidate));
            const state = streamed ?? { index: position, item, args: kind === 'function_call' ? item.arguments as string : '',
              text: new Map(), reasoning: new Map(), replayed: false };
            if (!streamed) {
              items.set(item.id as string, state);
              queues.set(kind, [...(queues.get(kind) ?? []), state]);
            }
            matched.add(state);
            const tail = snapshotParts(state, item, true);
            if (tail.length || (state.item.type === 'reasoning' && !state.replayed) || state.item.type === 'function_call') {
              if (state.index < lastImmediateIndex) throw protocolError('completed:order');
            }
            if (state.item.type === 'function_call') {
              const call = completeTool(state);
              if (calls.has(call.callId)) throw protocolError('completed:duplicate');
              calls.add(call.callId);
              parts.push(call);
            } else if (state.item.type === 'reasoning' && !state.replayed) parts.push(replayPart(state));
            else parts.push(...tail);
          }
          if (matched.size !== items.size || (!parts.length && ![...items.values()].some(state => state.replayed
            || [...state.text.values()].some(part => part.value.length > 0)))) throw protocolError('completed:coverage');
          terminal = true;
          clearTimeout(timer);
          for (const part of parts) {
            if (combined.aborted) throw abortReason(combined);
            yield part;
          }
          return;
        }
        case 'response.failed': throw new LunaRouteError('upstream');
        case 'response.incomplete': throw protocolError();
        case 'response.content_part.added': case 'response.content_part.done':
        case 'response.output_text.done': case 'response.refusal.done': {
          const part = event.type.startsWith('response.content_part.') ? event.part
            : event.type === 'response.output_text.done' ? { type: 'output_text', text: event.text } : { type: 'refusal', refusal: event.refusal };
          if (!record(part)) throw protocolError();
          if (part.type === 'reasoning_text') { reasoningFragment(event, 'content', event.content_index, part.text); break; }
          const state = eventState(event, 'message');
          const value = part.type === 'output_text' ? part.text : part.refusal;
          if (!['output_text', 'refusal'].includes(String(part.type)) || !indexValue(event.content_index) || typeof value !== 'string'
            || (part.annotations !== undefined && (!Array.isArray(part.annotations) || part.annotations.length))) throw protocolError();
          const previous = state.text.get(event.content_index);
          if (previous && (previous.type !== part.type || !value.startsWith(previous.value))) throw protocolError();
          if (state.complete && value !== previous?.value) throw protocolError();
          const rest = value.slice(previous?.value.length ?? 0);
          state.text.set(event.content_index, { type: part.type as string, value });
          if (rest) {
            if (laterText(state, event.content_index)) throw protocolError();
            eagerOrder(state);
            yield new vscode.LanguageModelTextPart(rest);
          }
          break;
        }
        case 'response.reasoning_summary_part.added': case 'response.reasoning_summary_part.done': {
          if (!record(event.part) || event.part.type !== 'summary_text') throw protocolError();
          reasoningFragment(event, 'summary', event.summary_index, event.part.text);
          break;
        }
        case 'response.reasoning_summary_text.delta': case 'response.reasoning_summary_text.done':
        case 'response.reasoning_text.delta': case 'response.reasoning_text.done': {
          const summary = event.type.includes('summary');
          const delta = event.type.endsWith('.delta');
          reasoningFragment(event, summary ? 'summary' : 'content', summary ? event.summary_index : event.content_index,
            delta ? event.delta : event.text, delta);
          break;
        }
        case 'response.created': case 'response.queued': case 'response.in_progress': break;
        // Provider reasoning bookkeeping (e.g. reasoning_part.added/done): reasoning is never rendered
        // as answer text and the completed item is authoritative for the encrypted replay, so these
        // events carry nothing we could drop or mis-render.
        case 'response.reasoning_part.added': case 'response.reasoning_part.done': break;
        default:
          if (event.type.startsWith('response.reasoning_')) break;
          throw protocolError();
        }
      } catch (error) {
        // Name the event that rejected the stream; detail never carries content.
        if (error instanceof LunaRouteError && error.kind === 'protocol') {
          throw protocolError(error.detail ? `${error.detail}@${event.type}` : `event:${event.type}`);
        }
        throw error;
      }
    }
    if (combined.aborted) throw abortReason(combined);
    throw protocolError('stream:ended');
  } catch (error) {
    if (directory && error instanceof LunaRouteError) {
      captureWrite(directory, `${stamp}-error.txt`,
        `${error.kind}${error.status === undefined ? '' : ` ${error.status}`}${error.detail ? ` ${error.detail}` : ''}\n`);
    }
    if (combined.aborted) throw abortReason(combined);
    if (terminal) return;
    if (error instanceof LunaRouteError) throw error;
    if (error instanceof OpenAI.APIConnectionError) throw new LunaRouteError('network');
    if (error instanceof OpenAI.APIError) {
      if (error.status !== undefined) throw httpError(error.status, error.headers?.get('retry-after'));
      throw new LunaRouteError('upstream');
    }
    throw protocolError();
  } finally {
    closed = true;
    if (directory) {
      capture.directory = undefined;
      if (captured) void vscode.window.showInformationMessage(`LunaRoute diagnostics saved in ${directory}. The files contain your prompts and the model response - review them before sharing.`);
    }
    clearTimeout(timer);
    controller.abort(new LunaRouteError('cancelled'));
  }
}
