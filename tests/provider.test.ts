import { afterEach, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { createAuthController } from '../src/auth.js';
import { Catalog } from '../src/catalog.js';
import { LunaRouteProvider } from '../src/provider.js';
import { LunaRouteError } from '../src/lunaroute.js';
import type { streamResponse } from '../src/responses.js';
import { deferred, MemorySecrets } from './vscode.js';

const connection = { apiKey: 'lr_provider_fixture_a', orgId: '00000000-0000-4000-8000-000000000001' };
const attribution = { version: '0.1.0', sessionId: '00000000-0000-4000-8000-000000000003' };
const entry = { id: 'chat-a', display_name: 'Chat A', context_window: 131072, max_output_tokens: 8192, capabilities: { tools: true, vision: true } };
const token = () => new vscode.CancellationTokenSource();
const auto = { toolMode: vscode.LanguageModelChatToolMode.Auto };
const cleanup: vscode.Disposable[] = [];
afterEach(() => cleanup.splice(0).forEach(item => item.dispose()));
async function fixture(connected = true, respond?: typeof streamResponse, transport?: typeof fetch) {
  const secrets = new MemorySecrets();
  if (connected) secrets.external('lunaroute.connection', JSON.stringify(connection));
  const auth = await createAuthController(secrets, async () => { throw new Error('Discovery must not open a browser'); });
  const state = { status: 200, payload: { data: [entry] } as unknown, requests: [] as string[] };
  const catalog = new Catalog(auth, attribution, { fetch: transport ?? (async input => {
    state.requests.push(input.toString());
    return new Response(JSON.stringify(state.payload), { status: state.status });
  }) });
  cleanup.push(catalog, auth);
  const provider = new LunaRouteProvider(auth, catalog, attribution, respond);
  cleanup.unshift(provider);
  return { secrets, auth, catalog, provider, state };
}
const models = (provider: LunaRouteProvider) => provider.provideLanguageModelChatInformation({ silent: true }, token().token);

it('quietly returns no models when signed out, even for non-silent discovery', async () => {
  const f = await fixture(false);
  expect(await models(f.provider)).toEqual([]);
  expect(await f.provider.provideLanguageModelChatInformation({ silent: false }, token().token)).toEqual([]);
  expect(f.state.requests).toEqual([]);
});
it('publishes model changes after a connection arrives, without setting default model preferences', async () => {
  const f = await fixture(false);
  let changes = 0;
  f.provider.onDidChangeLanguageModelChatInformation(() => { changes++; });
  f.secrets.external('lunaroute.connection', JSON.stringify(connection));
  await vi.waitFor(() => expect(f.auth.snapshot().connection).toBeDefined());
  expect(changes).toBeGreaterThan(0);
  const info = await models(f.provider);
  expect(info.map(model => model.id)).toEqual(['chat-a']);
  expect(info[0]).not.toHaveProperty('isDefault');
  expect(info[0]).not.toHaveProperty('isFallback');
  expect(await models(f.provider)).toEqual(info);
  expect(f.state.requests).toHaveLength(1);
});
it.each(['empty', 'failure'])('does not create fake models or a discovery retry loop for %s catalogs', async condition => {
  const f = await fixture();
  if (condition === 'empty') f.state.payload = { data: [] };
  else f.state.status = 503;
  expect(await models(f.provider)).toEqual([]);
  expect(await models(f.provider)).toEqual([]);
  expect(f.state.requests).toHaveLength(1);
  if (condition === 'failure') expect(f.catalog.failure?.kind).toBe('upstream');
});
it('reports tools but never executes them, and uses authoritative catalog limits rather than stale host metadata', async () => {
  const captured: Parameters<typeof streamResponse>[] = [];
  const respond: typeof streamResponse = async function* (...args) {
    captured.push(args);
    yield new vscode.LanguageModelToolCallPart('call-1', 'read_file', { path: 'a.ts' });
  };
  const f = await fixture(true, respond);
  const [model] = await models(f.provider);
  const parts: vscode.LanguageModelResponsePart[] = [];
  await f.provider.provideLanguageModelChatResponse({ ...model, maxInputTokens: 1, maxOutputTokens: 1 },
    [vscode.LanguageModelChatMessage.User('Read the file')], { ...auto, tools: [{ name: 'read_file', description: 'Read', inputSchema: { type: 'object' } }] },
    { report: part => parts.push(part) }, token().token);
  expect(parts).toEqual([new vscode.LanguageModelToolCallPart('call-1', 'read_file', { path: 'a.ts' })]);
  expect(captured).toHaveLength(1);
  expect(captured[0][0]).toBe('lr_provider_fixture_a');
  expect(captured[0][1]).toMatchObject({ model: 'chat-a', store: false, max_output_tokens: 8192 });
  expect(captured[0][2]).toEqual(attribution);
  expect(captured[0][4]).toBeUndefined();
});
it.each(['caller', 'connection', 'dispose'])('turns %s cancellation into native cancellation and suppresses late progress', async mode => {
  const started = deferred<void>();
  const release = deferred<void>();
  let signal: AbortSignal | undefined;
  const respond: typeof streamResponse = async function* (_key, _request, _attribution, currentSignal) {
    signal = currentSignal;
    started.resolve();
    await release.promise;
    yield new vscode.LanguageModelTextPart('obsolete');
  };
  const f = await fixture(true, respond);
  const [model] = await models(f.provider);
  const source = token();
  const parts: vscode.LanguageModelResponsePart[] = [];
  const response = f.provider.provideLanguageModelChatResponse(model, [vscode.LanguageModelChatMessage.User('hello')], auto,
    { report: part => parts.push(part) }, source.token).catch(error => error);
  await started.promise;
  if (mode === 'caller') source.cancel();
  else if (mode === 'connection') await f.auth.signOut();
  else f.provider.dispose();
  expect(signal?.aborted).toBe(true);
  release.resolve();
  expect(await response).toBeInstanceOf(vscode.CancellationError);
  expect(parts).toEqual([]);
});
it.each([
  ['auth', /sign in/i], ['policy', /permission|organization/i], ['billing', /billing|plan/i],
  ['rate-limit', /rate limit/i], ['network', /network/i], ['input', /unsupported|new chat/i],
] as const)('surfaces safe %s guidance without a raw error cause', async (kind, message) => {
  const f = await fixture(true, async function* () { throw new LunaRouteError(kind); });
  const [model] = await models(f.provider);
  const error = await f.provider.provideLanguageModelChatResponse(model, [vscode.LanguageModelChatMessage.User('hello')], auto,
    { report() { throw new Error('Must not publish a response'); } }, token().token).catch(error => error);
  expect(error.message).toMatch(message);
  expect(error).not.toHaveProperty('cause');
  if (kind === 'auth' || kind === 'policy') {
    expect(f.catalog.models).toEqual([]);
    expect(f.catalog.failure?.kind).toBe(kind);
    const retry = await f.provider.provideLanguageModelChatResponse(model, [vscode.LanguageModelChatMessage.User('hello')], auto,
      { report() {} }, token().token).catch(error => error);
    expect(retry.message).toMatch(message);
    expect(await models(f.provider)).toEqual([]);
    expect(f.state.requests).toHaveLength(1);
  }
  expect(await f.secrets.get('lunaroute.connection')).toBe(JSON.stringify(connection));
});
it('does not let an obsolete authorization error invalidate the replacement connection', async () => {
  const started = deferred<void>();
  const release = deferred<void>();
  const f = await fixture(true, async function* () { started.resolve(); await release.promise; throw new LunaRouteError('auth'); });
  const [model] = await models(f.provider);
  const response = f.provider.provideLanguageModelChatResponse(model, [vscode.LanguageModelChatMessage.User('hello')], auto,
    { report() {} }, token().token).catch(error => error);
  await started.promise;
  f.secrets.external('lunaroute.connection', JSON.stringify({ ...connection, apiKey: 'lr_provider_fixture_b' }));
  await vi.waitFor(() => expect(f.auth.snapshot().connection?.apiKey).toBe('lr_provider_fixture_b'));
  await models(f.provider);
  release.resolve();
  expect(await response).toBeInstanceOf(vscode.CancellationError);
  expect(f.catalog.models.map(model => model.id)).toEqual(['chat-a']);
  expect(f.catalog.failure).toBeUndefined();
});
it('cancels a discovery waiter on disposal and never emits later changes', async () => {
  const started = deferred<void>();
  const body = deferred<Response>();
  let signal: AbortSignal | undefined;
  const f = await fixture(true, undefined, async (_url, options) => { signal = options?.signal as AbortSignal; started.resolve(); return body.promise; });
  let events = 0;
  f.provider.onDidChangeLanguageModelChatInformation(() => { events++; });
  const discovery = models(f.provider).catch(error => error);
  await started.promise;
  f.provider.dispose();
  expect(await discovery).toBeInstanceOf(vscode.CancellationError);
  expect(signal?.aborted).toBe(true);
  body.resolve(new Response(JSON.stringify({ data: [entry] })));
  await f.auth.signOut();
  expect(events).toBe(0);
});
it('counts conservative tokens and rejects already-cancelled operations without inference', async () => {
  const f = await fixture();
  const [model] = await models(f.provider);
  expect(await f.provider.provideTokenCount(model, '猫', token().token)).toBe(3);
  const source = token();
  source.cancel();
  await expect(f.provider.provideTokenCount(model, 'hello', source.token)).rejects.toBeInstanceOf(vscode.CancellationError);
  await expect(f.provider.provideLanguageModelChatResponse(model, [vscode.LanguageModelChatMessage.User('hello')], auto,
    { report() {} }, source.token)).rejects.toBeInstanceOf(vscode.CancellationError);
});
