import { get } from 'node:http';
import { readFileSync } from 'node:fs';
import type { ExtensionContext } from 'vscode';
import { afterEach, expect, it, vi } from 'vitest';
import { activate, deactivate } from '../src/extension.js';
import { CancellationTokenSource, commandHandlers, commands, deferred, env, lm, MemorySecrets, notices, preferences, registeredProviders } from './vscode.js';

function context(secrets = new MemorySecrets(), extensionKind = 1) {
  return { secrets, subscriptions: [], extension: { extensionKind, packageJSON: { version: '0.1.0' } } } as unknown as ExtensionContext;
}
afterEach(() => {
  deactivate();
  env.uiKind = 1;
  env.remoteName = undefined;
  notices.information.length = 0;
  notices.errors.length = 0;
  notices.nextPick = undefined;
  notices.picks.length = 0;
  preferences.clear();
  vi.unstubAllGlobals();
});

it('silently activates with native commands and no credential-bearing exports', async () => {
  const exported = await activate(context());
  expect(exported).toBeUndefined();
  expect([...commandHandlers.keys()].sort()).toEqual(['lunaroute.manage', 'lunaroute.refreshModels', 'lunaroute.signIn', 'lunaroute.signOut']);
  expect(registeredProviders.has('lunaroute')).toBe(true);
  expect(env.openExternal).not.toHaveBeenCalled();
  expect(notices.information).toEqual([]);
  expect(notices.errors).toEqual([]);
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  expect(manifest.contributes.commands.map((entry: { command: string }) => entry.command).sort()).toEqual([...commandHandlers.keys()].sort());
  expect(manifest.contributes.languageModelChatProviders).toEqual([{ vendor: 'lunaroute', displayName: 'LunaRoute', managementCommand: 'lunaroute.manage' }]);
});

it.each(['ssh-remote', 'wsl', 'dev-container'])('permits UI placement in a desktop %s window', async remote => {
  env.remoteName = remote;
  await activate(context());
  expect(commandHandlers.has('lunaroute.signIn')).toBe(true);
  expect(env.openExternal).not.toHaveBeenCalled();
});

it.each(['web', 'workspace'])('refuses unsupported %s placement before touching credentials', async placement => {
  const secrets = new MemorySecrets();
  const read = vi.spyOn(secrets, 'get');
  if (placement === 'web') env.uiKind = 2;
  await activate(context(secrets, placement === 'workspace' ? 2 : 1));
  expect(read).not.toHaveBeenCalled();
  expect(commandHandlers.size).toBe(0);
  expect(notices.errors.join(' ')).toMatch(/desktop|local/i);
});

it('does not announce connection until secure storage completes', async () => {
  const secrets = new MemorySecrets();
  const gate = deferred<void>();
  secrets.nextStoreGate = gate.promise;
  let exchanged = 0;
  const exchange = vi.fn(async (input: URL, options: RequestInit) => {
    if (input.toString() === 'https://gw.lunaroute.com/v1/models') return new Response(JSON.stringify({ data: [] }));
    exchanged++;
    expect(input.toString()).toBe('https://api.lunaroute.com/v1/auth/exchange');
    expect(options.redirect).toBe('error');
    return new Response(JSON.stringify({ source: 'vscode', full_key: 'lr_fixture_not_real',
      org_id: '00000000-0000-4000-8000-000000000001' }), { status: 200 });
  });
  vi.stubGlobal('fetch', exchange);
  env.openExternal.mockImplementation(async uri => {
    const authorization = new URL(uri.toString());
    const url = new URL(`http://127.0.0.1:${authorization.searchParams.get('port')}/callback`);
    url.search = new URLSearchParams({ state: authorization.searchParams.get('state')!, code: 'fixture-code' }).toString();
    await new Promise<void>((resolve, reject) => {
      get(url, response => { response.resume(); response.on('end', resolve); }).on('error', reject);
    });
    return true;
  });
  await activate(context(secrets));
  const signIn = commands.executeCommand('lunaroute.signIn');
  await secrets.storeStarted.promise;
  expect(notices.information).toEqual([]);
  gate.resolve();
  await signIn;
  expect(notices.information.join(' ')).toMatch(/connected/i);
  expect(exchanged).toBe(1);
});

it('keeps recovery commands available after startup storage failure and retries only on explicit use', async () => {
  const secrets = new MemorySecrets();
  secrets.external('lunaroute.connection', JSON.stringify({ apiKey: 'lr_fixture_not_real',
    orgId: '00000000-0000-4000-8000-000000000001' }));
  vi.spyOn(secrets, 'get').mockRejectedValueOnce(new Error('private keychain diagnostic'));
  await activate(context(secrets));
  expect(commandHandlers.has('lunaroute.manage')).toBe(true);
  expect(notices.errors.join(' ')).not.toContain('private');
  expect(env.openExternal).not.toHaveBeenCalled();
  notices.errors.length = 0;
  await commands.executeCommand('lunaroute.signOut');
  expect(await secrets.get('lunaroute.connection')).toBeUndefined();
  expect(notices.errors).toEqual([]);
  expect(notices.information.join(' ')).toMatch(/locally/);
});

