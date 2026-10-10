import * as vscode from 'vscode';
import type { AuthController, AuthSnapshot } from './auth.js';
import { abortable, abortReason, buildHeaders, CATALOG_TIMEOUT_MS, httpError, LunaRouteError, ROUTING_URL, type Attribution } from './lunaroute.js';

type Model = vscode.LanguageModelChatInformation;
const nonChat = ['image_generation', 'embeddings', 'rerank', 'transcription', 'systemone'];
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(value);
const positiveInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

export function mapCatalog(payload: unknown): Model[] {
  if (!record(payload) || !Array.isArray(payload.data)) throw new LunaRouteError('protocol');
  const counts = new Map<string, number>();
  for (const entry of payload.data) {
    if (record(entry) && typeof entry.id === 'string') counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1);
  }
  const models: Model[] = [];
  for (const entry of payload.data) {
    if (!record(entry) || !text(entry.id) || entry.id.trim() !== entry.id || counts.get(entry.id) !== 1) continue;
    const capabilities = entry.capabilities === undefined ? {} : entry.capabilities;
    if (!record(capabilities) || Object.values(capabilities).some(value => typeof value !== 'boolean')
      || nonChat.some(capability => capabilities[capability] === true)) continue;
    if (!positiveInteger(entry.context_window) || !positiveInteger(entry.max_output_tokens)
      || entry.context_window <= entry.max_output_tokens) continue;
    models.push({
      id: entry.id,
      name: text(entry.display_name) ? entry.display_name : entry.id,
      family: text(entry.family) ? entry.family : entry.id,
      version: text(entry.version) ? entry.version : '1',
      maxInputTokens: entry.context_window - entry.max_output_tokens,
      maxOutputTokens: entry.max_output_tokens,
      capabilities: { toolCalling: capabilities.tools === true, imageInput: capabilities.vision === true },
    });
  }
  return models;
}

type Flight = { epoch: number; controller: AbortController; promise: Promise<readonly Model[]>; waiters: number; done: boolean };
export class Catalog implements vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changes.event;
  private readonly subscription: vscode.Disposable;
  private readonly doFetch: typeof fetch;
  private readonly url: string;
  private cached: readonly Model[] = [];
  private fault?: LunaRouteError;
  private flight?: Flight;
  private disposed = false;
  constructor(private readonly auth: AuthController, private readonly attribution: Attribution,
    deps: { fetch?: typeof fetch; url?: string } = {}) {
    this.doFetch = deps.fetch ?? fetch;
    this.url = deps.url ?? `${ROUTING_URL}/models`;
    this.subscription = auth.onDidChange(() => {
      this.flight?.controller.abort(new LunaRouteError('cancelled'));
      this.flight = undefined;
      this.cached = [];
      this.fault = undefined;
      this.changes.fire();
    });
  }
  get models(): readonly Model[] { return this.cached; }
  get failure(): LunaRouteError | undefined { return this.fault; }
  async refresh(token: vscode.CancellationToken): Promise<readonly Model[]> {
    if (this.disposed || token.isCancellationRequested) throw new LunaRouteError('cancelled');
    const snapshot = this.auth.snapshot();
    if (!snapshot.connection) {
      this.cached = [];
      this.fault = new LunaRouteError('auth');
      this.changes.fire();
      throw this.fault;
    }
    if (!this.flight || this.flight.epoch !== snapshot.epoch || this.flight.controller.signal.aborted) {
      const controller = new AbortController();
      const promise = Promise.resolve().then(() => this.load(snapshot, controller));
      const flight: Flight = { controller, promise, epoch: snapshot.epoch, waiters: 0, done: false };
      this.flight = flight;
      const finished = () => { flight.done = true; if (this.flight === flight) this.flight = undefined; };
      void promise.then(finished, finished);
    }
    const flight = this.flight;
    flight.waiters++;
    return new Promise((resolve, reject) => {
      let complete = false;
      let cancellation: vscode.Disposable | undefined;
      const finish = () => {
        if (complete) return false;
        complete = true;
        cancellation?.dispose();
        flight.waiters--;
        return true;
      };
      cancellation = token.onCancellationRequested(() => {
        if (!finish()) return;
        reject(new LunaRouteError('cancelled'));
        if (flight.waiters === 0 && !flight.done) flight.controller.abort(new LunaRouteError('cancelled'));
      });
      if (complete) cancellation.dispose();
      const current = () => !this.disposed && this.auth.snapshot().epoch === flight.epoch;
      flight.promise.then(
        models => { if (finish()) { if (current()) resolve(models); else reject(new LunaRouteError('cancelled')); } },
        error => { if (finish()) reject(current() ? error : new LunaRouteError('cancelled')); },
      );
    });
  }
  private current(snapshot: AuthSnapshot, controller: AbortController) {
    return !this.disposed && this.auth.snapshot().epoch === snapshot.epoch && this.flight?.controller === controller;
  }
  private async load(snapshot: AuthSnapshot, controller: AbortController): Promise<readonly Model[]> {
    const signal = AbortSignal.any([snapshot.signal, controller.signal]);
    const timeout = setTimeout(() => controller.abort(new LunaRouteError('network', 408)), CATALOG_TIMEOUT_MS);
    try {
      if (!this.current(snapshot, controller) || signal.aborted) throw new LunaRouteError('cancelled');
      const response = await abortable(this.doFetch(this.url, {
        headers: buildHeaders(snapshot.connection!.apiKey, this.attribution), redirect: 'error', signal,
      }), signal);
      if (!response.ok) {
        await abortable(response.body?.cancel() ?? Promise.resolve(), signal);
        throw httpError(response.status, response.headers.get('retry-after'));
      }
      let payload: unknown;
      try { payload = await abortable(response.json(), signal); }
      catch (error) { throw error instanceof SyntaxError ? new LunaRouteError('protocol') : error; }
      const models = mapCatalog(payload);
      if (signal.aborted) throw abortReason(signal);
      if (!this.current(snapshot, controller)) throw new LunaRouteError('cancelled');
      this.cached = models;
      this.fault = undefined;
      this.changes.fire();
      return models;
    } catch (error) {
      const failure = signal.aborted ? abortReason(signal) : error instanceof LunaRouteError ? error : new LunaRouteError('network');
      if (this.current(snapshot, controller) && failure.kind !== 'cancelled') {
        this.fault = failure;
        if (!['network', 'upstream', 'rate-limit'].includes(failure.kind)) this.cached = [];
        this.changes.fire();
      }
      throw failure;
    } finally { clearTimeout(timeout); }
  }
  invalidate(error: LunaRouteError): void {
    if (this.disposed) return;
    this.flight?.controller.abort(new LunaRouteError('cancelled'));
    this.flight = undefined;
    this.cached = [];
    this.fault = error;
    this.changes.fire();
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.flight?.controller.abort(new LunaRouteError('cancelled'));
    this.flight = undefined;
    this.cached = [];
    this.fault = undefined;
    this.subscription.dispose();
    this.changes.dispose();
  }
}
