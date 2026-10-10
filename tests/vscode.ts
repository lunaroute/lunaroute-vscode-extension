import type { CancellationToken, Event, LanguageModelChatProvider, SecretStorage } from 'vscode';
import { vi } from 'vitest';

export class Disposable {
  private disposed = false;
  constructor(private readonly cleanup: () => void) {}
  dispose() { if (!this.disposed) { this.disposed = true; this.cleanup(); } }
  static from(...items: { dispose(): unknown }[]) { return new Disposable(() => items.forEach(item => item.dispose())); }
}
export class EventEmitter<T> {
  private listeners = new Set<(value: T) => void>();
  readonly event: Event<T> = (listener, thisArgs, disposables) => {
    const bound = (value: T) => listener.call(thisArgs, value);
    this.listeners.add(bound);
    const disposable = new Disposable(() => { this.listeners.delete(bound); });
    disposables?.push(disposable);
    return disposable;
  };
  fire(value: T) { for (const listener of this.listeners) listener(value); }
  dispose() { this.listeners.clear(); }
}
export class CancellationError extends Error { constructor() { super('Canceled'); this.name = 'Canceled'; } }
export class CancellationTokenSource {
  private emitter = new EventEmitter<void>();
  readonly token: CancellationToken = { isCancellationRequested: false, onCancellationRequested: this.emitter.event };
  cancel() { this.token.isCancellationRequested = true; this.emitter.fire(); }
  dispose() { this.emitter.dispose(); }
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export const LanguageModelChatMessageRole = { User: 1, Assistant: 2 };
export const LanguageModelChatToolMode = { Auto: 1, Required: 2 };
export class LanguageModelTextPart { constructor(public value: string) {} }
export class LanguageModelToolCallPart { constructor(public callId: string, public name: string, public input: object) {} }
export class LanguageModelToolResultPart { constructor(public callId: string, public content: unknown[]) {} }
export class LanguageModelDataPart {
  constructor(public data: Uint8Array, public mimeType: string) {}
  static image(data: Uint8Array, mime: string) { return new LanguageModelDataPart(data, mime); }
  static text(value: string, mime = 'text/plain') { return new LanguageModelDataPart(new TextEncoder().encode(value), mime); }
  static json(value: unknown, mime = 'application/json') { return this.text(JSON.stringify(value), mime); }
}
export class LanguageModelChatMessage {
  content: unknown[];
  constructor(public role: number, content: string | unknown[], public name?: string) {
    this.content = typeof content === 'string' ? [new LanguageModelTextPart(content)] : content;
  }
  static User(content: string | unknown[], name?: string) { return new LanguageModelChatMessage(1, content, name); }
  static Assistant(content: string | unknown[], name?: string) { return new LanguageModelChatMessage(2, content, name); }
}
export const ExtensionKind = { UI: 1, Workspace: 2 };
export const UIKind = { Desktop: 1, Web: 2 };
export const ProgressLocation = { Notification: 15 };
export const Uri = { parse: (value: string) => ({ toString: () => value }) };
export const commandHandlers = new Map<string, (...args: unknown[]) => unknown>();
export const commands = {
  registerCommand(id: string, handler: (...args: unknown[]) => unknown) {
    commandHandlers.set(id, handler);
    return new Disposable(() => { commandHandlers.delete(id); });
  },
  async executeCommand(id: string, ...args: unknown[]) {
    const handler = commandHandlers.get(id);
    if (!handler) throw new Error('Unknown fixture command');
    return handler(...args);
  },
};
export const env = { uiKind: 1, remoteName: undefined as string | undefined,
  openExternal: vi.fn(async (_uri: { toString(): string }) => false),
};
export const registeredProviders = new Map<string, LanguageModelChatProvider>();
export const lm = {
  registerLanguageModelChatProvider(vendor: string, provider: LanguageModelChatProvider) {
    if (registeredProviders.has(vendor)) throw new Error('Duplicate provider');
    registeredProviders.set(vendor, provider);
    return new Disposable(() => { registeredProviders.delete(vendor); });
  },
  invokeTool() { throw new Error('The LunaRoute extension must not execute tools'); },
};
export const preferences = new Map<string, unknown>();
export const workspace = { getConfiguration(section = '') {
  return { get: (key: string) => preferences.get(`${section}.${key}`),
    async update(key: string, value: unknown) { preferences.set(`${section}.${key}`, value); } };
} };
export const notices = { information: [] as string[], errors: [] as string[], nextPick: undefined as string | undefined,
  picks: [] as { items: readonly { label: string }[]; options: unknown }[] };
export const window = {
  async showInformationMessage(message: string) { notices.information.push(message); },
  async showErrorMessage(message: string) { notices.errors.push(message); },
  async showQuickPick<T extends { label: string }>(items: readonly T[], options?: unknown) {
    notices.picks.push({ items, options });
    return items.find(item => item.label === notices.nextPick);
  },
  async withProgress<T>(_options: unknown, task: (progress: unknown, token: CancellationToken) => Promise<T>) {
    const source = new CancellationTokenSource();
    try { return await task({ report() {} }, source.token); } finally { source.dispose(); }
  },
};

export class MemorySecrets implements SecretStorage {
  private values = new Map<string, string>();
  private emitter = new EventEmitter<{ key: string }>();
  readonly onDidChange = this.emitter.event;
  nextStoreGate?: Promise<void>;
  storeStarted = deferred<void>();
  nextDeleteGate?: Promise<void>;
  deleteStarted = deferred<void>();
  failStore = false;
  failDelete = false;
  async keys() { return [...this.values.keys()]; }
  async get(key: string) { return this.values.get(key); }
  async store(key: string, value: string) {
    const gate = this.nextStoreGate;
    this.nextStoreGate = undefined;
    this.storeStarted.resolve();
    if (gate) await gate;
    if (this.failStore) throw new Error('private storage diagnostic');
    this.external(key, value);
  }
  async delete(key: string) {
    const gate = this.nextDeleteGate;
    this.nextDeleteGate = undefined;
    this.deleteStarted.resolve();
    if (gate) await gate;
    if (this.failDelete) throw new Error('private storage diagnostic');
    this.external(key, undefined);
  }
  external(key: string, value: string | undefined) {
    if (value === undefined) this.values.delete(key);
    else this.values.set(key, value);
    this.emitter.fire({ key });
  }
}
