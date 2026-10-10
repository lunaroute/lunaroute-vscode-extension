import { expect, it, vi } from 'vitest';
import { buildHeaders, httpError, LunaRouteError, userMessage, type FailureKind } from '../src/lunaroute.js';

it('attributes authenticated requests without giving the two session headers different identities', () => {
  const headers = buildHeaders('lr_test_key_not_real', { version: '0.1.0', sessionId: 'test-session' });
  expect(headers).toMatchObject({
    Authorization: 'Bearer lr_test_key_not_real',
    'lunaroute-agent': 'vscode/0.1.0',
    'x-lunaroute-session': 'test-session',
    'lunaroute-session-id': 'test-session',
  });
});
it.each([
  ['auth', /sign in/i], ['policy', /permission/i], ['billing', /billing|plan/i],
  ['rate-limit', /rate|limit/i], ['network', /connect|network/i], ['upstream', /unavailable|service/i],
  ['storage', /secure|credential/i], ['input', /input|chat/i], ['protocol', /response/i],
  ['cancelled', /cancel/i],
] as [FailureKind, RegExp][])('provides actionable, static %s guidance', (kind, text) => {
  expect(userMessage(new LunaRouteError(kind))).toMatch(text);
});
it.each(['17', 'Sat, 10 Oct 2026 12:00:17 GMT'])('shows safe Retry-After timing for %s', header => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-10T12:00:00Z'));
  try { expect(userMessage(httpError(429, header))).toMatch(/17 seconds/); }
  finally { clock.mockRestore(); }
});
it('does not echo upstream messages, bodies or cause chains', () => {
  const error = Object.assign(new Error('Bearer lr_private and callback?code=private'), {
    cause: new Error('private prompt and tool result'), body: 'private conversation',
  });
  const message = userMessage(error);
  expect(message).not.toMatch(/private|Bearer|callback|prompt|tool result/);
  expect(message.length).toBeGreaterThan(10);
});
