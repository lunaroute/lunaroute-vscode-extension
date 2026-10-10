import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { vscode: fileURLToPath(new URL('./tests/vscode.ts', import.meta.url)) } },
  test: { include: ['tests/*.test.ts'], restoreMocks: true },
});
