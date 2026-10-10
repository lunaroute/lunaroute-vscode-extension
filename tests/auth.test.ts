import { createHash } from 'node:crypto';
import { createServer, request, Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAuthController, type AuthController } from '../src/auth.js';
import { CancellationTokenSource, deferred, MemorySecrets } from './vscode.js';

const key = 'lunaroute.connection';
const connection = { apiKey: 'lr_test_key_not_real', orgId: '00000000-0000-4000-8000-000000000001', email: 'person@example.test' };
const wire = { source: 'vscode', full_key: connection.apiKey, org_id: connection.orgId, user_email: connection.email };
const servers: Server[] = [];
const controllers: AuthController[] = [];
afterEach(async () => {
  controllers.splice(0).forEach(controller => controller.dispose());
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  vi.useRealTimers();
});

async function fixture(secrets = new MemorySecrets()) {
  const called = deferred<void>();
  const service = {
    body: wire as unknown, status: 200, location: undefined as string | undefined,
    gate: undefined as Promise<void> | undefined, paths: [] as string[],
    requests: [] as Record<string, string>[],
  };
  const gateway = createServer((req, res) => {
    void (async () => {
      service.paths.push(req.url ?? '');
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      service.requests.push(JSON.parse(Buffer.concat(chunks).toString() || '{}'));
      called.resolve();
      if (service.gate) await service.gate;
      res.statusCode = service.status;
      res.setHeader('Content-Type', 'application/json');
      if (service.location) res.setHeader('Location', service.location);
      res.end(JSON.stringify(service.body));
    })().catch(() => { res.statusCode = 500; res.end(); });
  });
  servers.push(gateway);
  await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve));
  const address = gateway.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');
  const apiUrl = `http://127.0.0.1:${address.port}`;
  const opened = deferred<URL>();
  const urls: URL[] = [];
  const opener = vi.fn(async (value: string) => {
    const url = new URL(value);
    urls.push(url);
    opened.resolve(url);
    return true;
  });
  const controller = await createAuthController(secrets, opener, { apiUrl, hostname: 'test-desktop' });
  controllers.push(controller);
  function begin() {
    const cancel = new CancellationTokenSource();
    const result: Promise<unknown> = controller.signIn(cancel.token).then(() => undefined, error => error);
    return { result, cancel };
  }
  return { service, apiUrl, controller, secrets, begin, opened: opened.promise, urls, opener, called: called.promise };
}

