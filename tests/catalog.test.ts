import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { afterEach, expect, it, vi } from 'vitest';
import { createAuthController, type AuthController } from '../src/auth.js';
import { Catalog, mapCatalog } from '../src/catalog.js';
import { LunaRouteError } from '../src/lunaroute.js';
import { CancellationTokenSource, deferred, MemorySecrets } from './vscode.js';

const entry = { id: 'chat-a', display_name: 'Chat A', context_window: 131072, max_output_tokens: 8192,
  capabilities: { tools: true, vision: true } };
const connection = { apiKey: 'lr_catalog_fixture_a', orgId: '00000000-0000-4000-8000-000000000001' };
const attribution = { version: '0.1.0', sessionId: '00000000-0000-4000-8000-000000000003' };
const catalogs: Catalog[] = [];
const auths: AuthController[] = [];
const servers: Server[] = [];
afterEach(async () => {
  catalogs.splice(0).forEach(catalog => catalog.dispose());
  auths.splice(0).forEach(auth => auth.dispose());
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  vi.useRealTimers();
});
const token = () => new CancellationTokenSource();
const outcome = <T>(promise: Promise<T>): Promise<T | unknown> => promise.catch(error => error);

it('maps raw IDs and reserves output space from the complete context window', () => {
  expect(mapCatalog({ data: [entry] })).toEqual([{ id: 'chat-a', name: 'Chat A', family: 'chat-a', version: '1',
    maxInputTokens: 122880, maxOutputTokens: 8192, capabilities: { toolCalling: true, imageInput: true } }]);
});
it('uses declared family/version and treats absent capabilities as false', () => {
  expect(mapCatalog({ data: [{ ...entry, id: 'vendor/raw-id', family: 'my-family', version: '2026-10', capabilities: undefined }] })[0])
    .toMatchObject({ id: 'vendor/raw-id', family: 'my-family', version: '2026-10', capabilities: { toolCalling: false, imageInput: false } });
  expect(mapCatalog({ data: [{ ...entry, id: 'vendor/raw-id', display_name: '', family: {}, version: 4 }] })[0])
    .toMatchObject({ id: 'vendor/raw-id', name: 'vendor/raw-id', family: 'vendor/raw-id', version: '1' });
});
it.each([null, [], {}, { data: null }, { data: {} }])('rejects malformed catalog envelopes: %j', payload => {
  expect(() => mapCatalog(payload)).toThrow(LunaRouteError);
});
it('accepts a successful empty catalog', () => { expect(mapCatalog({ data: [] })).toEqual([]); });
it.each([
  { id: '' }, { id: ' ' }, { id: ' bad' }, { id: 'bad\nname' },
  { context_window: 0 }, { context_window: '131072' }, { context_window: 1.5 }, { context_window: Number.MAX_SAFE_INTEGER + 1 },
  { max_output_tokens: -1 }, { max_output_tokens: 1.5 }, { max_output_tokens: undefined },
  { context_window: 8192 }, { context_window: 4000 },
  { capabilities: { tools: 'true' } }, { capabilities: { vision: 1 } }, { capabilities: [] },
])('excludes unsafe metadata rather than guessing limits or coercing it: %j', invalid => {
  expect(mapCatalog({ data: [{ ...entry, ...invalid }] })).toEqual([]);
});
it('excludes ambiguous duplicate IDs without discarding unrelated models', () => {
  expect(mapCatalog({ data: [entry, { ...entry, context_window: 16384 }, { ...entry, id: 'chat-b' }] }).map(model => model.id)).toEqual(['chat-b']);
});
it.each(['image_generation', 'embeddings', 'rerank', 'transcription', 'systemone'])('excludes the non-chat %s capability', capability => {
  expect(mapCatalog({ data: [{ ...entry, capabilities: { [capability]: true, tools: true } }] })).toEqual([]);
});

