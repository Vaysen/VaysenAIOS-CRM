#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const MINIMUM_NODE_MAJOR = 22;
const INSTALL_INDEX_KEY = 'installed-plugin-index';
const CONTAINER_STATE_ROOT = '/home/node/.openclaw';
const LINK_TARGET = '/app';
const REVIEWED_TRANSIENT_LINK = Object.freeze({
  relativePath: 'openclaw/plugin-skills/browser-automation',
  stateRelativePath: 'plugin-skills/browser-automation',
  target: '/app/dist/extensions/browser/skills/browser-automation',
});

const PLUGINS = Object.freeze([
  Object.freeze({
    pluginId: 'vaysen-crm',
    packageName: '@vaysen/openclaw-crm-tools',
    versions: Object.freeze(['1.0.0', '1.1.0', '1.2.0', '1.2.1', '1.3.0', '1.3.1', '1.3.2']),
    projectBase: 'vaysen-openclaw-crm-tools-f0ac731cd3',
  }),
  Object.freeze({
    pluginId: 'openclaw-weixin',
    packageName: '@tencent-weixin/openclaw-weixin',
    versions: Object.freeze(['2.4.6']),
    projectBase: 'tencent-weixin-openclaw-weixin-7783ac86ba',
  }),
]);

const EXPECTED_PLUGIN_IDS = PLUGINS.map(({ pluginId }) => pluginId).sort();
const V2_TOP_LEVEL_KEYS = ['links', 'schemaVersion'];
const V2_LINK_KEYS = ['packageName', 'pluginId', 'relativePath', 'target', 'version'];

function assertSupportedNode() {
  const major = Number.parseInt(process.versions.node.split('.')[0], 10);
  if (!Number.isSafeInteger(major) || major < MINIMUM_NODE_MAJOR) {
    throw new Error(`Node >=${MINIMUM_NODE_MAJOR} is required for the SQLite runtime-link contract`);
  }
}

function sortedKeys(value) {
  return Object.keys(value).sort();
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !sameStrings(sortedKeys(value), expected)) {
    throw new Error(`${label} has unexpected fields`);
  }
}

function lstat(fileSystem, file, label) {
  try {
    return fileSystem.lstatSync(file);
  } catch (error) {
    throw new Error(`${label} is missing or unreadable: ${file}`, { cause: error });
  }
}

function assertRealDirectory(fileSystem, directory, label) {
  const stat = lstat(fileSystem, directory, label);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory: ${directory}`);
  }
}

function assertRegularFile(fileSystem, file, label) {
  const stat = lstat(fileSystem, file, label);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a regular non-symlink file: ${file}`);
  }
}

function resolveRelative(stateRoot, relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0
    || relativePath.includes('\\') || relativePath.includes('\0')
    || path.posix.isAbsolute(relativePath)
    || relativePath.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`unsafe runtime relative path: ${JSON.stringify(relativePath)}`);
  }
  const resolvedRoot = path.resolve(stateRoot);
  const resolved = path.resolve(resolvedRoot, ...relativePath.split('/'));
  const relative = path.relative(resolvedRoot, resolved);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`runtime path escapes its state root: ${relativePath}`);
  }
  return resolved;
}

function assertSafeArchiveRelative(relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0
    || relativePath.includes('\\') || relativePath.includes('\0')
    || path.posix.isAbsolute(relativePath)
    || relativePath.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`unsafe runtime archive path: ${JSON.stringify(relativePath)}`);
  }
}

function assertDirectoryChain(fileSystem, stateRoot, relativeDirectory, label) {
  assertRealDirectory(fileSystem, path.resolve(stateRoot), 'runtime state root');
  const segments = relativeDirectory.split('/');
  let current = path.resolve(stateRoot);
  for (const segment of segments) {
    current = path.join(current, segment);
    assertRealDirectory(fileSystem, current, label);
  }
  return current;
}

