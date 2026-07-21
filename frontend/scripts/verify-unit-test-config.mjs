import { readFile } from 'node:fs/promises';
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const requiredScripts = ['test', 'test:run', 'test:coverage'];
const failures = requiredScripts
  .filter((name) => !pkg.scripts?.[name])
  .map((name) => `missing script ${name}`);
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('Unit test config verified');