it('reports incomplete sign-out instead of claiming success', async () => {
  const secrets = new MemorySecrets();
  secrets.failDelete = true;
  await activate(context(secrets));
  await commands.executeCommand('lunaroute.signOut');
  expect(notices.information).toEqual([]);
  expect(notices.errors.join(' ')).toMatch(/secure|credential/i);
});

it('opens management only on explicit choice and removes its commands on deactivation', async () => {
  await activate(context());
  notices.nextPick = 'Open dashboard';
  env.openExternal.mockResolvedValue(true);
  await commands.executeCommand('lunaroute.manage');
  expect(env.openExternal).toHaveBeenCalledTimes(1);
  expect(env.openExternal.mock.calls[0][0].toString()).toBe('https://app.lunaroute.com/dashboard');
  deactivate();
  expect(commandHandlers.size).toBe(0);
  expect(registeredProviders.size).toBe(0);
});

it('refreshes a saved connection silently, exposes refresh management and leaves user preferences alone', async () => {
  const secrets = new MemorySecrets();
  secrets.external('lunaroute.connection', JSON.stringify({ apiKey: 'lr_fixture_not_real', orgId: '00000000-0000-4000-8000-000000000001' }));
  preferences.set('chat.models.default', 'user/chosen');
  preferences.set('chat.utilityModel', 'user/utility');
  const requests: string[] = [];
  vi.stubGlobal('fetch', async (url: string, options: RequestInit) => {
    requests.push(url.toString());
    expect(new Headers(options.headers).get('authorization')).toBe('Bearer lr_fixture_not_real');
    return new Response(JSON.stringify({ data: [{ id: 'chat-a', context_window: 131072, max_output_tokens: 8192 }] }));
  });
  await activate(context(secrets));
  const provider = registeredProviders.get('lunaroute');
  expect(provider).toBeDefined();
  const info = await provider!.provideLanguageModelChatInformation({ silent: true }, new CancellationTokenSource().token);
  expect(info?.map(model => model.id)).toEqual(['chat-a']);
  expect(requests).toEqual(['https://gw.lunaroute.com/v1/models']);
  expect(notices.errors).toEqual([]);
  expect(notices.information).toEqual([]);
  expect(env.openExternal).not.toHaveBeenCalled();
  await commands.executeCommand('lunaroute.manage');
  expect(notices.picks.at(-1)?.items.map(item => item.label)).toContain('Refresh Models');
  await commands.executeCommand('lunaroute.refreshModels');
  expect(requests).toHaveLength(2);
  expect([...preferences]).toEqual([['chat.models.default', 'user/chosen'], ['chat.utilityModel', 'user/utility']]);
});

it('puts catalog errors in management and explicit actions instead of startup dialogs or fake models', async () => {
  const secrets = new MemorySecrets();
  secrets.external('lunaroute.connection', JSON.stringify({ apiKey: 'lr_fixture_not_real', orgId: '00000000-0000-4000-8000-000000000001' }));
  vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ error: 'private diagnostic' }), { status: 429, headers: { 'Retry-After': '13' } }));
  await activate(context(secrets));
  const provider = registeredProviders.get('lunaroute');
  expect(provider).toBeDefined();
  expect(await provider!.provideLanguageModelChatInformation({ silent: true }, new CancellationTokenSource().token)).toEqual([]);
  expect(notices.errors).toEqual([]);
  await commands.executeCommand('lunaroute.manage');
  expect(notices.picks.at(-1)?.options).toMatchObject({ placeHolder: expect.stringMatching(/rate limit/i) });
  expect(notices.picks.at(-1)?.items.map(item => item.label)).toEqual(expect.arrayContaining(['Open dashboard', 'Refresh Models', 'Change connection']));
  await commands.executeCommand('lunaroute.refreshModels');
  expect(notices.errors.join(' ')).toMatch(/rate limit/i);
  expect(JSON.stringify(notices)).not.toContain('private diagnostic');
});

it('keeps sign-out usable when native provider registration fails', async () => {
  const secrets = new MemorySecrets();
  secrets.external('lunaroute.connection', JSON.stringify({ apiKey: 'lr_fixture_not_real', orgId: '00000000-0000-4000-8000-000000000001' }));
  vi.spyOn(lm, 'registerLanguageModelChatProvider').mockImplementationOnce(() => { throw new Error('private policy diagnostic'); });
  await activate(context(secrets));
  expect(notices.errors).toEqual([]);
  await commands.executeCommand('lunaroute.manage');
  expect(notices.picks.at(-1)?.options).toMatchObject({ placeHolder: expect.stringMatching(/permission|policy/i) });
  await commands.executeCommand('lunaroute.signOut');
  expect(await secrets.get('lunaroute.connection')).toBeUndefined();
  expect(notices.information.join(' ')).toMatch(/locally/);
  expect(JSON.stringify(notices)).not.toContain('private policy diagnostic');
});

it('keeps startup storage guidance in management without a repeated startup popup', async () => {
  const secrets = new MemorySecrets();
  vi.spyOn(secrets, 'get').mockRejectedValueOnce(new Error('private storage diagnostic'));
  await activate(context(secrets));
  expect(notices.errors).toEqual([]);
  await commands.executeCommand('lunaroute.manage');
  expect(notices.picks.at(-1)?.options).toMatchObject({ placeHolder: expect.stringMatching(/secure|credential/i) });
  expect(notices.picks.at(-1)?.items.map(item => item.label)).toContain('Sign In');
});
