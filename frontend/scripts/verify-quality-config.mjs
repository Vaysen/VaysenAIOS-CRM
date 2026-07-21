import { readFile } from 'node:fs/promises';

const frontend = JSON.parse(await readFile('package.json', 'utf8'));
const tsconfig = JSON.parse(await readFile('tsconfig.json', 'utf8'));
const nvmVersion = (await readFile('.nvmrc', 'utf8')).trim();
const nodeVersion = (await readFile('.node-version', 'utf8')).trim();
const requiredScripts = [
  'format',
  'format:check',
  'typecheck',
  'lint',
  'lint:styles',
  'quality:check',
];
const failures = requiredScripts
  .filter((name) => !frontend.scripts?.[name])
  .map((name) => `missing script ${name}`);
if (tsconfig.compilerOptions?.strict !== true) failures.push('strict must be true');
if (nvmVersion !== '20') failures.push('.nvmrc must pin Node 20');
if (nodeVersion !== '20.18.0') {
  failures.push('.node-version must match workspace Node 20.18.0');
}
if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log('Frontend quality config verified');
