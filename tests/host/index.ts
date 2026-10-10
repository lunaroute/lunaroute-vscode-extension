import assert from 'node:assert/strict';
import path from 'node:path';
import * as vscode from 'vscode';
import type { ProbeAPI } from '../host-fixture/extension.js';

const user = vscode.LanguageModelChatMessage.User;
const assistant = vscode.LanguageModelChatMessage.Assistant;
const text = (value: string) => new vscode.LanguageModelTextPart(value);
const tools = [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object' } }];
const mime = 'application/vnd.lunaroute.responses-replay+json';
async function collect(response: vscode.LanguageModelChatResponse) {
  const parts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart | vscode.LanguageModelDataPart)[] = [];
  for await (const part of response.stream) {
    assert.ok(part instanceof vscode.LanguageModelTextPart || part instanceof vscode.LanguageModelToolCallPart || part instanceof vscode.LanguageModelDataPart, 'Unexpected native response part');
    parts.push(part);
  }
  return parts;
}
async function commandAndDismiss(name: string) {
  // Notifications/quick-picks have no public lifecycle event; drive their public close commands until this command settles.
  const timer = setInterval(() => {
    void vscode.commands.executeCommand('notifications.clearAll').then(undefined, () => {});
    void vscode.commands.executeCommand('workbench.action.closeQuickOpen').then(undefined, () => {});
  }, 50);
  let deadline: NodeJS.Timeout | undefined;
  try {
    await Promise.race([vscode.commands.executeCommand(name),
      new Promise<never>((_resolve, reject) => { deadline = setTimeout(() => reject(new Error('Signed-out command did not settle: ' + name)), 10_000); })]);
  } finally { clearInterval(timer); clearTimeout(deadline); }
}
export async function run(): Promise<void> {
  console.log('Direct public-API host contract checks; VS Code ' + vscode.version + ' on ' + process.platform);
  assert.equal(vscode.version, '1.141.0');
  const product = vscode.extensions.getExtension('lunaroute.lunaroute');
  assert.ok(product, 'Product extension is installed');
  if (process.env.LR_PACKAGED_ROOT) {
    const relative = path.relative(process.env.LR_PACKAGED_ROOT, product.extensionPath);
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Product is loaded from the disposable VSIX installation, not development sources');
  }
  assert.equal(await product.activate(), undefined, 'Product must not export a credential/test API');
  assert.equal(product.extensionKind, vscode.ExtensionKind.UI);
  assert.deepEqual(await vscode.lm.selectChatModels({ vendor: 'lunaroute' }), []);
  const commands = await vscode.commands.getCommands(true);
  for (const id of ['lunaroute.signIn', 'lunaroute.signOut', 'lunaroute.manage', 'lunaroute.refreshModels']) assert.ok(commands.includes(id), id);
  for (const id of ['lunaroute.signOut', 'lunaroute.refreshModels', 'lunaroute.manage']) await commandAndDismiss(id);
  assert.deepEqual(await vscode.lm.selectChatModels({ vendor: 'lunaroute' }), []);
  console.log('PASS product signed-out activation/commands, local placement, no credential-bearing exports');

  const fixture = vscode.extensions.getExtension<ProbeAPI>('lunaroute-test.lunaroute-host-fixture');
  assert.ok(fixture);
  const probe = await fixture.activate();
  try {
    assert.deepEqual(await vscode.lm.selectChatModels({ vendor: 'lunaroute-probe' }), []);
    await probe.connect();
    assert.ok(probe.secretChanges > 0, 'Actual SecretStorage emits a change after sign-in');
    const [model] = await vscode.lm.selectChatModels({ vendor: 'lunaroute-probe' });
    assert.ok(model, 'The registered probe model is selectable');
    assert.equal(model.id, 'probe-chat');
    assert.equal(await model.countTokens('猫'), 3);
    let parts = await collect(await model.sendRequest([user('hello')]));
    assert.ok(parts.every(part => part instanceof vscode.LanguageModelTextPart));
    assert.equal(parts.map(part => (part as vscode.LanguageModelTextPart).value).join(''), 'hello');
    assert.equal(probe.requests.at(-1)!.body.store, false);
    assert.equal(probe.requests.at(-1)!.headers['lunaroute-agent'], 'vscode/0.1.0');
    console.log('PASS actual classes, PKCE/SecretStorage, discovery, SDK text stream and token count');

    probe.scenario('tools');
    const calls = await collect(await model.sendRequest([user('Read two files')], { tools, toolMode: vscode.LanguageModelChatToolMode.Required }));
    assert.ok(calls.every(part => part instanceof vscode.LanguageModelToolCallPart));
    assert.deepEqual(calls.map(part => (part as vscode.LanguageModelToolCallPart).callId), ['call-0', 'call-1']);
    probe.scenario('text');
    await collect(await model.sendRequest([user('Read two files'), assistant(calls), user([
      new vscode.LanguageModelToolResultPart('call-0', [text('file A')]),
      new vscode.LanguageModelToolResultPart('call-1', [text('file B')]),
    ])], { tools }));
    const toolInput = probe.requests.at(-1)!.body.input as { type?: string; call_id?: string; output?: string }[];
    assert.deepEqual(toolInput.filter(item => item.type === 'function_call_output').map(item => [item.call_id, item.output]), [['call-0', 'file A'], ['call-1', 'file B']]);
    console.log('PASS multiple tool calls and caller-supplied tool results (no native Agent/tool execution claim)');

    const png = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlfoAAAAASUVORK5CYII=', 'base64'));
    await collect(await model.sendRequest([user([text('image fixture'), vscode.LanguageModelDataPart.image(png, 'image/png')])]));
    const imageInput = probe.requests.at(-1)!.body.input as { content: { type: string; image_url?: string }[] }[];
    assert.equal(imageInput[0].content[1].image_url, 'data:image/png;base64,' + Buffer.from(png).toString('base64'));
    probe.scenario('replay');
    parts = await collect(await model.sendRequest([user('reasoning fixture')]));
    assert.ok(parts[0] instanceof vscode.LanguageModelDataPart, 'Opaque response data survives the actual host');
    assert.equal((parts[0] as vscode.LanguageModelDataPart).mimeType, mime);
    probe.scenario('text');
    await collect(await model.sendRequest([user('reasoning fixture'), assistant(parts), user('continue')]));
    const replayInput = probe.requests.at(-1)!.body.input as { type?: string; encrypted_content?: string }[];
    assert.ok(replayInput.some(item => item.type === 'reasoning' && item.encrypted_content === 'opaque-fixture'));
    console.log('PASS image and opaque replay in direct public-API history; native Chat/Agent retention remains separate');

    for (const reason of ['caller', 'replacement'] as const) {
      probe.scenario('hold');
      const source = new vscode.CancellationTokenSource();
      const response = await model.sendRequest([user('cancel fixture')], {}, source.token);
      const iterator = response.stream[Symbol.asyncIterator]();
      assert.equal((await iterator.next()).done, false);
      const closedBefore = probe.closedResponses;
      if (reason === 'caller') source.cancel();
      else await probe.replace();
      const late: unknown[] = [];
      let streamError: unknown;
      try {
        for (let next = await iterator.next(); !next.done; next = await iterator.next()) late.push(next.value);
      } catch (error) { streamError = error; }
      finally { source.dispose(); }
      assert.deepEqual(late, [], 'No progress after cancellation');
      if (streamError !== undefined) {
        assert.ok(streamError instanceof Error);
        assert.match(streamError.message, /cancel/i);
      }
      await probe.waitForClosed(closedBefore);
    }
    console.log('PASS actual caller cancellation and SecretStorage replacement abort the HTTP response');

    let modelEvents = 0;
    const subscription = vscode.lm.onDidChangeChatModels(() => { modelEvents++; });
    try {
      await probe.addModel();
      assert.equal((await vscode.lm.selectChatModels({ vendor: 'lunaroute-probe' })).length, 2);
      await probe.signOut();
      assert.deepEqual(await vscode.lm.selectChatModels({ vendor: 'lunaroute-probe' }), []);
      assert.ok(modelEvents > 0, 'The host reports model changes');
    } finally { subscription.dispose(); }
    console.log('PASS catalog refresh and sign-out remove/select models through the real broker');
  } finally { await probe.dispose(); }
}
