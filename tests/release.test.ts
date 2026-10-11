import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const checker = fileURLToPath(new URL('./check-release-tag.mjs', import.meta.url));

it.each([
  { version: '0.1.0', tag: 'v0.1.0', status: 0 },
  { version: '2.3.4', tag: 'v2.3.4', status: 0 },
  { version: '0.1.0', tag: 'v0.1.1', status: 1 },
  { version: '0.1.0', tag: '0.1.0', status: 1 },
  { version: '0.1.0', tag: undefined, status: 1 },
  { version: '0.1.0', tag: 'v0.1.0-extra', status: 1 },
  { version: 1, tag: 'v1', status: 1 },
  { version: '', tag: 'v', status: 1 },
  { version: undefined, tag: 'vundefined', status: 1 },
])('release gate: version=$version tag=$tag exits $status', ({ version, tag, status }) => {
  const cwd = mkdtempSync(join(tmpdir(), 'lunaroute-release-'));
  try {
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ version }));
    const result = spawnSync(process.execPath, [checker, ...(tag === undefined ? [] : [tag])], {
      cwd, encoding: 'utf8',
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(status);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
