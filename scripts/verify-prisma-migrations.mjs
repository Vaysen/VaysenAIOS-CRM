import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const prismaDirectory = path.join(root, 'backend', 'prisma');
const migrationsDirectory = path.join(prismaDirectory, 'migrations');
const schema = readFileSync(path.join(prismaDirectory, 'schema.prisma'), 'utf8');
const lock = readFileSync(path.join(migrationsDirectory, 'migration_lock.toml'), 'utf8');

if (!/provider\s*=\s*"postgresql"/.test(schema)) {
  throw new Error('Prisma schema datasource must remain PostgreSQL');
}
if (!/provider\s*=\s*"postgresql"/.test(lock)) {
  throw new Error('Prisma migration lock provider does not match the schema');
}

const directories = readdirSync(migrationsDirectory)
  .filter((name) => statSync(path.join(migrationsDirectory, name)).isDirectory())
  .sort();
if (!directories.length) throw new Error('No Prisma migrations found');
if (new Set(directories).size !== directories.length) throw new Error('Duplicate Prisma migration directory');
const expectedCount = Number(process.env.EXPECTED_PRISMA_MIGRATIONS || 37);
if (!Number.isSafeInteger(expectedCount) || expectedCount < 1 || directories.length !== expectedCount) {
  throw new Error(`Expected ${expectedCount} Prisma migrations, found ${directories.length}`);
}
if (directories[0] !== '20260530120000_init') {
  throw new Error(`Unexpected first Prisma migration: ${directories[0]}`);
}
const expectedLatest = process.env.EXPECTED_LATEST_PRISMA_MIGRATION
  || '20260809110000_add_customer_fact_runtime';
if (directories.at(-1) !== expectedLatest) {
  throw new Error(`Unexpected latest Prisma migration: ${directories.at(-1)}`);
}

for (const directory of directories) {
  if (!/^\d{14}_[a-z0-9_]+$/.test(directory)) {
    throw new Error(`Invalid Prisma migration directory: ${directory}`);
  }
  const sqlPath = path.join(migrationsDirectory, directory, 'migration.sql');
  const sql = readFileSync(sqlPath, 'utf8').trim();
  if (!sql || /\b(?:TODO|PLACEHOLDER)\b/i.test(sql)) {
    throw new Error(`Empty or placeholder Prisma migration: ${directory}`);
  }
}

console.log(
  `[prisma-migrations] validated ${directories.length} ordered PostgreSQL migrations through ${expectedLatest}`,
);
