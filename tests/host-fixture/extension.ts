import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import type { IncomingHttpHeaders } from 'node:http';
import * as vscode from 'vscode';
import { createAuthController } from '../../src/auth.js';
import { Catalog } from '../../src/catalog.js';
import { LunaRouteProvider } from '../../src/provider.js';
import { streamResponse } from '../../src/responses.js';
import { startGatewayFixture, writeSse } from '../fixtures/responses-sse.js';

type Scenario = 'text' | 'tools' | 'replay' | 'hold';
export interface ProbeAPI {
  connect(): Promise<void>;
  signOut(): Promise<void>;
  replace(): Promise<void>;
  addModel(): Promise<void>;
  scenario(value: Scenario): void;
  readonly requests: { body: Record<string, unknown>; headers: IncomingHttpHeaders }[];
  readonly secretChanges: number;
  readonly closedResponses: number;
  waitForClosed(after: number): Promise<void>;
  dispose(): Promise<void>;
}
const record = (apiKey: string) => ({ apiKey, orgId: '00000000-0000-4000-8000-000000000001' });
const entry = { id: 'probe-chat', context_window: 131072, max_output_tokens: 8192, capabilities: { tools: true, vision: true } };
const event = (type: string, fields: object) => ({ event: type, data: { type, ...fields } });
const message = { id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'hello', annotations: [] }] };
const reasoning = { id: 'rs_1', type: 'reasoning', summary: [], encrypted_content: 'opaque-fixture', status: 'completed' };
const complete = (output: object[]) => event('response.completed', { response: { id: 'resp_1', status: 'completed', output } });

export async function activate(context: vscode.ExtensionContext): Promise<ProbeAPI> {
  const changed = new EventEmitter();
  const requests: ProbeAPI['requests'] = [];
  let mode: Scenario = 'text';
  let apiKey = 'lr_host_fixture_a';
  let challenge = '';
  let secretChanges = 0;
  let closedResponses = 0;
  let entries = [entry];
  const until = async (condition: () => boolean) => {
    while (!condition()) await once(changed, 'change', { signal: AbortSignal.timeout(10_000) });
  };
  const fixture = await startGatewayFixture(async (request, response) => {
    try {
      if (request.url === '/v1/auth/exchange') {
        let raw = '';
        for await (const chunk of request) raw += chunk.toString();
        const body = JSON.parse(raw);
        assert.equal(body.code, 'fixture-code');
        assert.equal(createHash('sha256').update(body.verifier).digest('hex'), challenge);
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ full_key: apiKey, org_id: record(apiKey).orgId, source: 'vscode' }));
        return;
      }
      assert.equal(request.headers.authorization, 'Bearer ' + apiKey);
      if (request.url === '/v1/models') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ data: entries }));
        return;
      }
      assert.equal(request.url, '/v1/responses');
      let raw = '';
      for await (const chunk of request) raw += chunk.toString();
      requests.push({ body: JSON.parse(raw), headers: request.headers });
      changed.emit('change');
      response.on('close', () => { closedResponses++; changed.emit('change'); });
      if (mode === 'tools') {
        const calls = [0, 1].map(index => ({ type: 'function_call', id: 'fc_' + index, call_id: 'call-' + index,
          name: 'read_file', arguments: JSON.stringify({ path: index ? 'b.ts' : 'a.ts' }), status: 'completed' }));
        writeSse(response, [...calls.map((item, output_index) => event('response.output_item.done', { item, output_index })), complete(calls)]);
      } else if (mode === 'replay') {
        writeSse(response, [event('response.output_item.done', { output_index: 0, item: reasoning }),
          event('response.output_item.done', { output_index: 1, item: message }), complete([reasoning, message])]);
      } else {
        writeSse(response, [event('response.output_item.added', { output_index: 0, item: { ...message, content: [], status: 'in_progress' } }),
          event('response.output_text.delta', { output_index: 0, item_id: 'msg_1', content_index: 0, delta: mode === 'hold' ? 'waiting' : 'hel' }),
          ...(mode === 'hold' ? [] : [event('response.output_item.done', { output_index: 0, item: message }), complete([message])])], mode !== 'hold');
      }
    } catch {
      response.statusCode = 500;
      response.end('Controlled fixture rejected the request');
    }
  });
  const secretsSubscription = context.secrets.onDidChange(() => { secretChanges++; changed.emit('change'); });
  const auth = await createAuthController(context.secrets, async url => {
    const params = new URL(url).searchParams;
    challenge = params.get('challenge')!;
    const callback = new URL('http://127.0.0.1:' + params.get('port') + '/callback');
    callback.search = new URLSearchParams({ state: params.get('state')!, code: 'fixture-code' }).toString();
    return (await fetch(callback)).ok;
  }, { apiUrl: fixture.origin, frontUrl: fixture.origin, hostname: 'host-fixture' });
  const attribution = { version: '0.1.0', sessionId: '00000000-0000-4000-8000-000000000003' };
  const catalog = new Catalog(auth, attribution, { url: fixture.baseURL + '/models' });
  const provider = new LunaRouteProvider(auth, catalog, attribution,
    (key, request, headers, signal) => streamResponse(key, request, headers, signal, fixture.baseURL));
  const registration = vscode.lm.registerLanguageModelChatProvider('lunaroute-probe', provider);
  const authSubscription = auth.onDidChange(() => changed.emit('change'));
  const refresh = async () => {
    const source = new vscode.CancellationTokenSource();
    try { await catalog.refresh(source.token); } finally { source.dispose(); }
  };
  let closing: Promise<void> | undefined;
  const api: ProbeAPI = {
    async connect() {
      const before = secretChanges;
      const source = new vscode.CancellationTokenSource();
      try { await auth.signIn(source.token); } finally { source.dispose(); }
      await until(() => secretChanges > before);
      await refresh();
    },
    async signOut() { await auth.signOut(); },
    async replace() {
      apiKey = 'lr_host_fixture_b';
      await context.secrets.store('lunaroute.connection', JSON.stringify(record(apiKey)));
      await until(() => auth.snapshot().connection?.apiKey === apiKey);
      await refresh();
    },
    async addModel() { entries = [entry, { ...entry, id: 'probe-second' }]; await refresh(); },
    scenario(value) { mode = value; },
    get requests() { return requests; },
    get secretChanges() { return secretChanges; },
    get closedResponses() { return closedResponses; },
    async waitForClosed(after) { await until(() => closedResponses > after); },
    dispose() {
      return closing ??= (async () => {
        try { await auth.signOut(); } finally {
          registration.dispose(); provider.dispose(); catalog.dispose(); auth.dispose();
          secretsSubscription.dispose(); authSubscription.dispose();
          await fixture.close();
          changed.removeAllListeners();
        }
      })();
    },
  };
  context.subscriptions.push({ dispose() { void api.dispose(); } });
  return api;
}
