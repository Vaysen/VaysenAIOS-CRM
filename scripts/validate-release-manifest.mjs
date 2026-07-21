#!/usr/bin/env node
// Dependency-free validator for the JSON Schema keywords used by the bundled
// release-manifest.schema.json. It is intentionally fail-closed on unsupported
// schema keywords that would affect validation semantics.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.dirname(scriptDir);
const schemaPath = path.join(projectDir, 'docs/release/release-manifest.schema.json');
let manifestPath = path.join(projectDir, 'release-manifest.json');
let docsRoot = projectDir;
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--manifest' && args[index + 1]) {
    manifestPath = path.resolve(args[index + 1]);
    index += 1;
  } else if (args[index] === '--docs-root' && args[index + 1]) {
    docsRoot = path.resolve(args[index + 1]);
    index += 1;
  } else {
    console.error(`Usage: ${path.basename(process.argv[1])} [--manifest <path>] [--docs-root <dir>]`);
    process.exit(2);
  }
}

const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const errors = [];

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasExactToken(value, token) {
  if (typeof value !== 'string') return false;
  return new RegExp(`(?:^|[^A-Za-z0-9._-])${escapeRegExp(token)}(?![A-Za-z0-9._-])`).test(value);
}

const supportedKeywords = new Set([
  '$schema', '$id', '$ref', 'title', 'description', 'type', 'required',
  'properties', 'definitions', 'items', 'enum', 'pattern', 'minimum',
  'format', 'additionalProperties',
]);

function assertSupportedSchema(rule, location = '$schema') {
  for (const key of Object.keys(rule)) {
    if (!supportedKeywords.has(key)) {
      throw new Error(`${location}: unsupported schema keyword ${key}`);
    }
  }
  if (rule.format && rule.format !== 'uri-reference') {
    throw new Error(`${location}: unsupported schema format ${rule.format}`);
  }
  if (Object.hasOwn(rule, 'additionalProperties') && rule.additionalProperties !== false) {
    throw new Error(`${location}: only additionalProperties=false is supported`);
  }
  for (const [key, child] of Object.entries(rule.properties ?? {})) {
    assertSupportedSchema(child, `${location}.properties.${key}`);
  }
  for (const [key, child] of Object.entries(rule.definitions ?? {})) {
    assertSupportedSchema(child, `${location}.definitions.${key}`);
  }
  if (rule.items) assertSupportedSchema(rule.items, `${location}.items`);
}

function resolveRef(ref) {
  if (!ref.startsWith('#/')) throw new Error(`unsupported external $ref: ${ref}`);
  return ref.slice(2).split('/').reduce((value, key) => value?.[key.replaceAll('~1', '/').replaceAll('~0', '~')], schema);
}

function actualType(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function validate(value, rule, location) {
  if (rule.$ref) return validate(value, resolveRef(rule.$ref), location);
  if (rule.type) {
    const type = actualType(value);
    if (type !== rule.type && !(rule.type === 'number' && type === 'integer')) {
      errors.push(`${location}: expected ${rule.type}, got ${type}`);
      return;
    }
  }
  if (rule.enum && !rule.enum.includes(value)) errors.push(`${location}: not in enum`);
  if (rule.pattern && typeof value === 'string' && !(new RegExp(rule.pattern)).test(value)) {
    errors.push(`${location}: does not match ${rule.pattern}`);
  }
  if (rule.format === 'uri-reference' && typeof value === 'string') {
    try {
      new URL(value, 'https://manifest.invalid/');
    } catch {
      errors.push(`${location}: invalid uri-reference`);
    }
  }
  if (rule.minimum !== undefined && typeof value === 'number' && value < rule.minimum) {
    errors.push(`${location}: below minimum ${rule.minimum}`);
  }
  if (rule.required && value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of rule.required) {
      if (!Object.hasOwn(value, key)) errors.push(`${location}: missing required property ${key}`);
    }
  }
  if (rule.properties && value && typeof value === 'object' && !Array.isArray(value)) {
    if (rule.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(rule.properties, key)) {
          errors.push(`${location}: unexpected property ${key}`);
        }
      }
    }
    for (const [key, childRule] of Object.entries(rule.properties)) {
      if (Object.hasOwn(value, key)) validate(value[key], childRule, `${location}.${key}`);
    }
  }
  if (rule.items && Array.isArray(value)) {
    value.forEach((item, index) => validate(item, rule.items, `${location}[${index}]`));
  }
}

