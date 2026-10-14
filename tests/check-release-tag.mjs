import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
if (typeof version !== 'string' || !version || process.argv[2] !== `v${version}`) {
  console.error('Release tag must be v<package.json version>.');
  process.exit(1);
}
console.log('Release tag matches package.json.');
