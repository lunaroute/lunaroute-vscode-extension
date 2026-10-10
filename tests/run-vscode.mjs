import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { runTests, runVSCodeCommand } from '@vscode/test-electron';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = path.join(root, 'tests/host-fixture');
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--vsix')) throw new Error('Usage: node tests/run-vscode.mjs [--vsix path]');
const vsix = args[1] && path.resolve(args[1]);
const temporary = await mkdtemp(path.join(tmpdir(), 'lunaroute-vscode-host-'));
try {
  for (const directory of ['user/User', 'extensions', 'workspace']) await mkdir(path.join(temporary, directory), { recursive: true });
  await writeFile(path.join(temporary, 'user/User/settings.json'), JSON.stringify({
    'telemetry.telemetryLevel': 'off', 'update.mode': 'none', 'extensions.autoUpdate': false, 'workbench.startupEditor': 'none',
  }));
  await Promise.all([
    build({ entryPoints: [path.join(fixture, 'extension.ts')], outfile: path.join(fixture, 'dist/extension.cjs'), bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['vscode'] }),
    build({ entryPoints: [path.join(root, 'tests/host/index.ts')], outfile: path.join(fixture, 'dist/host.cjs'), bundle: true, platform: 'node', target: 'node22', format: 'cjs', external: ['vscode'] }),
  ]);
  if (vsix) {
    const installed = await runVSCodeCommand(['--install-extension', vsix, '--user-data-dir', path.join(temporary, 'user'),
      '--extensions-dir', path.join(temporary, 'extensions'), '--no-sandbox'], { version: '1.141.0', reuseMachineInstall: false });
    console.log(installed.stdout);
  }
  await runTests({
    version: '1.141.0', reuseMachineInstall: false, extensionDevelopmentPath: vsix ? [fixture] : [root, fixture],
    extensionTestsEnv: { LR_PACKAGED_ROOT: vsix ? path.join(temporary, 'extensions') : undefined },
    extensionTestsPath: path.join(fixture, 'dist/host.cjs'),
    launchArgs: [path.join(temporary, 'workspace'), '--user-data-dir', path.join(temporary, 'user'),
      '--extensions-dir', path.join(temporary, 'extensions'), ...(vsix ? [] : ['--disable-extensions']), '--skip-welcome',
      '--skip-release-notes', '--disable-workspace-trust', '--disable-updates', '--no-sandbox', '--disable-gpu'],
  });
} finally { await rm(temporary, { recursive: true, force: true }); }