assertSupportedSchema(schema);
validate(manifest, schema, '$');

const migrationsDir = path.join(projectDir, 'backend', 'prisma', 'migrations');
let sourceMigrations = [];
try {
  const migrationLock = fs.lstatSync(path.join(migrationsDir, 'migration_lock.toml'), { throwIfNoEntry: false });
  if (!migrationLock?.isFile() || migrationLock.isSymbolicLink()) {
    errors.push('backend/prisma/migrations/migration_lock.toml: must be a regular non-symlink file');
  }
  sourceMigrations = fs.readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, 'en'));
  for (const migration of sourceMigrations) {
    if (!/^[0-9]{14}_[a-z0-9_]+$/.test(migration)) {
      errors.push(`backend/prisma/migrations/${migration}: invalid migration directory name`);
    }
    const sqlPath = path.join(migrationsDir, migration, 'migration.sql');
    const sqlStat = fs.lstatSync(sqlPath, { throwIfNoEntry: false });
    if (!sqlStat?.isFile() || sqlStat.isSymbolicLink()) {
      errors.push(`backend/prisma/migrations/${migration}: migration.sql must be a regular non-symlink file`);
    }
  }
} catch (error) {
  errors.push(`backend/prisma/migrations: unreadable source migration tree (${error.message})`);
}

const manifestMigrations = manifest?.database?.migrations;
if (Array.isArray(manifestMigrations)) {
  const uniqueMigrations = new Set(manifestMigrations);
  if (uniqueMigrations.size !== manifestMigrations.length) {
    errors.push('$.database.migrations: duplicate migration names are forbidden');
  }
  const sortedMigrations = [...manifestMigrations].sort((left, right) => left.localeCompare(right, 'en'));
  if (JSON.stringify(sortedMigrations) !== JSON.stringify(manifestMigrations)) {
    errors.push('$.database.migrations: migration names must be sorted');
  }
  if (JSON.stringify(sourceMigrations) !== JSON.stringify(manifestMigrations)) {
    errors.push('$.database.migrations: must exactly match the source Prisma migration tree');
  }
  if (manifest?.database?.migrationsCount !== manifestMigrations.length) {
    errors.push('$.database.migrationsCount: must equal database.migrations.length');
  }
  const latestMigration = manifestMigrations.at(-1) ?? '';
  if (manifest?.database?.latestMigration !== latestMigration) {
    errors.push('$.database.latestMigration: must equal the last sorted migration');
  }
}

const releaseTag = manifest?.source?.releaseTag;
const releaseTagMatch = typeof releaseTag === 'string'
  ? releaseTag.match(/^vaysen-crm-lan(?:-source)?-v(\d+\.\d+\.\d+)-r(\d+)$/)
  : null;
