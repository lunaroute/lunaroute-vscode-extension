import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { hostname } from 'node:os';
import * as vscode from 'vscode';
import { abortable, abortReason, API_URL, EXCHANGE_TIMEOUT_MS, FRONT_URL, httpError, LOGIN_TIMEOUT_MS, LunaRouteError } from './lunaroute.js';

export interface Connection { readonly apiKey: string; readonly orgId: string; readonly email?: string }
export interface AuthSnapshot { readonly connection?: Connection; readonly epoch: number; readonly signal: AbortSignal }
export interface AuthController extends vscode.Disposable {
  readonly onDidChange: vscode.Event<void>;
  snapshot(): AuthSnapshot;
  signIn(token: vscode.CancellationToken): Promise<void>;
  signOut(): Promise<void>;
}
const SECRET = 'lunaroute.connection';
const cancelled = () => new LunaRouteError('cancelled');
function parseConnection(value: unknown, exchange = false): Connection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LunaRouteError('protocol');
  const record = value as Record<string, unknown>;
  const apiKey = exchange ? record.full_key : record.apiKey;
  const orgId = exchange ? record.org_id : record.orgId;
  const email = exchange ? record.user_email : record.email;
  if ((exchange && record.source !== 'vscode')
    || typeof apiKey !== 'string' || !/^[\x20-\x7e]{1,512}$/.test(apiKey) || !apiKey.trim()
    || typeof orgId !== 'string' || !/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(orgId)
    || (email !== undefined && typeof email !== 'string')) throw new LunaRouteError('protocol');
  return Object.freeze({ apiKey, orgId, ...(email ? { email } : {}) });
}
function storedConnection(raw: string | undefined): Connection | undefined {
  try { return raw === undefined ? undefined : parseConnection(JSON.parse(raw)); }
  catch { return undefined; }
}

