export interface Attribution { version: string; sessionId: string }
export type FailureKind = 'auth' | 'policy' | 'billing' | 'rate-limit' | 'network'
  | 'upstream' | 'storage' | 'input' | 'protocol' | 'cancelled';
export class LunaRouteError extends Error {
  constructor(readonly kind: FailureKind, readonly status?: number, readonly retryAfterSeconds?: number) {
    super(`LunaRoute ${kind} failure`);
    this.name = 'LunaRouteError';
  }
}
export function abortReason(signal: AbortSignal): LunaRouteError {
  return signal.reason instanceof LunaRouteError ? signal.reason : new LunaRouteError('cancelled');
}
export function abortable<T>(promise: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const stop = () => { signal.removeEventListener('abort', stop); reject(abortReason(signal)); };
    Promise.resolve(promise).then(
      value => { signal.removeEventListener('abort', stop); resolve(value); },
      error => { signal.removeEventListener('abort', stop); reject(error); },
    );
    if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
  });
}
export function buildHeaders(key: string, attribution: Attribution): Record<string, string> {
  return {
    Authorization: `Bearer ${key}`,
    'lunaroute-agent': `vscode/${attribution.version}`,
    'x-lunaroute-session': attribution.sessionId,
    'lunaroute-session-id': attribution.sessionId,
  };
}
export function httpError(status: number, retryAfter?: string | null): LunaRouteError {
  const kind: FailureKind = status === 401 ? 'auth' : status === 403 ? 'policy'
    : status === 402 ? 'billing' : status === 429 ? 'rate-limit'
    : status === 408 ? 'network' : status >= 500 ? 'upstream'
    : status === 400 ? 'input' : 'protocol';
  const seconds = retryAfter ? (/^\d+$/.test(retryAfter) ? Number(retryAfter)
    : Math.max(0, Math.ceil((Date.parse(retryAfter) - Date.now()) / 1000))) : undefined;
  return new LunaRouteError(kind, status, Number.isSafeInteger(seconds) ? seconds : undefined);
}
export function userMessage(error: unknown): string {
  if (!(error instanceof LunaRouteError)) return 'LunaRoute request failed. Please try again.';
  const messages: Record<FailureKind, string> = {
    auth: 'LunaRoute authentication failed. Run LunaRoute: Sign In again.',
    policy: 'This LunaRoute connection does not have permission. Check your organization and key in the dashboard.',
    billing: 'A LunaRoute plan or billing update is required. Open the dashboard to check billing.',
    'rate-limit': 'LunaRoute is rate limited. Wait before trying again.',
    network: 'Could not complete the LunaRoute connection. Check your network and try again.',
    upstream: 'The LunaRoute service is temporarily unavailable. Try again later.',
    storage: 'Secure credential storage failed. Sign-out may be incomplete; revoke any unused key in the LunaRoute dashboard.',
    input: 'This chat contains unsupported or oversized input. Reduce it or start a new chat.',
    protocol: 'LunaRoute returned an unsupported response. Try again or start a fresh sign-in.',
    cancelled: 'LunaRoute operation cancelled.',
  };
  if (error.kind === 'rate-limit' && error.retryAfterSeconds !== undefined
    && Number.isSafeInteger(error.retryAfterSeconds) && error.retryAfterSeconds >= 0) {
    return `${messages[error.kind]} Retry after ${error.retryAfterSeconds} seconds.`;
  }
  return messages[error.kind];
}
export const FRONT_URL = 'https://app.lunaroute.com';
export const API_URL = 'https://api.lunaroute.com';
export const ROUTING_URL = 'https://gw.lunaroute.com/v1';
export const LOGIN_TIMEOUT_MS = 900000;
export const EXCHANGE_TIMEOUT_MS = 15000;
export const CATALOG_TIMEOUT_MS = 10000;