if (!releaseTagMatch) {
  errors.push('$.source.releaseTag: must use vaysen-crm-lan[-source]-v<version>-r<revision>');
} else {
  const [, version, revision] = releaseTagMatch;
  const expectedTaskSuffix = `v${version}-R${revision}`;
  const expectedSourceTag = `vaysen-crm-lan-source-v${version}-r${revision}`;
  const expectedLinuxTag = `vaysen-crm-lan-v${version}-r${revision}`;
  const buildExample = manifest?.dockerImages?.buildExample;
  const releaseTagAssignments = typeof buildExample === 'string'
    ? [...buildExample.matchAll(/(?:^|\s)RELEASE_TAG=([^\s]+)/g)].map((match) => match[1])
    : [];
  const taskPattern = new RegExp(`^TASK-[A-Z0-9]+(?:-[A-Z0-9]+)*-${escapeRegExp(expectedTaskSuffix)}$`);
  if (typeof manifest?.task !== 'string' || !taskPattern.test(manifest.task)) {
    errors.push(`$.task: must be an anchored TASK identifier ending in ${expectedTaskSuffix}`);
  }
  if (releaseTagAssignments.length !== 1 || releaseTagAssignments[0] !== expectedLinuxTag) {
    errors.push(`$.dockerImages.buildExample: RELEASE_TAG must equal ${expectedLinuxTag}`);
  }
  const revisionCommands = typeof manifest?.source?.buildRevisionNote === 'string'
    ? [...manifest.source.buildRevisionNote.matchAll(/git rev-parse\s+([^\s)；;]+)/g)].map((match) => match[1])
    : [];
  if (revisionCommands.length !== 1 || revisionCommands[0] !== `${releaseTag}^{}`) {
    errors.push('$.source.buildRevisionNote: must contain exactly one git rev-parse for source.releaseTag^{}');
  }
  const releaseTagNote = manifest?.source?.releaseTagNote;
  if (!hasExactToken(releaseTagNote, expectedLinuxTag)) {
    errors.push(`$.source.releaseTagNote: must name the matching Linux tag ${expectedLinuxTag}`);
  }
  if (releaseTag === expectedSourceTag && !hasExactToken(releaseTagNote, expectedSourceTag)) {
    errors.push(`$.source.releaseTagNote: source manifest must name its exact source tag ${expectedSourceTag}`);
  }

  const currentRevisionToken = `R${revision}`;
  for (const [location, value] of [
    ['$.note', manifest?.note],
    ['$.database.note', manifest?.database?.note],
    ['$.gate.note', manifest?.gate?.note],
  ]) {
    if (!hasExactToken(value, currentRevisionToken)) {
      errors.push(`${location}: must identify the current release revision ${currentRevisionToken}`);
    }
    if (typeof value === 'string') {
      for (const match of value.matchAll(/(?:^|[^A-Za-z0-9])R(\d+)\s*正式切换/g)) {
        if (match[1] !== revision) {
          errors.push(`${location}: contains a stale formal-cutover instruction for R${match[1]}`);
        }
      }
    }
  }
  if (!hasExactToken(manifest?.gate?.note, expectedLinuxTag)) {
    errors.push(`$.gate.note: must name the current immutable Linux release tag ${expectedLinuxTag}`);
  }

  const currentDocPaths = [
    'docs/LINUX_DEPLOYMENT.md',
    'docs/TASK-116B-v1.4.20-OpenClaw微信发布验收.md',
  ];
  const blockStart = '<!-- TASK-116B CURRENT RELEASE START -->';
  const blockEnd = '<!-- TASK-116B CURRENT RELEASE END -->';
  for (const relativePath of currentDocPaths) {
    const absolutePath = path.join(docsRoot, relativePath);
    let document;
    try {
      document = fs.readFileSync(absolutePath, 'utf8');
    } catch {
      errors.push(`${relativePath}: current-release documentation is missing or unreadable`);
      continue;
    }
    const startCount = document.split(blockStart).length - 1;
    const endCount = document.split(blockEnd).length - 1;
    if (startCount !== 1 || endCount !== 1) {
      errors.push(`${relativePath}: must contain exactly one structured current-release block`);
      continue;
    }
    const startIndex = document.indexOf(blockStart) + blockStart.length;
    const endIndex = document.indexOf(blockEnd, startIndex);
    if (endIndex < startIndex) {
      errors.push(`${relativePath}: current-release block markers are out of order`);
      continue;
    }
    const currentBlock = document.slice(startIndex, endIndex);
    if (!hasExactToken(currentBlock, expectedLinuxTag)) {
      errors.push(`${relativePath}: current-release block must name ${expectedLinuxTag}`);
    }
    if (relativePath.includes('TASK-116B') && !hasExactToken(currentBlock, expectedSourceTag)) {
      errors.push(`${relativePath}: current-release block must name ${expectedSourceTag}`);
    }
    const sameVersionTag = new RegExp(
      `vaysen-crm-lan(?:-source)?-v${escapeRegExp(version)}-r(\\d+)`,
      'g',
    );
    for (const match of currentBlock.matchAll(sameVersionTag)) {
      if (match[1] !== revision) {
        errors.push(`${relativePath}: current-release block contains stale immutable revision r${match[1]}`);
      }
    }
    const sameVersionBranch = new RegExp(`release/v${escapeRegExp(version)}-r(\\d+)`, 'g');
    for (const match of currentBlock.matchAll(sameVersionBranch)) {
      if (match[1] !== revision) {
        errors.push(`${relativePath}: current-release block contains stale branch revision r${match[1]}`);
      }
    }
    if (!/OPENCLAW_E2E_REQUIRE_WECHAT_BOUND=false/.test(currentBlock)
      || !/OPENCLAW_E2E_REQUIRE_WECHAT_BOUND=true/.test(currentBlock)) {
      errors.push(`${relativePath}: current-release block must separate scan-ready and physically-bound E2E gates`);
    }
  }
}
if (errors.length) {
  errors.forEach((error) => console.error(`[manifest ERROR] ${error}`));
  process.exit(1);
}
console.log('[manifest OK] release-manifest.json satisfies bundled schema and release-tag semantics');
