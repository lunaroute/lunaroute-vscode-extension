import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { createAuthController, type AuthController } from './auth.js';
import { FRONT_URL, LunaRouteError, userMessage, type Attribution } from './lunaroute.js';

let generation = 0;
let runtime: { disposable: vscode.Disposable; attribution: Attribution } | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  deactivate();
  const current = generation;
  if (vscode.env.uiKind !== vscode.UIKind.Desktop || context.extension.extensionKind !== vscode.ExtensionKind.UI) {
    await vscode.window.showErrorMessage('LunaRoute requires the local desktop extension host. Install it locally, not in the remote workspace.');
    return;
  }
  const resources: vscode.Disposable[] = [];
  let closed = false;
  const live = () => !closed && current === generation;
  const attribution = { version: context.extension.packageJSON.version as string, sessionId: randomUUID() };
  runtime = { attribution, disposable: new vscode.Disposable(() => {
    closed = true;
    resources.forEach(resource => resource.dispose());
  }) };
  context.subscriptions.push(runtime.disposable);
  const openExternal = async (url: string) => vscode.env.openExternal(vscode.Uri.parse(url));
  let auth: AuthController | undefined;
  let loading: Promise<AuthController> | undefined;
  async function getAuth(): Promise<AuthController> {
    if (!live()) throw new LunaRouteError('cancelled');
    if (auth) return auth;
    loading ??= createAuthController(context.secrets, openExternal).then(created => {
      if (!live()) { created.dispose(); throw new LunaRouteError('cancelled'); }
      auth = created;
      resources.push(created);
      return created;
    }).finally(() => { loading = undefined; });
    return loading;
  }
  async function run(action: () => PromiseLike<unknown>, success?: string) {
    if (!live()) return;
    try {
      await action();
      if (success && live()) await vscode.window.showInformationMessage(success);
    } catch (error) {
      if (!live()) return;
      if (error instanceof LunaRouteError && error.kind === 'cancelled') {
        await vscode.window.showInformationMessage('LunaRoute operation cancelled. Check LunaRoute: Manage; revoke any unused key in the dashboard.');
      } else await vscode.window.showErrorMessage(userMessage(error));
    }
  }
  resources.push(
    vscode.commands.registerCommand('lunaroute.signIn', () => run(
      () => vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'LunaRoute: Sign In', cancellable: true },
        async (_progress, token) => (await getAuth()).signIn(token)),
      'Connected to LunaRoute. Choose a LunaRoute model in the native Chat picker.',
    )),
    vscode.commands.registerCommand('lunaroute.signOut', () => run(
      async () => (await getAuth()).signOut(),
      'Saved LunaRoute connection removed locally. The key remains active until revoked in the dashboard.',
    )),
    vscode.commands.registerCommand('lunaroute.manage', () => run(async () => {
      const connection = auth?.snapshot().connection;
      const choices = [
        { label: 'Open dashboard', id: 'dashboard' },
        { label: connection ? 'Change connection' : 'Sign In', id: 'lunaroute.signIn' },
        ...(connection ? [{ label: 'Sign Out (local only)', id: 'lunaroute.signOut' }] : []),
      ];
      const choice = await vscode.window.showQuickPick(choices, {
        title: 'LunaRoute',
        placeHolder: connection ? `Organization: ${connection.orgId}. Revoke keys in the dashboard.` : 'Not signed in',
      });
      if (!choice || !live()) return;
      if (choice.id === 'dashboard') {
        if (!await openExternal(`${FRONT_URL}/dashboard`)) throw new LunaRouteError('network');
      } else await vscode.commands.executeCommand(choice.id);
    })),
  );
  try { await getAuth(); }
  catch (error) { if (live()) await vscode.window.showErrorMessage(userMessage(error)); }
}

export function deactivate(): void {
  generation++;
  runtime?.disposable.dispose();
  runtime = undefined;
}
