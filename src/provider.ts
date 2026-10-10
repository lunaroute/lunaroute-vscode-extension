import * as vscode from 'vscode';
import type { AuthController } from './auth.js';
import type { Catalog } from './catalog.js';
import { LunaRouteError, userMessage, type Attribution } from './lunaroute.js';
import { buildResponsesRequest, estimateTokens, streamResponse } from './responses.js';

export class LunaRouteProvider implements vscode.LanguageModelChatProvider, vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.changes.event;
  private readonly stop = new vscode.CancellationTokenSource();
  private readonly subscription: vscode.Disposable;
  private disposed = false;
  private discoveredEpoch?: number;
  constructor(private readonly auth: AuthController, private readonly catalog: Catalog, private readonly attribution: Attribution,
    private readonly respond: typeof streamResponse = streamResponse) {
    this.subscription = catalog.onDidChange(() => this.changes.fire());
  }
  private check(token: vscode.CancellationToken): void {
    if (this.disposed || token.isCancellationRequested) throw new vscode.CancellationError();
  }
  private scope(token: vscode.CancellationToken) {
    this.check(token);
    const source = new vscode.CancellationTokenSource();
    const controller = new AbortController();
    const cancel = () => { source.cancel(); controller.abort(); };
    const listeners = [token.onCancellationRequested(cancel), this.stop.token.onCancellationRequested(cancel)];
    if (token.isCancellationRequested || this.stop.token.isCancellationRequested) cancel();
    return { token: source.token, signal: controller.signal, dispose() {
      listeners.forEach(listener => listener.dispose());
      source.dispose();
      controller.abort();
    } };
  }
  async provideLanguageModelChatInformation(_options: vscode.PrepareLanguageModelChatModelOptions,
    token: vscode.CancellationToken): Promise<vscode.LanguageModelChatInformation[]> {
    this.check(token);
    const snapshot = this.auth.snapshot();
    if (!snapshot.connection) return [];
    if (this.discoveredEpoch === snapshot.epoch) return [...this.catalog.models];
    const scope = this.scope(token);
    try {
      try { await this.catalog.refresh(scope.token); }
      catch (error) {
        if (scope.token.isCancellationRequested || (error instanceof LunaRouteError && error.kind === 'cancelled')) throw new vscode.CancellationError();
      }
      this.check(scope.token);
      if (this.auth.snapshot().epoch !== snapshot.epoch) throw new vscode.CancellationError();
      this.discoveredEpoch = snapshot.epoch;
      return [...this.catalog.models];
    } finally { scope.dispose(); }
  }
  async provideLanguageModelChatResponse(model: vscode.LanguageModelChatInformation, messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions, progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken): Promise<void> {
    const scope = this.scope(token);
    const snapshot = this.auth.snapshot();
    const signal = AbortSignal.any([snapshot.signal, scope.signal]);
    const current = () => !signal.aborted && !this.disposed && this.auth.snapshot().epoch === snapshot.epoch;
    try {
      if (!snapshot.connection) throw new LunaRouteError('auth');
      const selected = this.catalog.models.find(candidate => candidate.id === model.id);
      if (!selected) throw this.catalog.failure ?? new LunaRouteError('input');
      const request = buildResponsesRequest(selected, messages, options);
      if (!current()) throw new vscode.CancellationError();
      for await (const part of this.respond(snapshot.connection.apiKey, request, this.attribution, signal)) {
        if (!current()) throw new vscode.CancellationError();
        progress.report(part);
      }
      if (!current()) throw new vscode.CancellationError();
    } catch (error) {
      if (!current() || error instanceof vscode.CancellationError || (error instanceof LunaRouteError && error.kind === 'cancelled')) throw new vscode.CancellationError();
      if (error instanceof LunaRouteError && (error.kind === 'auth' || error.kind === 'policy')) this.catalog.invalidate(error);
      if (!current()) throw new vscode.CancellationError();
      throw new Error(userMessage(error));
    } finally { scope.dispose(); }
  }
  async provideTokenCount(_model: vscode.LanguageModelChatInformation, input: string | vscode.LanguageModelChatRequestMessage,
    token: vscode.CancellationToken): Promise<number> {
    this.check(token);
    try { return estimateTokens(input); } catch (error) { throw new Error(userMessage(error)); }
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop.cancel();
    this.stop.dispose();
    this.subscription.dispose();
    this.changes.dispose();
  }
}
