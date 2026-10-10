import type { CancellationToken, Event, SecretStorage } from 'vscode';
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
export const notices = { information: [] as string[], errors: [] as string[], nextPick: undefined as string | undefined };
export const window = {
  async showInformationMessage(message: string) { notices.information.push(message); },
  async showErrorMessage(message: string) { notices.errors.push(message); },
  async showQuickPick<T extends { label: string }>(items: readonly T[], _options?: unknown) {
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