function readJsonFile(fileSystem, file, label) {
  assertRegularFile(fileSystem, file, label);
  try {
    return JSON.parse(fileSystem.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${file}`, { cause: error });
  }
}

function readInstallRecords(databasePath, Database = DatabaseSync) {
  const database = new Database(databasePath, { readOnly: true });
  try {
    const row = database.prepare(
      'SELECT install_records_json FROM installed_plugin_index WHERE index_key = ?',
    ).get(INSTALL_INDEX_KEY);
    if (!row || typeof row.install_records_json !== 'string') {
      throw new Error('OpenClaw installed-plugin-index record is missing');
    }
    const records = JSON.parse(row.install_records_json);
    if (!records || typeof records !== 'object' || Array.isArray(records)) {
      throw new Error('OpenClaw install_records_json must be an object');
    }
    if (!sameStrings(sortedKeys(records), EXPECTED_PLUGIN_IDS)) {
      throw new Error('OpenClaw install record set must contain exactly the two reviewed plugins');
    }
    return records;
  } finally {
    database.close();
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function derivePluginLink({ stateRoot, fileSystem, spec, record }) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error(`OpenClaw install record is invalid: ${spec.pluginId}`);
  }
  const actualVersion = record.version;
  if (typeof actualVersion !== 'string' || !spec.versions.includes(actualVersion)) {
    throw new Error(`OpenClaw install record version is outside the reviewed migration set: ${spec.pluginId}`);
  }
  const expectedSpec = `${spec.packageName}@${actualVersion}`;
  for (const [field, expected] of Object.entries({
    source: 'npm',
    spec: expectedSpec,
    version: actualVersion,
    resolvedName: spec.packageName,
    resolvedVersion: actualVersion,
    resolvedSpec: expectedSpec,
  })) {
    if (record[field] !== expected) {
      throw new Error(`OpenClaw install record ${field} mismatch for ${spec.pluginId}`);
    }
  }

  if (typeof record.installPath !== 'string') {
    throw new Error(`OpenClaw installPath is missing: ${spec.pluginId}`);
  }
  const projectPattern = `${escapeRegExp(spec.projectBase)}(?:__openclaw-generation__g-[0-9a-f]{16})?`;
  const packagePattern = escapeRegExp(spec.packageName);
  const installPattern = new RegExp(
    `^${escapeRegExp(CONTAINER_STATE_ROOT)}/npm/projects/(${projectPattern})/node_modules/${packagePattern}$`,
  );
  const match = installPattern.exec(record.installPath);
  if (!match) {
    throw new Error(`OpenClaw installPath is outside the reviewed project/package grammar: ${spec.pluginId}`);
  }

  const packageStateRelative = `npm/projects/${match[1]}/node_modules/${spec.packageName}`;
  const packageDirectory = assertDirectoryChain(
    fileSystem,
    stateRoot,
    packageStateRelative,
    `managed package directory for ${spec.pluginId}`,
  );
  const packageJson = readJsonFile(
    fileSystem,
    path.join(packageDirectory, 'package.json'),
    `managed package.json for ${spec.pluginId}`,
  );
  if (packageJson?.name !== spec.packageName || packageJson?.version !== actualVersion) {
    throw new Error(`managed package identity mismatch: ${spec.pluginId}`);
  }

  const relativePath = `openclaw/${packageStateRelative}/node_modules/openclaw`;
  assertSafeArchiveRelative(relativePath);
  return Object.freeze({
    pluginId: spec.pluginId,
    packageName: spec.packageName,
    version: actualVersion,
    relativePath,
    target: LINK_TARGET,
  });
}

export function deriveRuntimeLinkContract(stateRoot, options = {}) {
  assertSupportedNode();
  const fileSystem = options.fileSystem ?? fs;
  const Database = options.Database ?? DatabaseSync;
  const resolvedRoot = path.resolve(stateRoot);
  assertRealDirectory(fileSystem, resolvedRoot, 'runtime state root');
  assertDirectoryChain(fileSystem, resolvedRoot, 'state', 'OpenClaw state directory');
  const databasePath = resolveRelative(resolvedRoot, 'state/openclaw.sqlite');
  assertRegularFile(fileSystem, databasePath, 'OpenClaw state database');
  const records = readInstallRecords(databasePath, Database);
  const links = PLUGINS.map((spec) => derivePluginLink({
    stateRoot: resolvedRoot,
    fileSystem,
    spec,
    record: records[spec.pluginId],
  })).sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en'));
  return Object.freeze({ schemaVersion: 2, links: Object.freeze(links) });
}

export function serializeV2Manifest(contract) {
  return `${JSON.stringify(contract, null, 2)}\n`;
}

function parseV1Manifest(content) {
  if (content.includes('\0')) throw new Error('v1 runtime-link manifest contains NUL');
  const normalized = content.replaceAll('\r\n', '\n');
  const body = normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;
  const links = body.split('\n');
  if (links.length !== 2 || links.some((link) => link.length === 0)) {
    throw new Error('v1 runtime-link manifest must contain exactly two non-empty lines');
  }
  return links.sort((left, right) => left.localeCompare(right, 'en'));
}

function parseV2Manifest(content) {
  let manifest;
  try {
    manifest = JSON.parse(content);
  } catch (error) {
    throw new Error('v2 runtime-link manifest is not valid JSON', { cause: error });
  }
  assertExactKeys(manifest, V2_TOP_LEVEL_KEYS, 'v2 runtime-link manifest');
  if (manifest.schemaVersion !== 2 || !Array.isArray(manifest.links) || manifest.links.length !== 2) {
    throw new Error('v2 runtime-link manifest schema/count is invalid');
  }
  for (const [index, link] of manifest.links.entries()) {
    assertExactKeys(link, V2_LINK_KEYS, `v2 runtime-link manifest link ${index}`);
  }
  return {
    schemaVersion: manifest.schemaVersion,
    links: manifest.links.map((link) => ({
      pluginId: link.pluginId,
      packageName: link.packageName,
      version: link.version,
      relativePath: link.relativePath,
      target: link.target,
    })).sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en')),
  };
}

function expectedPaths(contract) {
  return contract.links.map(({ relativePath }) => relativePath)
    .sort((left, right) => left.localeCompare(right, 'en'));
}

export function verifyRuntimeLinkManifest(stateRoot, manifestPath, options = {}) {
  const fileSystem = options.fileSystem ?? fs;
  assertRegularFile(fileSystem, path.resolve(manifestPath), 'runtime-link manifest');
  const content = fileSystem.readFileSync(path.resolve(manifestPath), 'utf8');
  const contract = deriveRuntimeLinkContract(stateRoot, options);
  const paths = expectedPaths(contract);
  if (content.trimStart().startsWith('{')) {
    const manifest = parseV2Manifest(content);
    if (JSON.stringify(manifest) !== JSON.stringify(contract)) {
      throw new Error('v2 runtime-link manifest does not match the SQLite install index');
    }
  } else {
    const manifestPaths = parseV1Manifest(content);
    if (!sameStrings(manifestPaths, paths)) {
      throw new Error('v1 runtime-link manifest does not match the SQLite install index');
    }
  }
  return paths;
}

function collectSymlinks(fileSystem, stateRoot) {
  const links = [];
  const walk = (directory, relativeDirectory = '') => {
    const names = fileSystem.readdirSync(directory).sort((left, right) => left.localeCompare(right, 'en'));
    for (const name of names) {
      const relative = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const absolute = path.join(directory, name);
      const stat = lstat(fileSystem, absolute, 'runtime tree entry');
      if (stat.isSymbolicLink()) {
        links.push({ relativePath: `openclaw/${relative}`, target: fileSystem.readlinkSync(absolute, 'utf8') });
      } else if (stat.isDirectory()) {
        walk(absolute, relative);
      } else if (!stat.isFile()) {
        throw new Error(`runtime tree contains a special entry: openclaw/${relative}`);
      }
    }
  };
  assertRealDirectory(fileSystem, stateRoot, 'runtime state root');
  walk(stateRoot);
  return links.sort((left, right) => left.relativePath.localeCompare(right.relativePath, 'en'));
}

export function verifyRuntimeLinkTree(stateRoot, options = {}) {
  const fileSystem = options.fileSystem ?? fs;
  const resolvedRoot = path.resolve(stateRoot);
  const contract = deriveRuntimeLinkContract(resolvedRoot, options);
  const expected = contract.links.map(({ relativePath, target }) => ({ relativePath, target }));
  let actual = collectSymlinks(fileSystem, resolvedRoot);
  if (options.allowReviewedTransientLink === true) {
    const transientPath = resolveRelative(resolvedRoot, REVIEWED_TRANSIENT_LINK.stateRelativePath);
    let transientStat = null;
    try {
      transientStat = fileSystem.lstatSync(transientPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw new Error('reviewed transient runtime link is unreadable', { cause: error });
      }
    }
    if (transientStat) {
      if (!transientStat.isSymbolicLink()) {
        throw new Error('reviewed transient runtime link path is not a symlink');
      }
      const target = fileSystem.readlinkSync(transientPath, 'utf8');
      if (target !== REVIEWED_TRANSIENT_LINK.target) {
        throw new Error('reviewed transient runtime link target mismatch');
      }
      actual = actual.filter(({ relativePath }) => relativePath !== REVIEWED_TRANSIENT_LINK.relativePath);
    }
  }
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('runtime tree symlink set/targets do not match the SQLite install index');
  }
  return expectedPaths(contract);
}

function writePaths(paths) {
  process.stdout.write(`${paths.join('\n')}\n`);
}

function usage() {
  return 'usage: runtime-link-contract.mjs emit-v2 <stateRoot> | verify-manifest <stateRoot> <manifest> | verify-tree <stateRoot> | verify-live-tree <stateRoot>';
}

export function runCli(argv) {
  const [command, ...args] = argv;
  if (command === 'emit-v2' && args.length === 1) {
    process.stdout.write(serializeV2Manifest(deriveRuntimeLinkContract(args[0])));
    return;
  }
  if (command === 'verify-manifest' && args.length === 2) {
    writePaths(verifyRuntimeLinkManifest(args[0], args[1]));
    return;
  }
  if (command === 'verify-tree' && args.length === 1) {
    writePaths(verifyRuntimeLinkTree(args[0]));
    return;
  }
  if (command === 'verify-live-tree' && args.length === 1) {
    writePaths(verifyRuntimeLinkTree(args[0], { allowReviewedTransientLink: true }));
    return;
  }
  throw new Error(usage());
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`[RUNTIME LINK CONTRACT ERROR] ${error.message}\n`);
    process.exitCode = 1;
  }
}