async function browserCode(signal: AbortSignal, openExternal: (url: string) => Promise<boolean>, frontUrl: string) {
  if (signal.aborted) throw abortReason(signal);
  const verifier = randomBytes(32).toString('hex');
  const state = randomBytes(16).toString('hex');
  const origin = new URL(frontUrl).origin;
  let authority = '';
  let used = false;
  let receive!: (code: string) => void;
  const received = new Promise<string>(resolve => { receive = resolve; });
  const server = createServer({ maxHeaderSize: 4096 }, (req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Connection', 'close');
    const reject = (status: number) => { res.statusCode = status; res.end('Invalid or expired callback. Return to VS Code.'); };
    const hostCount = req.rawHeaders.filter((header, index) => index % 2 === 0 && header.toLowerCase() === 'host').length;
    if (hostCount !== 1 || req.headers.host !== authority || req.url?.split('?')[0] !== '/callback' || req.url.includes('#')) return reject(400);
    if (req.headers.origin !== undefined && req.headers.origin !== origin) return reject(403);
    if (req.headers.origin === origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') {
      if (req.headers.origin !== origin || req.headers['access-control-request-method'] !== 'GET') return reject(403);
      res.setHeader('Access-Control-Allow-Methods', 'GET');
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
      res.statusCode = 204;
      res.end();
      return;
    }
    if (req.method !== 'GET') return reject(405);
    const query = new URL(req.url, `http://${authority}`).searchParams;
    const code = query.get('code');
    const returnedState = query.get('state');
    if ([...query.keys()].length !== 2 || query.getAll('state').length !== 1 || query.getAll('code').length !== 1
      || !returnedState || !/^[a-f0-9]{32}$/.test(returnedState)
      || !timingSafeEqual(Buffer.from(returnedState, 'hex'), Buffer.from(state, 'hex'))
      || !code || !/^[a-zA-Z0-9_-]{1,512}$/.test(code)) return reject(400);
    if (used) return reject(409);
    used = true;
    res.end('Authorization received. Return to VS Code to finish sign-in.', () => receive(code));
  });
  try {
    await abortable(new Promise<void>((resolve, reject) => {
      server.once('error', () => reject(new LunaRouteError('network')));
      server.listen(0, '127.0.0.1', resolve);
    }), signal);
    if (signal.aborted) throw abortReason(signal);
    const address = server.address();
    if (!address || typeof address === 'string') throw new LunaRouteError('network');
    authority = `127.0.0.1:${address.port}`;
    const url = new URL('/device-auth/vscode', frontUrl);
    url.search = new URLSearchParams({ port: String(address.port), state, challenge: createHash('sha256').update(verifier).digest('hex') }).toString();
    if (!await abortable(openExternal(url.toString()), signal)) throw new LunaRouteError('network');
    return { code: await abortable(received, signal), verifier };
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

export async function createAuthController(
  secrets: vscode.SecretStorage,
  openExternal: (url: string) => Promise<boolean>,
  deps: { fetch?: typeof fetch; apiUrl?: string; frontUrl?: string; hostname?: string } = {},
): Promise<AuthController> {
  const changes = new vscode.EventEmitter<void>();
  let knownRaw: string | undefined;
  let connection: Connection | undefined;
  let epoch = 0;
  let epochAbort = new AbortController();
  let generation = 0;
  let active: AbortController | undefined;
  let disposed = false;
  let readVersion = 0;
  let reading: Promise<void> = Promise.resolve();
  let mutations: Promise<void> = Promise.resolve();
  let ownWrite: { raw: string | undefined } | undefined;
  function publish(next?: Connection) {
    if (disposed) return;
    epochAbort.abort();
    epochAbort = new AbortController();
    connection = next;
    epoch++;
    changes.fire();
  }
  function external(raw: string | undefined) {
    if (raw === knownRaw) return;
    knownRaw = raw;
    generation++;
    active?.abort(cancelled());
    publish(storedConnection(raw));
  }
  function refresh() {
    const version = ++readVersion;
    reading = Promise.resolve().then(() => secrets.get(SECRET)).then(raw => {
      if (version === readVersion && (!ownWrite || raw !== ownWrite.raw)) external(raw);
    }, () => {
      if (version !== readVersion) return;
      generation++;
      active?.abort(new LunaRouteError('storage'));
      publish();
    });
  }
  const subscription = secrets.onDidChange(event => { if (event.key === SECRET) refresh(); });
  async function settleReads() {
    let pending: Promise<void>;
    do { pending = reading; await pending; } while (pending !== reading);
  }
  function mutate(operation: () => Promise<void>): Promise<void> {
    const pending = mutations.then(operation);
    mutations = pending.then(() => {}, () => {});
    return pending;
  }
  async function write(raw: string | undefined) {
    ownWrite = { raw };
    if (raw === undefined) await secrets.delete(SECRET); else await secrets.store(SECRET, raw);
    await settleReads();
  }
  try {
    const version = readVersion;
    const raw = await secrets.get(SECRET);
    if (version === readVersion) { knownRaw = raw; connection = storedConnection(raw); }
    await settleReads();
  } catch {
    subscription.dispose();
    changes.dispose();
    throw new LunaRouteError('storage');
  }

  return {
    onDidChange: changes.event,
    snapshot: () => ({ connection, epoch, signal: epochAbort.signal }),
    async signIn(token) {
      if (disposed) throw cancelled();
      active?.abort(cancelled());
      const login = new AbortController();
      active = login;
      const current = ++generation;
      const check = () => {
        if (login.signal.aborted) throw abortReason(login.signal);
        if (disposed || current !== generation) throw cancelled();
      };
      let committed = false;
      const cancellation = token.onCancellationRequested(() => { if (!committed) login.abort(cancelled()); });
      if (token.isCancellationRequested) login.abort(cancelled());
      const timeout = setTimeout(() => { if (!committed) login.abort(new LunaRouteError('network', 408)); }, LOGIN_TIMEOUT_MS);
      try {
        const approval = await browserCode(login.signal, openExternal, deps.frontUrl ?? FRONT_URL);
        check();
        const exchange = new AbortController();
        const signal = AbortSignal.any([login.signal, exchange.signal]);
        const exchangeTimeout = setTimeout(() => exchange.abort(new LunaRouteError('network', 408)), EXCHANGE_TIMEOUT_MS);
        let next: Connection;
        try {
          const response = await abortable((deps.fetch ?? fetch)(new URL('/v1/auth/exchange', deps.apiUrl ?? API_URL), {
            method: 'POST', redirect: 'error', signal,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...approval, hostname: deps.hostname ?? hostname() }),
          }), signal);
          check();
          if (!response.ok) {
            await response.body?.cancel();
            throw response.status === 400 ? new LunaRouteError('auth', 400) : httpError(response.status, response.headers.get('retry-after'));
          }
          let body: unknown;
          try { body = await abortable(response.json(), signal); }
          catch { throw signal.aborted ? abortReason(signal) : new LunaRouteError('protocol'); }
          check();
          next = parseConnection(body, true);
        } catch (error) {
          throw signal.aborted ? abortReason(signal) : error;
        } finally { clearTimeout(exchangeTimeout); }
        const raw = JSON.stringify(next);
        await abortable(mutate(async () => {
          check();
          try {
            await write(raw);
            if (login.signal.aborted || disposed || current !== generation) {
              // SecretStorage has no CAS: only compensate our own still-current write.
              if (await secrets.get(SECRET) === raw && knownRaw !== raw) await write(knownRaw);
              check();
            }
            knownRaw = raw;
            committed = true;
            publish(next);
          } catch (error) {
            if (error instanceof LunaRouteError) throw error;
            throw new LunaRouteError('storage');
          } finally { ownWrite = undefined; }
        }), login.signal);
        check();
      } catch (error) {
        if (login.signal.aborted) throw abortReason(login.signal);
        throw error instanceof LunaRouteError ? error : new LunaRouteError('network');
      } finally {
        clearTimeout(timeout);
        cancellation.dispose();
        if (active === login) active = undefined;
      }
    },
    async signOut() {
      if (disposed) throw cancelled();
      const expected = knownRaw;
      const current = ++generation;
      active?.abort(cancelled());
      ++readVersion;
      knownRaw = undefined;
      publish();
      return mutate(async () => {
        try {
          const raw = await secrets.get(SECRET);
          await settleReads();
          if (knownRaw !== undefined || (raw !== expected && raw !== undefined)) {
            external(raw);
            throw cancelled();
          }
          await write(undefined);
          if (knownRaw !== undefined) {
            if (await secrets.get(SECRET) === undefined) await write(knownRaw);
            throw cancelled();
          }
        } catch (error) {
          if (error instanceof LunaRouteError) throw error;
          if (!disposed && generation === current) {
            try { knownRaw = await secrets.get(SECRET); publish(storedConnection(knownRaw)); } catch { /* Remain unusable if storage cannot be read. */ }
          }
          throw new LunaRouteError('storage');
        } finally { ownWrite = undefined; }
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      generation++;
      active?.abort(cancelled());
      epochAbort.abort();
      epoch++;
      connection = undefined;
      changes.dispose();
      // Observe external changes until an uncancellable platform write has settled.
      void mutations.then(() => subscription.dispose());
    },
  };
}
