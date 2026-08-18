import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const prismaCli = path.join(root, 'node_modules', 'prisma', 'build', 'index.js');
const schema = path.join(root, 'backend', 'prisma', 'schema.prisma');
const result = spawnSync(
  process.execPath,
  [
    prismaCli,
    'migrate',
    'diff',
    '--from-empty',
    '--to-schema-datamodel',
    schema,
    '--exit-code',
  ],
  {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  },
);

if (result.status !== 2) {
  throw new Error(
    `Prisma drift exit-code contract failed: expected 2 for intentional drift, got ${result.status}\n${result.stderr || result.stdout}`,
  );
}

console.log('[prisma-drift-contract] PASS: intentional drift returns exit code 2');