function callback(authorize: URL, query?: string) {
  return new URL(`http://127.0.0.1:${authorize.searchParams.get('port')}/callback?${query ?? new URLSearchParams({
    state: authorize.searchParams.get('state')!, code: 'one-time-code-not-real',
  })}`);
}
function send(url: URL, options: { method?: string; headers?: Record<string, string>; path?: string } = {}) {
  return new Promise<{ status: number; body: string; headers: import('node:http').IncomingHttpHeaders }>((resolve, reject) => {
    const req = request(url, options, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode!, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

it('binds a local PKCE callback to one exchange and saves one validated record before success', async () => {
  const f = await fixture();
  expect(f.opener).not.toHaveBeenCalled();
  const login = f.begin();
  const url = await f.opened;
  expect(url.origin).toBe('https://app.lunaroute.com');
  expect(url.pathname).toBe('/device-auth/vscode');
  expect([...url.searchParams.keys()].sort()).toEqual(['challenge', 'port', 'state']);
  expect(url.searchParams.get('state')).toMatch(/^[a-f0-9]{32}$/);
  expect(url.searchParams.get('challenge')).toMatch(/^[a-f0-9]{64}$/);
  const response = await send(callback(url), { headers: { Origin: url.origin } });
  expect(response.status).toBe(200);
  expect(response.headers['access-control-allow-origin']).toBe(url.origin);
  expect(response.body).not.toMatch(/one-time-code-not-real|lr_test_key_not_real/);
  await expect(login.result).resolves.toBeUndefined();
  expect(f.service.paths).toEqual(['/v1/auth/exchange']);
  const body = f.service.requests[0];
  expect(body).not.toHaveProperty('source');
  expect(body.hostname).toBe('test-desktop');
  expect(body.verifier).toMatch(/^[a-f0-9]{64}$/);
  expect(createHash('sha256').update(body.verifier).digest('hex')).toBe(url.searchParams.get('challenge'));
  expect(JSON.parse((await f.secrets.get(key))!)).toEqual(connection);
  expect(await f.secrets.keys()).toEqual([key]);
  expect(f.controller.snapshot().connection).toEqual(connection);
});

it.each(['wrong-state', 'duplicate-state', 'duplicate-code', 'missing-code', 'oversize-code', 'bad-code', 'unknown-param', 'host', 'path', 'method', 'origin'])
('does not consume a valid attempt after a %s callback', async kind => {
  const f = await fixture();
  const login = f.begin();
  const url = callback(await f.opened);
  const options: Parameters<typeof send>[1] = {};
  if (kind === 'wrong-state') url.searchParams.set('state', 'wrong');
  if (kind === 'duplicate-state') url.searchParams.append('state', url.searchParams.get('state')!);
  if (kind === 'duplicate-code') url.searchParams.append('code', 'another');
  if (kind === 'missing-code') url.searchParams.delete('code');
  if (kind === 'oversize-code') url.searchParams.set('code', 'x'.repeat(513));
  if (kind === 'bad-code') url.searchParams.set('code', 'code\nsecret');
  if (kind === 'unknown-param') url.searchParams.set('verifier', 'not-allowed');
  if (kind === 'host') options.headers = { Host: 'evil.test' };
  if (kind === 'path') options.path = '/not-callback' + url.search;
  if (kind === 'method') options.method = 'POST';
  if (kind === 'origin') options.headers = { Origin: 'https://evil.test' };
  expect((await send(url, options)).status).not.toBe(200);
  expect(f.service.requests).toHaveLength(0);
  expect((await send(callback(f.urls[0]))).status).toBe(200);
  await expect(login.result).resolves.toBeUndefined();
});

it('accepts trusted preflight without consuming the manual-navigation callback', async () => {
  const f = await fixture();
  const login = f.begin();
  const target = callback(await f.opened);
  const preflight = await send(target, { method: 'OPTIONS', headers: {
    Origin: 'https://app.lunaroute.com', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Private-Network': 'true',
  } });
  expect(preflight.status).toBe(204);
  expect(preflight.headers['access-control-allow-origin']).toBe('https://app.lunaroute.com');
  expect(f.service.requests).toHaveLength(0);
  expect((await send(target)).status).toBe(200);
  await expect(login.result).resolves.toBeUndefined();
});

it('two simultaneous callbacks cannot exchange twice', async () => {
  const f = await fixture();
  const login = f.begin();
  const target = callback(await f.opened);
  const delivered = await Promise.allSettled([send(target), send(target)]);
  expect(delivered.some(result => result.status === 'fulfilled' && result.value.status === 200)).toBe(true);
  await expect(login.result).resolves.toBeUndefined();
  expect(f.service.requests).toHaveLength(1);
});

it.each([
  { source: 'pi' }, { source: undefined }, { full_key: '' }, { full_key: 'x'.repeat(513) },
  { full_key: 'key\nsecret' }, { org_id: 'not-a-uuid' }, { user_email: {} },
])('rejects an invalid exchange record: %j', async invalid => {
  const f = await fixture();
  f.service.body = { ...wire, ...invalid };
  const login = f.begin();
  await send(callback(await f.opened));
  await expect(login.result).resolves.toMatchObject({ kind: 'protocol' });
  expect(await f.secrets.get(key)).toBeUndefined();
});

it('omits an empty optional email', async () => {
  const f = await fixture();
  f.service.body = { ...wire, user_email: '' };
  const login = f.begin();
  await send(callback(await f.opened));
  await expect(login.result).resolves.toBeUndefined();
  expect(JSON.parse((await f.secrets.get(key))!)).toEqual({ apiKey: connection.apiKey, orgId: connection.orgId });
});

it.each([[401, 'auth'], [403, 'policy'], [402, 'billing'], [429, 'rate-limit'], [503, 'upstream']])
('classifies HTTP %i without retrying or leaking the response', async (status, kind) => {
  const f = await fixture();
  f.service.status = Number(status);
  f.service.body = { error: 'private credential diagnostic' };
  const login = f.begin();
  await send(callback(await f.opened));
  const error = await login.result;
  expect(error).toMatchObject({ kind, status });
  expect(String(error)).not.toContain('private');
  expect(f.service.requests).toHaveLength(1);
});

it('refuses exchange redirects rather than forwarding the verifier', async () => {
  const f = await fixture();
  f.service.status = 307;
  f.service.location = f.apiUrl + '/must-not-follow';
  const login = f.begin();
  await send(callback(await f.opened));
  expect(await login.result).toMatchObject({ kind: 'network' });
  expect(f.service.paths).toEqual(['/v1/auth/exchange']);
  expect(await f.secrets.get(key)).toBeUndefined();
});

it('reports a browser-open failure and closes its listener', async () => {
  const f = await fixture();
  f.opener.mockImplementation(async value => { f.urls.push(new URL(value)); return false; });
  const login = f.begin();
  await expect(login.result).resolves.toMatchObject({ kind: 'network' });
  await expect(send(callback(f.urls[0]))).rejects.toBeDefined();
});

it.each(['cancel', 'dispose'])('closes the listener on %s', async action => {
  const f = await fixture();
  const login = f.begin();
  const target = callback(await f.opened);
  if (action === 'cancel') login.cancel.cancel(); else f.controller.dispose();
  await expect(login.result).resolves.toMatchObject({ kind: 'cancelled' });
  await expect(send(target)).rejects.toBeDefined();
  expect(await f.secrets.get(key)).toBeUndefined();
});

it('does not open a browser when cancellation wins the listener-ready transition', async () => {
  const f = await fixture();
  const cancellation = new CancellationTokenSource();
  const emit = Server.prototype.emit;
  vi.spyOn(Server.prototype, 'emit').mockImplementation(function (this: Server, event: string | symbol, ...args: unknown[]) {
    const result: boolean = Reflect.apply(emit, this, [event, ...args]);
    if (event === 'listening') queueMicrotask(() => cancellation.cancel());
    return result;
  });
  await expect(f.controller.signIn(cancellation.token)).rejects.toMatchObject({ kind: 'cancelled' });
  expect(f.opener).not.toHaveBeenCalled();
});

it('expires browser authorization at 900000 ms, not sooner', async () => {
  const f = await fixture();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const login = f.begin();
  await f.opened;
  let settled = false;
  const observed = login.result.then(value => { settled = true; return value; });
  await vi.advanceTimersByTimeAsync(899999);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await expect(observed).resolves.toMatchObject({ kind: 'network' });
});

it('aborts an exchange at 15000 ms without retry', async () => {
  const f = await fixture();
  const gate = deferred<void>();
  f.service.gate = gate.promise;
  const login = f.begin();
  const target = callback(await f.opened);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  await send(target);
  await f.called;
  await vi.advanceTimersByTimeAsync(15000);
  await expect(login.result).resolves.toMatchObject({ kind: 'network' });
  expect(f.service.requests).toHaveLength(1);
  gate.resolve();
});

describe('encrypted storage and connection epochs', () => {
  it('waits for secure storage before resolving success', async () => {
    const f = await fixture();
    const gate = deferred<void>();
    f.secrets.nextStoreGate = gate.promise;
    const login = f.begin();
    await send(callback(await f.opened));
    await f.secrets.storeStarted.promise;
    let complete = false;
    const observed = login.result.then(result => { complete = true; return result; });
    await Promise.resolve();
    expect(complete).toBe(false);
    expect(f.controller.snapshot().connection).toBeUndefined();
    gate.resolve();
    await expect(observed).resolves.toBeUndefined();
  });

  it('rejects a store failure without publishing a connection', async () => {
    const f = await fixture();
    f.secrets.failStore = true;
    const login = f.begin();
    await send(callback(await f.opened));
    await expect(login.result).resolves.toMatchObject({ kind: 'storage' });
    expect(f.controller.snapshot().connection).toBeUndefined();
    expect(await f.secrets.get(key)).toBeUndefined();
  });

  it('does not claim sign-out if secure deletion fails', async () => {
    const secrets = new MemorySecrets();
    secrets.external(key, JSON.stringify(connection));
    const f = await fixture(secrets);
    const old = f.controller.snapshot();
    secrets.failDelete = true;
    await expect(f.controller.signOut()).rejects.toMatchObject({ kind: 'storage' });
    expect(await secrets.get(key)).toBe(JSON.stringify(connection));
    expect(old.signal.aborted).toBe(true);
  });

  it('sign-out during exchange cannot store a late credential', async () => {
    const f = await fixture();
    const gate = deferred<void>();
    f.service.gate = gate.promise;
    const login = f.begin();
    await send(callback(await f.opened));
    await f.called;
    await f.controller.signOut();
    gate.resolve();
    await expect(login.result).resolves.toMatchObject({ kind: 'cancelled' });
    expect(await f.secrets.get(key)).toBeUndefined();
  });

  it('a pending store followed by deletion settles signed out, never late signed in', async () => {
    const f = await fixture();
    const gate = deferred<void>();
    f.secrets.nextStoreGate = gate.promise;
    const login = f.begin();
    await send(callback(await f.opened));
    await f.secrets.storeStarted.promise;
    const out = f.controller.signOut();
    gate.resolve();
    await out;
    await expect(login.result).resolves.toMatchObject({ kind: 'cancelled' });
    expect(await f.secrets.get(key)).toBeUndefined();
    expect(f.controller.snapshot().connection).toBeUndefined();
  });

  it('an observed newer connection wins over a delayed obsolete store in another controller', async () => {
    const f = await fixture();
    const second = await fixture(f.secrets);
    const newer = { ...connection, apiKey: 'lr_newer_test_key_not_real' };
    second.service.body = { ...wire, full_key: newer.apiKey };
    const gate = deferred<void>();
    f.secrets.nextStoreGate = gate.promise;
    const olderLogin = f.begin();
    await send(callback(await f.opened));
    await f.secrets.storeStarted.promise;
    const newerLogin = second.begin();
    await send(callback(await second.opened));
    await expect(newerLogin.result).resolves.toBeUndefined();
    await vi.waitFor(() => expect(f.controller.snapshot().connection).toEqual(newer));
    gate.resolve();
    await expect(olderLogin.result).resolves.toMatchObject({ kind: 'cancelled' });
    await vi.waitFor(async () => expect(JSON.parse((await f.secrets.get(key))!)).toEqual(newer));
    await vi.waitFor(() => expect(second.controller.snapshot().connection).toEqual(newer));
  });

  it('propagates external sign-out and aborts the previous connection epoch', async () => {
    const secrets = new MemorySecrets();
    secrets.external(key, JSON.stringify(connection));
    const a = await fixture(secrets);
    const b = await fixture(secrets);
    const old = b.controller.snapshot();
    await a.controller.signOut();
    await vi.waitFor(() => expect(b.controller.snapshot().connection).toBeUndefined());
    expect(old.signal.aborted).toBe(true);
    expect(b.controller.snapshot().epoch).toBeGreaterThan(old.epoch);
  });

  it('does not erase an observed newer key when an old platform deletion finishes late', async () => {
    const secrets = new MemorySecrets();
    secrets.external(key, JSON.stringify(connection));
    const a = await fixture(secrets);
    const b = await fixture(secrets);
    const newer = { ...connection, apiKey: 'lr_newer_test_key_not_real' };
    b.service.body = { ...wire, full_key: newer.apiKey };
    const gate = deferred<void>();
    secrets.nextDeleteGate = gate.promise;
    const out = a.controller.signOut().then(() => undefined, error => error);
    await secrets.deleteStarted.promise;
    const login = b.begin();
    await send(callback(await b.opened));
    await expect(login.result).resolves.toBeUndefined();
    await vi.waitFor(() => expect(a.controller.snapshot().connection).toEqual(newer));
    gate.resolve();
    const outcome = await out;
    expect(await secrets.get(key)).toBe(JSON.stringify(newer));
    expect(outcome).toMatchObject({ kind: 'cancelled' });
    await vi.waitFor(() => expect(b.controller.snapshot().connection).toEqual(newer));
  });

  it('fails closed without leaking a synchronous secure-store read error from an event', async () => {
    const secrets = new MemorySecrets();
    secrets.external(key, JSON.stringify(connection));
    const f = await fixture(secrets);
    const previous = f.controller.snapshot();
    vi.spyOn(secrets, 'get').mockImplementation(() => { throw new Error('private credential diagnostic'); });
    expect(() => secrets.external(key, undefined)).not.toThrow();
    await vi.waitFor(() => expect(f.controller.snapshot().connection).toBeUndefined());
    expect(previous.signal.aborted).toBe(true);
  });

  it('disposal invalidates the epoch as well as aborting its signal', async () => {
    const f = await fixture();
    const previous = f.controller.snapshot();
    f.controller.dispose();
    expect(previous.signal.aborted).toBe(true);
    expect(f.controller.snapshot().epoch).toBeGreaterThan(previous.epoch);
  });

  it('supersedes a pending login without letting its late browser callback win', async () => {
    const f = await fixture();
    const first = f.begin();
    const oldUrl = callback(await f.opened);
    const second = f.begin();
    await vi.waitFor(() => expect(f.urls).toHaveLength(2));
    await expect(first.result).resolves.toMatchObject({ kind: 'cancelled' });
    await expect(send(oldUrl)).rejects.toBeDefined();
    await send(callback(f.urls[1]));
    await expect(second.result).resolves.toBeUndefined();
    expect(f.service.requests).toHaveLength(1);
  });
});