async function fixture(doFetch?: typeof fetch) {
  const secrets = new MemorySecrets();
  secrets.external('lunaroute.connection', JSON.stringify(connection));
  const auth = await createAuthController(secrets, async () => { throw new Error('Discovery must not open a browser'); });
  auths.push(auth);
  const received = deferred<void>();
  const service = { payload: { data: [entry] } as unknown, status: 200, location: undefined as string | undefined,
    gate: undefined as Promise<void> | undefined, requests: [] as { path: string; headers: IncomingHttpHeaders }[] };
  const server = createServer((request, response) => {
    const { payload, status, location, gate } = service;
    service.requests.push({ path: request.url ?? '', headers: request.headers });
    received.resolve();
    void (async () => {
      if (gate) await gate;
      response.statusCode = status;
      response.setHeader('Content-Type', 'application/json');
      if (location) response.setHeader('Location', location);
      response.end(JSON.stringify(payload));
    })().catch(() => response.destroy());
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind');
  const url = `http://127.0.0.1:${address.port}/v1/models`;
  const catalog = new Catalog(auth, attribution, { url, fetch: doFetch });
  catalogs.push(catalog);
  return { auth, secrets, catalog, service, url, received: received.promise };
}

it('requests the authenticated catalog with shared attribution and never invents a model for failure', async () => {
  const f = await fixture();
  expect(f.service.requests).toEqual([]);
  expect((await f.catalog.refresh(token().token))[0].id).toBe('chat-a');
  expect(f.service.requests[0]).toMatchObject({ path: '/v1/models', headers: {
    authorization: 'Bearer lr_catalog_fixture_a', 'lunaroute-agent': 'vscode/0.1.0',
    'x-lunaroute-session': '00000000-0000-4000-8000-000000000003',
    'lunaroute-session-id': '00000000-0000-4000-8000-000000000003',
  } });
  expect(f.catalog.failure).toBeUndefined();
  f.service.status = 401;
  await expect(f.catalog.refresh(token().token)).rejects.toMatchObject({ kind: 'auth' });
  expect(f.catalog.models).toEqual([]);
  expect(f.catalog.failure?.kind).toBe('auth');
  expect(await f.secrets.get('lunaroute.connection')).toBe(JSON.stringify(connection));
});

it('coalesces same-epoch requests but cancellation belongs to each waiter', async () => {
  const f = await fixture();
  const gate = deferred<void>();
  f.service.gate = gate.promise;
  const first = token();
  const second = token();
  const a = outcome(f.catalog.refresh(first.token));
  const b = f.catalog.refresh(second.token);
  await f.received;
  first.cancel();
  expect(await a).toMatchObject({ kind: 'cancelled' });
  gate.resolve();
  expect((await b)[0].id).toBe('chat-a');
  expect(f.service.requests).toHaveLength(1);
});

it('aborts when the last waiter cancels and permits a new explicit attempt', async () => {
  const calls: AbortSignal[] = [];
  const first = deferred<Response>();
  const transport: typeof fetch = async (_input, options) => {
    calls.push(options!.signal as AbortSignal);
    return calls.length === 1 ? first.promise : new Response(JSON.stringify({ data: [entry] }));
  };
  const f = await fixture(transport);
  const source = token();
  const result = outcome(f.catalog.refresh(source.token));
  await vi.waitFor(() => expect(calls).toHaveLength(1));
  source.cancel();
  expect(await result).toMatchObject({ kind: 'cancelled' });
  expect(calls[0].aborted).toBe(true);
  expect((await f.catalog.refresh(token().token))[0].id).toBe('chat-a');
  first.resolve(new Response(JSON.stringify({ data: [{ ...entry, id: 'obsolete' }] })));
  await Promise.resolve();
  expect(f.catalog.models.map(model => model.id)).toEqual(['chat-a']);
});

it('rejects redirects without forwarding credentials', async () => {
  const f = await fixture();
  f.service.status = 307;
  f.service.location = f.url.replace('/v1/models', '/must-not-follow');
  await expect(f.catalog.refresh(token().token)).rejects.toMatchObject({ kind: 'network' });
  expect(f.service.requests.map(request => request.path)).toEqual(['/v1/models']);
  expect(f.catalog.models).toEqual([]);
});

it('times out at 10000 ms and allows explicit retry rather than retaining a rejected promise', async () => {
  const f = await fixture();
  const gate = deferred<void>();
  f.service.gate = gate.promise;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const request = outcome(f.catalog.refresh(token().token));
  await f.received;
  let finished = false;
  const observed = request.then(result => { finished = true; return result; });
  await vi.advanceTimersByTimeAsync(9999);
  expect(finished).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await observed).toMatchObject({ kind: 'network' });
  expect(f.catalog.failure?.kind).toBe('network');
  gate.resolve();
  f.service.gate = undefined;
  expect((await f.catalog.refresh(token().token))[0].id).toBe('chat-a');
  expect(f.service.requests).toHaveLength(2);
});

it('retains only same-connection metadata on transient failure and replaces it on empty success', async () => {
  const f = await fixture();
  await f.catalog.refresh(token().token);
  f.service.status = 503;
  await expect(f.catalog.refresh(token().token)).rejects.toMatchObject({ kind: 'upstream' });
  expect(f.catalog.models.map(model => model.id)).toEqual(['chat-a']);
  f.service.status = 200;
  f.service.payload = { data: [] };
  await expect(f.catalog.refresh(token().token)).resolves.toEqual([]);
  expect(f.catalog.models).toEqual([]);
  expect(f.catalog.failure).toBeUndefined();
});

it('does not retain metadata after a malformed successful response', async () => {
  const f = await fixture();
  await f.catalog.refresh(token().token);
  f.service.payload = { data: {} };
  await expect(f.catalog.refresh(token().token)).rejects.toMatchObject({ kind: 'protocol' });
  expect(f.catalog.models).toEqual([]);
});

it('clears cached metadata on confirmed 403 and exposes a safe management error', async () => {
  const f = await fixture();
  await f.catalog.refresh(token().token);
  f.service.status = 403;
  f.service.payload = { error: 'private key or prompt diagnostic' };
  await expect(f.catalog.refresh(token().token)).rejects.toMatchObject({ kind: 'policy' });
  expect(f.catalog.models).toEqual([]);
  expect(String(f.catalog.failure)).not.toContain('private');
});

it('ignores obsolete completion after credential replacement even if the transport ignores abort', async () => {
  const delayed = deferred<Response>();
  const started = deferred<void>();
  let requests = 0;
  const transport: typeof fetch = async () => {
    if (++requests === 1) { started.resolve(); return delayed.promise; }
    return new Response(JSON.stringify({ data: [{ ...entry, id: 'new-account' }] }));
  };
  const f = await fixture(transport);
  const events: string[][] = [];
  f.catalog.onDidChange(() => events.push(f.catalog.models.map(model => model.id)));
  const old = outcome(f.catalog.refresh(token().token));
  await started.promise;
  f.secrets.external('lunaroute.connection', JSON.stringify({ ...connection, apiKey: 'lr_catalog_fixture_b' }));
  await vi.waitFor(() => expect(f.auth.snapshot().connection?.apiKey).toBe('lr_catalog_fixture_b'));
  expect(await old).toMatchObject({ kind: 'cancelled' });
  expect(f.catalog.models).toEqual([]);
  expect((await f.catalog.refresh(token().token))[0].id).toBe('new-account');
  delayed.resolve(new Response(JSON.stringify({ data: [{ ...entry, id: 'obsolete' }] })));
  await Promise.resolve();
  expect(f.catalog.models.map(model => model.id)).toEqual(['new-account']);
  expect(events.flat()).not.toContain('obsolete');
});

it.each([200, 503])('does not deliver an obsolete %i result after a publication listener changes the connection', async status => {
  const f = await fixture();
  f.service.status = status;
  let logout: Promise<void> | undefined;
  f.catalog.onDidChange(() => {
    if (f.catalog.models.length || f.catalog.failure) logout = f.auth.signOut();
  });
  await expect(f.catalog.refresh(token().token)).rejects.toMatchObject({ kind: 'cancelled' });
  await logout;
  expect(f.catalog.models).toEqual([]);
  expect(f.catalog.failure).toBeUndefined();
});

it('sign-out clears catalog state and unauthenticated discovery never makes a request', async () => {
  const f = await fixture();
  await f.catalog.refresh(token().token);
  await f.auth.signOut();
  expect(f.catalog.models).toEqual([]);
  await expect(f.catalog.refresh(token().token)).rejects.toMatchObject({ kind: 'auth' });
  expect(f.service.requests).toHaveLength(1);
});

it('already-cancelled requests and disposed catalogs do not start network work', async () => {
  const f = await fixture();
  const source = token();
  source.cancel();
  await expect(f.catalog.refresh(source.token)).rejects.toMatchObject({ kind: 'cancelled' });
  f.catalog.dispose();
  await expect(f.catalog.refresh(token().token)).rejects.toMatchObject({ kind: 'cancelled' });
  expect(f.service.requests).toEqual([]);
});
