import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

import { verifyOpenClawHostContractFiles } from './verify-host-contract.mjs';

export const EXPECTED_WEIXIN = Object.freeze({
  id: 'openclaw-weixin',
  packageName: '@tencent-weixin/openclaw-weixin',
  version: '2.4.6',
  upstreamIntegrity: 'sha512-qw9k3PLTiMWGNjjsknHgcTManH1w4j+Ji1ArWIaYLKCq3aFRsVwcqnPi127bvOoVMJGW4dbyJ8NECEMgoO+iRw==',
  upstreamShasum: 'c7744c5b2d0232703c886b2f4e71681b0170695d',
  upstreamSha256: 'ef1c3600ca2fc0ee9076c1327af1e0d5d2e8e19fbb61e9f56c961fcde0bd07f6',
  patchSha256: '8ab539fd6cc0a3ae1587a6f0a994ad163b511c6d563423772d780c935c8c43f1',
  patchedIntegrity: 'sha512-WarnJ65LzlqhSluRnY4c/SvnnKnZTNhIEMXZEih+iQRDe4iZsVznsp3EySB+ADBdsa6XSH4MfhyijFLgiTPyhQ==',
  patchedShasum: 'c13881a517533b1b223543b77f7186ff556882fd',
  patchedSha256: '15cde2b9926263ab5cfba21f2b935c710bc01dd983611e3dee673a052fa203d6',
  patchedTreeSha256: '7f2d15c5e1d665ee7b3e7b1fc9885b915854e960d7f82ac97a512939eb2664b1',
  dependencies: {
    'qrcode-terminal': {
      spec: '0.12.0',
      version: '0.12.0',
      integrity: 'sha512-EXtzRZmC+YGmGlDFbXKxQiMZNwCLEO6BANKXG4iCtSIM0yqc/pappSx3RIKr4r0uh5JsBckOXeKrB3Iz7mdQpQ==',
    },
    zod: {
      spec: '4.3.6',
      version: '4.3.6',
      integrity: 'sha512-rftlrkhHZOcjDwkGlnUtZZkvaPHCsDATp4pGpuOOMDaTdDDXF91wuVDJoWoPsKX/3YPQ5fHuF3STjcYyKr+Qhg==',
    },
  },
  keyFiles: ['package.json', 'openclaw.plugin.json', 'dist/index.js'],
});

export const EXPECTED_PRIVATE_CRM = Object.freeze({
  id: 'vaysen-crm',
  packageName: '@vaysen/openclaw-crm-tools',
  version: '1.3.2',
  upstreamIntegrity: null,
  artifactIntegrity: 'sha512-fu6j3WS59SqYdJ6rcazF+fz4yrxSwb7UCXw7XRogJo0DBnE0PtNUtls8CsTU3jt47ugk9DbYa6tj8tBIAvQIJQ==',
  artifactShasum: '1cdcf64ba32552e34b2ac8700f8a014fab53cd66',
  artifactSha256: 'd7259621593500451537179caa31341a026e6f9a4181ca88a6a0879b211826ed',
  artifactTreeSha256: 'a7dbe8428e8c4d6bb492f792b0fde81fe759ccb141dcaefe5e6ee4bbbc60161d',
  dependencies: {
    typebox: {
      spec: '1.3.3',
      version: '1.3.3',
      integrity: 'sha512-URXGUE31PJDQC+PtRMJeLdF4kmmOdFoVPikPCtV2oOIhUpNpppEdIz7W8bH8cFYPYHdDpaRvqwdegMTmHliudg==',
    },
  },
  keyFiles: ['package.json', 'npm-shrinkwrap.json', 'openclaw.plugin.json', 'dist/index.js', 'dist/runtime.js', 'dist/notify-owner.js'],
});

const PLUGINS = [EXPECTED_PRIVATE_CRM, EXPECTED_WEIXIN];

const GENERATED_PLUGIN_ROOT_FILES = new Set(['package-lock.json', 'npm-shrinkwrap.json']);
const INSTALL_RECORD_INDEX_KEY = 'installed-plugin-index';

function assertRegularFile(file, label = 'file') {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`unsafe ${label}: ${file}`);
  return stat;
}

function assertRealDirectory(directory, label = 'directory') {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`unsafe ${label}: ${directory}`);
  return stat;
}

function readRegularJson(file) {
  assertRegularFile(file, 'managed JSON file');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function hashFile(file, algorithm) {
  assertRegularFile(file, 'artifact file');
  return createHash(algorithm).update(fs.readFileSync(file)).digest(algorithm === 'sha512' ? 'base64' : 'hex');
}

export function sha512Integrity(file) {
  return `sha512-${hashFile(file, 'sha512')}`;
}

function isPathInside(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function tarString(buffer, start, length) {
  const field = buffer.subarray(start, start + length);
  const nul = field.indexOf(0);
  return field.subarray(0, nul === -1 ? field.length : nul).toString('utf8');
}

function tarNumber(buffer, start, length, label) {
  const field = buffer.subarray(start, start + length);
  if ((field[0] & 0x80) !== 0) throw new Error(`unsupported base-256 tar ${label}`);
  const raw = field.toString('ascii').replace(/\0.*$/s, '').trim();
  if (!raw) return 0;
  if (!/^[0-7]+$/.test(raw)) throw new Error(`invalid tar ${label}`);
  const parsed = Number.parseInt(raw, 8);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`invalid tar ${label}`);
  return parsed;
}

function parsePax(data) {
  const result = {};
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) throw new Error('invalid pax record length');
    const lengthText = data.subarray(offset, space).toString('ascii');
    if (!/^[1-9][0-9]*$/.test(lengthText)) throw new Error('invalid pax record length');
    const length = Number.parseInt(lengthText, 10);
    const end = offset + length;
    if (!Number.isSafeInteger(length) || end > data.length || data[end - 1] !== 0x0a) {
      throw new Error('truncated pax record');
    }
    const record = data.subarray(space + 1, end - 1).toString('utf8');
    const equals = record.indexOf('=');
    if (equals <= 0) throw new Error('invalid pax record');
    result[record.slice(0, equals)] = record.slice(equals + 1);
    offset = end;
  }
  return result;
}

function normalizeNpmPackPath(value, isDirectory) {
  if (!value || value.includes('\\') || value.includes('\0') || /[\u0000-\u001f]/.test(value)) {
    throw new Error(`unsafe npm-pack entry path: ${JSON.stringify(value)}`);
  }
  const withoutTrailingSlash = value.endsWith('/') ? value.slice(0, -1) : value;
  if (withoutTrailingSlash === 'package' && isDirectory) return null;
  if (!withoutTrailingSlash.startsWith('package/')) {
    throw new Error(`npm-pack entry is outside package root: ${value}`);
  }
  const relative = withoutTrailingSlash.slice('package/'.length);
  const normalized = path.posix.normalize(relative);
  if (!relative || normalized !== relative || normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(relative)) {
    throw new Error(`unsafe npm-pack entry path: ${value}`);
  }
  if (relative === 'node_modules' || relative.startsWith('node_modules/')) {
    throw new Error(`npm-pack artifact contains forbidden node_modules content: ${relative}`);
  }
  return relative;
}

export function readNpmPackFiles(artifactPath) {
  assertRegularFile(artifactPath, 'npm-pack artifact');
  let tar;
  try {
    tar = gunzipSync(fs.readFileSync(artifactPath));
  } catch (error) {
    throw new Error(`invalid npm-pack gzip stream: ${error instanceof Error ? error.message : String(error)}`);
  }

  const files = new Map();
  let offset = 0;
  let globalPax = {};
  let nextPax = {};
  let longPath = null;
  let sawEnd = false;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      sawEnd = true;
      break;
    }
    const size = tarNumber(header, 124, 12, 'entry size');
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw new Error('truncated npm-pack tar entry');
    const data = tar.subarray(dataStart, dataEnd);
    const type = String.fromCharCode(header[156] || 0);
    const name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    const headerPath = prefix ? `${prefix}/${name}` : name;

    if (type === 'x' || type === 'g') {
      const values = parsePax(data);
      if (values.linkpath) throw new Error('npm-pack pax record contains a link target');
      if (type === 'g') globalPax = { ...globalPax, ...values };
      else nextPax = values;
    } else if (type === 'L') {
      longPath = data.toString('utf8').replace(/\0.*$/s, '').replace(/\n$/, '');
    } else {
      const effectivePath = nextPax.path ?? longPath ?? globalPax.path ?? headerPath;
      nextPax = {};
      longPath = null;
      const isDirectory = type === '5';
      if (type !== '\0' && type !== '0' && !isDirectory) {
        throw new Error(`npm-pack artifact contains unsupported entry type ${JSON.stringify(type)}: ${effectivePath}`);
      }
      const relative = normalizeNpmPackPath(effectivePath, isDirectory);
      if (!isDirectory && relative) {
        if (files.has(relative)) throw new Error(`duplicate npm-pack file: ${relative}`);
        files.set(relative, Buffer.from(data));
      }
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  if (!sawEnd || files.size === 0) throw new Error('npm-pack tar is missing its terminator or files');
  return files;
}

function publishedFileFacts(files) {
  const facts = {};
  const records = [];
  for (const relative of [...files.keys()].sort()) {
    const content = files.get(relative);
    const sha256 = createHash('sha256').update(content).digest('hex');
    facts[relative] = { size: content.length, sha256 };
    records.push(`${relative}\0${content.length}\0${sha256}`);
  }
  return {
    files: facts,
    normalizedTreeSha256: createHash('sha256').update(`${records.join('\n')}\n`, 'utf8').digest('hex'),
  };
}

function collectManagedPublishedFiles(pluginDir, artifactFiles) {
  assertRealDirectory(pluginDir, 'managed plugin directory');
  const managedFiles = new Map();
  const generated = { nodeModules: false, lockFiles: [] };
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(directory, entry.name);
      const relative = path.relative(pluginDir, full).split(path.sep).join('/');
      const stat = fs.lstatSync(full);
      if (relative === 'node_modules') {
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('managed node_modules root is unsafe');
        generated.nodeModules = true;
        continue;
      }
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
        throw new Error(`managed published tree contains a link or special file: ${relative}`);
      }
      if (stat.isDirectory()) {
        walk(full);
        continue;
      }
      if (!artifactFiles.has(relative) && !relative.includes('/') && GENERATED_PLUGIN_ROOT_FILES.has(relative)) {
        generated.lockFiles.push(relative);
        continue;
      }
      managedFiles.set(relative, fs.readFileSync(full));
    }
  };
  walk(pluginDir);

  for (const [relative, content] of artifactFiles) {
    const installed = managedFiles.get(relative);
    if (!installed) throw new Error(`managed plugin is missing published file: ${relative}`);
    if (!installed.equals(content)) throw new Error(`managed published file mismatch: ${relative}`);
  }
  for (const relative of managedFiles.keys()) {
    if (!artifactFiles.has(relative)) throw new Error(`managed plugin contains an unverified published file: ${relative}`);
  }
  return generated;
}

export function readOpenClawInstallRecords(stateDbPath) {
  assertRegularFile(stateDbPath, 'OpenClaw state database');
  const database = new DatabaseSync(stateDbPath, { readOnly: true });
  try {
    const row = database.prepare(
      'SELECT install_records_json FROM installed_plugin_index WHERE index_key = ?',
    ).get(INSTALL_RECORD_INDEX_KEY);
    if (!row || typeof row.install_records_json !== 'string') {
      throw new Error('OpenClaw installed-plugin-index record is missing');
    }
    const parsed = JSON.parse(row.install_records_json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('OpenClaw install_records_json is invalid');
    }
    return parsed;
  } finally {
    database.close();
  }
}

function assertInstallRecordField(record, field, expected, pluginId = 'unknown-plugin') {
  if (record?.[field] !== expected) {
    throw new Error(`OpenClaw install record ${field} mismatch for ${pluginId}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(record?.[field])}`);
  }
}

function canonicalNpmPackTarballName(packageName, version) {
  const normalizedName = packageName.startsWith('@')
    ? packageName.slice(1).replaceAll('/', '-')
    : packageName.replaceAll('/', '-');
  return `${normalizedName}-${version}.tgz`;
}

function verifyReviewedPatchManifest(patchPath, expected, patchedFiles) {
  const patch = readRegularJson(patchPath);
  if (patch.schemaVersion !== 1 || patch.packageName !== expected.packageName || patch.version !== expected.version) {
    throw new Error(`reviewed patch identity mismatch: ${expected.id}`);
  }
  for (const [field, value] of Object.entries({
    integrity: expected.upstreamIntegrity,
    sha1: expected.upstreamShasum,
    sha256: expected.upstreamSha256,
  })) {
    if (patch.upstream?.[field] !== value) throw new Error(`reviewed patch upstream ${field} mismatch`);
  }
  for (const [field, value] of Object.entries({
    integrity: expected.patchedIntegrity,
    sha1: expected.patchedShasum,
    sha256: expected.patchedSha256,
    treeSha256: expected.patchedTreeSha256,
  })) {
    if (patch.patched?.[field] !== value) throw new Error(`reviewed patch output ${field} mismatch`);
  }
  const modifiedFiles = {};
  for (const [relative, rule] of Object.entries(patch.files ?? {})) {
    const content = patchedFiles.get(relative);
    if (!content || hashBuffer(content, 'sha256') !== rule.afterSha256) {
      throw new Error(`reviewed patch modified-file digest mismatch: ${relative}`);
    }
    modifiedFiles[relative] = rule.afterSha256;
  }
  const patchRoot = path.dirname(path.resolve(patchPath));
  const payloadFiles = {};
  for (const [relative, addition] of Object.entries(patch.addFiles ?? {})) {
    if (typeof addition.sourceFile !== 'string' || path.posix.normalize(addition.sourceFile) !== addition.sourceFile
      || addition.sourceFile.startsWith('../') || path.posix.isAbsolute(addition.sourceFile)) {
      throw new Error(`reviewed patch payload path is unsafe: ${relative}`);
    }
    const payloadPath = path.resolve(patchRoot, ...addition.sourceFile.split('/'));
    if (!isPathInside(payloadPath, patchRoot)) throw new Error(`reviewed patch payload escapes its root: ${relative}`);
    assertRegularFile(payloadPath, `reviewed patch payload ${relative}`);
    const payload = fs.readFileSync(payloadPath);
    const artifactContent = patchedFiles.get(relative);
    if (hashBuffer(payload, 'sha256') !== addition.sha256 || !artifactContent?.equals(payload)) {
      throw new Error(`reviewed patch payload digest mismatch: ${relative}`);
    }
    payloadFiles[relative] = { path: payloadPath, sha256: addition.sha256 };
  }
  return { sha256: expected.patchSha256, modifiedFiles, payloadFiles };
}

function hashBuffer(buffer, algorithm) {
  return createHash(algorithm).update(buffer).digest('hex');
}

function verifyNpmPackInstallRecord({ expected, installRecord, artifactPath, pluginDir, integrity, shasum }) {
  const resolvedArtifact = path.resolve(artifactPath);
  const resolvedPluginDir = path.resolve(pluginDir);
  const resolvedSpec = `${expected.packageName}@${expected.version}`;
  for (const [field, value] of Object.entries({
    source: 'npm',
    spec: resolvedSpec,
    sourcePath: resolvedArtifact,
    installPath: resolvedPluginDir,
    version: expected.version,
    resolvedName: expected.packageName,
    resolvedVersion: expected.version,
    resolvedSpec,
    integrity,
    shasum,
    artifactKind: 'npm-pack',
    artifactFormat: 'tgz',
    npmIntegrity: integrity,
    npmShasum: shasum,
    // OpenClaw obtains this field from `npm pack <archive> --dry-run --json`.
    // npm reports the canonical package/version filename, not the caller's
    // external artifact basename. sourcePath and every digest above still bind
    // the record to the exact reviewed patched/private tgz bytes.
    npmTarballName: canonicalNpmPackTarballName(expected.packageName, expected.version),
  })) assertInstallRecordField(installRecord, field, value, expected.id);
  return {
    source: installRecord.source,
    spec: installRecord.spec,
    sourcePath: installRecord.sourcePath,
    installPath: installRecord.installPath,
    artifactKind: installRecord.artifactKind,
    artifactFormat: installRecord.artifactFormat,
    npmIntegrity: installRecord.npmIntegrity,
    npmShasum: installRecord.npmShasum,
    npmTarballName: installRecord.npmTarballName,
  };
}

export function verifyPrivateNpmPackSupplyChain({ expected, artifactPath, pluginDir, installRecord }) {
  const resolvedArtifact = path.resolve(artifactPath);
  const resolvedPluginDir = path.resolve(pluginDir);
  const integrity = sha512Integrity(resolvedArtifact);
  const shasum = hashFile(resolvedArtifact, 'sha1');
  const sha256 = hashFile(resolvedArtifact, 'sha256');
  if (integrity !== expected.artifactIntegrity
    || shasum !== expected.artifactShasum
    || sha256 !== expected.artifactSha256) {
    throw new Error(`private npm-pack artifact integrity mismatch: ${expected.id}`);
  }
  const artifactFiles = readNpmPackFiles(resolvedArtifact);
  const packageJsonBytes = artifactFiles.get('package.json');
  const shrinkwrapBytes = artifactFiles.get('npm-shrinkwrap.json');
  const manifestBytes = artifactFiles.get('openclaw.plugin.json');
  if (!packageJsonBytes || !shrinkwrapBytes || !manifestBytes) {
    throw new Error(`private npm-pack artifact is missing a required manifest or lock: ${expected.id}`);
  }
  const packageJson = JSON.parse(packageJsonBytes.toString('utf8'));
  const pluginManifest = JSON.parse(manifestBytes.toString('utf8'));
  if (packageJson.name !== expected.packageName || packageJson.version !== expected.version) {
    throw new Error(`private npm-pack package identity mismatch: ${expected.id}`);
  }
  if (pluginManifest.id !== expected.id) throw new Error(`private npm-pack plugin id mismatch: ${expected.id}`);
  const published = publishedFileFacts(artifactFiles);
  if (published.normalizedTreeSha256 !== expected.artifactTreeSha256) {
    throw new Error(`private npm-pack normalized tree mismatch: ${expected.id}`);
  }
  const generated = collectManagedPublishedFiles(resolvedPluginDir, artifactFiles);
  const verifiedInstallRecord = verifyNpmPackInstallRecord({
    expected,
    installRecord,
    artifactPath: resolvedArtifact,
    pluginDir: resolvedPluginDir,
    integrity,
    shasum,
  });
  return {
    private: {
      path: resolvedArtifact,
      size: fs.statSync(resolvedArtifact).size,
      integrity,
      shasum,
      sha256,
      tarballName: path.basename(resolvedArtifact),
      published,
    },
    generated,
    installRecord: verifiedInstallRecord,
  };
}

export function verifyNpmPackSupplyChain({
  expected,
  upstreamArtifactPath,
  patchedArtifactPath,
  patchPath,
  pluginDir,
  installRecord,
}) {
  const resolvedUpstreamArtifact = path.resolve(upstreamArtifactPath);
  const resolvedPatchedArtifact = path.resolve(patchedArtifactPath);
  const resolvedPatch = path.resolve(patchPath);
  const resolvedPluginDir = path.resolve(pluginDir);
  const upstreamIntegrity = sha512Integrity(resolvedUpstreamArtifact);
  const upstreamShasum = hashFile(resolvedUpstreamArtifact, 'sha1');
  const upstreamSha256 = hashFile(resolvedUpstreamArtifact, 'sha256');
  if (
    upstreamIntegrity !== expected.upstreamIntegrity
    || upstreamShasum !== expected.upstreamShasum
    || upstreamSha256 !== expected.upstreamSha256
  ) {
    throw new Error(`upstream npm-pack artifact integrity mismatch: ${expected.id}`);
  }
  if (hashFile(resolvedPatch, 'sha256') !== expected.patchSha256) {
    throw new Error(`reviewed patch manifest integrity mismatch: ${expected.id}`);
  }

  const upstreamFiles = readNpmPackFiles(resolvedUpstreamArtifact);
  const upstreamPackageJson = upstreamFiles.get('package.json');
  if (!upstreamPackageJson) throw new Error('upstream npm-pack artifact is missing package.json');
  const upstreamPackage = JSON.parse(upstreamPackageJson.toString('utf8'));
  if (upstreamPackage.name !== expected.packageName || upstreamPackage.version !== expected.version) {
    throw new Error(`upstream npm-pack package identity mismatch: ${expected.id}`);
  }

  const integrity = sha512Integrity(resolvedPatchedArtifact);
  const shasum = hashFile(resolvedPatchedArtifact, 'sha1');
  const patchedSha256 = hashFile(resolvedPatchedArtifact, 'sha256');
  if (
    integrity !== expected.patchedIntegrity
    || shasum !== expected.patchedShasum
    || patchedSha256 !== expected.patchedSha256
  ) {
    throw new Error(`patched npm-pack artifact integrity mismatch: ${expected.id}`);
  }
  const artifactFiles = readNpmPackFiles(resolvedPatchedArtifact);
  const packageJsonBytes = artifactFiles.get('package.json');
  const manifestBytes = artifactFiles.get('openclaw.plugin.json');
  if (!packageJsonBytes || !manifestBytes) throw new Error('patched npm-pack artifact is missing required manifests');
  const packageJson = JSON.parse(packageJsonBytes.toString('utf8'));
  const pluginManifest = JSON.parse(manifestBytes.toString('utf8'));
  if (packageJson.name !== expected.packageName || packageJson.version !== expected.version) {
    throw new Error(`patched npm-pack package identity mismatch: ${expected.id}`);
  }
  if (pluginManifest.id !== expected.id) throw new Error(`patched npm-pack plugin id mismatch: ${expected.id}`);
  const published = publishedFileFacts(artifactFiles);
  if (published.normalizedTreeSha256 !== expected.patchedTreeSha256) {
    throw new Error(`patched npm-pack normalized tree mismatch: ${expected.id}`);
  }
  const reviewedPatch = verifyReviewedPatchManifest(resolvedPatch, expected, artifactFiles);

  const generated = collectManagedPublishedFiles(resolvedPluginDir, artifactFiles);
  const verifiedInstallRecord = verifyNpmPackInstallRecord({
    expected,
    installRecord,
    artifactPath: resolvedPatchedArtifact,
    pluginDir: resolvedPluginDir,
    integrity,
    shasum,
  });
  return {
    upstream: {
      path: resolvedUpstreamArtifact,
      size: fs.statSync(resolvedUpstreamArtifact).size,
      integrity: upstreamIntegrity,
      shasum: upstreamShasum,
      sha256: upstreamSha256,
    },
    patch: { path: resolvedPatch, ...reviewedPatch },
    patched: {
      path: resolvedPatchedArtifact,
      size: fs.statSync(resolvedPatchedArtifact).size,
      integrity,
      shasum,
      sha256: patchedSha256,
      tarballName: path.basename(resolvedPatchedArtifact),
      published,
    },
    generated,
    installRecord: verifiedInstallRecord,
  };
}

function resolveManagedNpmProjectRoot(pluginDir) {
  let cursor = path.resolve(pluginDir);
  while (true) {
    if (path.basename(cursor) === 'node_modules') return path.dirname(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  throw new Error(`managed npm project root was not found for ${pluginDir}`);
}

function resolveInstalledDependency(pluginDir, projectRoot, dependencyName) {
  let cursor = path.resolve(pluginDir);
  const resolvedProjectRoot = path.resolve(projectRoot);
  while (cursor === resolvedProjectRoot || isPathInside(cursor, resolvedProjectRoot)) {
    const packageDir = path.join(cursor, 'node_modules', ...dependencyName.split('/'));
    const packageJsonPath = path.join(packageDir, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      assertRealDirectory(packageDir, `managed dependency directory ${dependencyName}`);
      const nestedNodeModules = path.join(packageDir, 'node_modules');
      if (fs.existsSync(nestedNodeModules)) {
        assertRealDirectory(nestedNodeModules, `managed dependency node_modules ${dependencyName}`);
        if (fs.readdirSync(nestedNodeModules).length > 0) {
          throw new Error(`managed leaf dependency contains nested packages: ${dependencyName}`);
        }
      }
      return { packageDir, packageJson: readRegularJson(packageJsonPath) };
    }
    if (cursor === resolvedProjectRoot) break;
    cursor = path.dirname(cursor);
  }
  throw new Error(`managed plugin dependency is missing: ${dependencyName}`);
}

export function verifyDependencies(pluginDir, projectRoot, expected) {
  const packageJson = readRegularJson(path.join(pluginDir, 'package.json'));
  const projectPackageJson = readRegularJson(path.join(projectRoot, 'package.json'));
  const lockPath = ['npm-shrinkwrap.json', 'package-lock.json']
    .map((name) => path.join(projectRoot, name))
    .find((file) => fs.existsSync(file));
  if (!lockPath) throw new Error(`managed plugin lock is missing: ${expected.id}`);
  const lock = readRegularJson(lockPath);
  if (lock.lockfileVersion !== 3) {
    throw new Error(`managed plugin lockfile version mismatch: ${expected.id}`);
  }
  if (!lock.packages || typeof lock.packages !== 'object' || Array.isArray(lock.packages)) {
    throw new Error(`managed plugin lock package map is invalid: ${expected.id}`);
  }
  const expectedProjectDependencyNames = [expected.packageName];
  const projectDependencyNames = Object.keys(projectPackageJson.dependencies ?? {}).sort();
  const lockRootDependencyNames = Object.keys(lock.packages['']?.dependencies ?? {}).sort();
  if (JSON.stringify(projectDependencyNames) !== JSON.stringify(expectedProjectDependencyNames)
      || JSON.stringify(lockRootDependencyNames) !== JSON.stringify(expectedProjectDependencyNames)) {
    throw new Error(`managed plugin project dependency closure mismatch: ${expected.id}`);
  }
  const pluginLockKey = path.relative(projectRoot, pluginDir).split(path.sep).join('/');
  if (lock.packages[pluginLockKey]?.version !== expected.version) {
    throw new Error(`managed plugin lock identity mismatch: ${expected.id}`);
  }
  const allowedLockKeys = new Set(['', pluginLockKey]);
  const resolved = {};
  for (const [name, dependency] of Object.entries(expected.dependencies)) {
    if (packageJson.dependencies?.[name] !== dependency.spec) {
      throw new Error(`managed plugin dependency spec mismatch: ${expected.id}/${name}`);
    }
    let installed;
    try {
      installed = resolveInstalledDependency(pluginDir, projectRoot, name);
    } catch (error) {
      throw new Error(`${expected.id}/${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const lockKey = path.relative(projectRoot, installed.packageDir).split(path.sep).join('/');
    allowedLockKeys.add(lockKey);
    const locked = lock?.packages?.[lockKey];
    if (installed.packageJson.name !== name) {
      throw new Error(`managed plugin resolved dependency identity mismatch: ${expected.id}/${name}`);
    }
    if (installed.packageJson.version !== dependency.version) {
      throw new Error(`managed plugin resolved dependency mismatch: ${expected.id}/${name}`);
    }
    if (locked?.version !== dependency.version) {
      throw new Error(`managed plugin lock version mismatch: ${expected.id}/${name}`);
    }
    if (locked?.integrity !== dependency.integrity) {
      throw new Error(`managed plugin lock integrity mismatch: ${expected.id}/${name}`);
    }
    resolved[name] = dependency.version;
  }
  const actualLockKeys = Object.keys(lock.packages).sort();
  const expectedLockKeys = [...allowedLockKeys].sort();
  if (JSON.stringify(actualLockKeys) !== JSON.stringify(expectedLockKeys)) {
    throw new Error(`managed plugin lock package closure mismatch: ${expected.id}`);
  }

  // The OpenClaw peer is an intentionally approved link to the digest-pinned
  // /app tree. Production images omit development-only packages, so a recursive
  // npm ls would incorrectly audit the host application and report its trimmed
  // dependency tree as a plugin failure. Depth zero still validates the managed
  // project and its direct installed plugin without traversing that peer; the
  // exact plugin dependencies, lock integrities and peer target are verified
  // independently below and by verifyManagedStateEntries.
  const npmResult = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ls', '--json', '--depth=0', '--omit=dev'], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: { ...process.env, npm_config_update_notifier: 'false' },
    shell: process.platform === 'win32',
  });
  if (npmResult.status !== 0) {
    const detail = npmResult.stderr?.trim() || npmResult.stdout?.trim()
      || npmResult.error?.message || `exit ${npmResult.status}`;
    throw new Error(`managed plugin npm dependency tree is invalid: ${expected.id}: ${detail}`);
  }
  let npmTree;
  try {
    npmTree = JSON.parse(npmResult.stdout);
  } catch {
    throw new Error(`managed plugin npm dependency tree returned invalid JSON: ${expected.id}`);
  }
  if (!npmTree || typeof npmTree !== 'object' || Array.isArray(npmTree)) {
    throw new Error(`managed plugin npm dependency tree returned an invalid root: ${expected.id}`);
  }
  const problems = npmTree.problems;
  if (problems !== undefined && (!Array.isArray(problems) || problems.length > 0)) {
    const detail = Array.isArray(problems) ? problems.slice(0, 10).join('; ') : 'invalid problems field';
    throw new Error(`managed plugin npm dependency tree has problems: ${expected.id}: ${detail}`);
  }
  const npmDependencies = npmTree.dependencies;
  const npmDependencyNames = npmDependencies && typeof npmDependencies === 'object' && !Array.isArray(npmDependencies)
    ? Object.keys(npmDependencies).sort()
    : [];
  if (JSON.stringify(npmDependencyNames) !== JSON.stringify([expected.packageName])) {
    throw new Error(`managed plugin npm depth-zero closure mismatch: ${expected.id}`);
  }
  const npmPlugin = npmDependencies[expected.packageName];
  if (!npmPlugin || typeof npmPlugin !== 'object' || npmPlugin.version !== expected.version
      || npmPlugin.invalid || npmPlugin.extraneous || npmPlugin.missing) {
    throw new Error(`managed plugin npm depth-zero identity mismatch: ${expected.id}`);
  }
  return { lockPath, resolved };
}

function normalizedAuthoredTree(pluginDir) {
  const records = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(directory, entry.name);
      const relative = path.relative(pluginDir, full).split(path.sep).join('/');
      const stat = fs.lstatSync(full);
      if (relative === 'node_modules') {
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('managed node_modules root is unsafe');
        continue;
      }
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) {
        throw new Error(`managed plugin authored tree contains a link or special file: ${relative}`);
      }
      if (stat.isDirectory()) walk(full);
      else records.push(`${relative}\0${stat.size}\0${createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`);
    }
  };
  walk(pluginDir);
  return createHash('sha256').update(`${records.join('\n')}\n`, 'utf8').digest('hex');
}

const REVIEWED_RUNTIME_LINK = Object.freeze({
  relativePath: 'plugin-skills/browser-automation',
  target: '/app/dist/extensions/browser/skills/browser-automation',
});

export function verifyManagedStateEntries({
  stateDir,
  registeredPackageDirs,
  openClawPackageRoot,
  allowReviewedRuntimeLink = false,
  reviewedRuntimeLink = REVIEWED_RUNTIME_LINK,
}) {
  const resolvedStateDir = path.resolve(stateDir);
  const resolvedOpenClawRoot = path.resolve(openClawPackageRoot);
  assertRealDirectory(resolvedStateDir, 'OpenClaw state root');
  assertRealDirectory(resolvedOpenClawRoot, 'digest-pinned OpenClaw package root');
  const openClawPackage = readRegularJson(path.join(resolvedOpenClawRoot, 'package.json'));
  if (openClawPackage.name !== 'openclaw') {
    throw new Error('current image package root is not the OpenClaw package');
  }
  assertRegularFile(path.join(resolvedOpenClawRoot, 'dist', 'index.js'), 'OpenClaw runtime entrypoint');
  const expectedTarget = fs.realpathSync(resolvedOpenClawRoot);
  const allowedLinks = new Map();
  const allowedPeerLinks = new Set();
  const allowedRuntimeLinks = new Set();

  for (const rawPackageDir of registeredPackageDirs) {
    const packageDir = path.resolve(rawPackageDir);
    if (!isPathInside(packageDir, resolvedStateDir)) {
      throw new Error(`registered plugin package is outside OpenClaw state: ${packageDir}`);
    }
    assertRealDirectory(packageDir, 'registered plugin package directory');
    const packageJson = readRegularJson(path.join(packageDir, 'package.json'));
    if (typeof packageJson.peerDependencies?.openclaw !== 'string' || !packageJson.peerDependencies.openclaw.trim()) {
      throw new Error(`registered plugin does not declare the OpenClaw peer: ${packageDir}`);
    }
    const nodeModules = path.join(packageDir, 'node_modules');
    assertRealDirectory(nodeModules, 'plugin-local node_modules directory');
    const localEntries = fs.readdirSync(nodeModules).sort();
    const allowedLocalEntries = ['openclaw'];
    if (localEntries.includes('.bin')) {
      const localBin = path.join(nodeModules, '.bin');
      assertRealDirectory(localBin, 'plugin-local .bin directory');
      if (fs.readdirSync(localBin).length !== 0) {
        throw new Error(`registered plugin has a non-empty plugin-local .bin directory: ${packageDir}`);
      }
      allowedLocalEntries.unshift('.bin');
    }
    if (JSON.stringify(localEntries) !== JSON.stringify(allowedLocalEntries)) {
      throw new Error(`registered plugin has an unexpected plugin-local node_modules entry: ${packageDir}`);
    }
    const peerLink = path.join(nodeModules, 'openclaw');
    let peerStat;
    try {
      peerStat = fs.lstatSync(peerLink);
    } catch {
      throw new Error(`registered plugin OpenClaw peer link is missing: ${peerLink}`);
    }
    if (!peerStat.isSymbolicLink()) {
      throw new Error(`registered plugin OpenClaw peer must be a symbolic link: ${peerLink}`);
    }
    let actualTarget;
    try {
      actualTarget = fs.realpathSync(peerLink);
    } catch {
      throw new Error(`registered plugin OpenClaw peer link is broken: ${peerLink}`);
    }
    if (actualTarget !== expectedTarget) {
      throw new Error(`registered plugin OpenClaw peer target mismatch: ${peerLink}`);
    }
    allowedLinks.set(path.resolve(peerLink), packageDir);
    allowedPeerLinks.add(path.resolve(peerLink));
  }

  if (allowReviewedRuntimeLink) {
    const runtimeLink = path.join(resolvedStateDir, ...reviewedRuntimeLink.relativePath.split('/'));
    let runtimeStat = null;
    try {
      runtimeStat = fs.lstatSync(runtimeLink);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw new Error(`reviewed OpenClaw runtime link is unreadable: ${runtimeLink}`, { cause: error });
      }
    }
    if (runtimeStat) {
      if (!runtimeStat.isSymbolicLink()) {
        throw new Error(`reviewed OpenClaw runtime link path must be a symbolic link: ${runtimeLink}`);
      }
      const rawTarget = fs.readlinkSync(runtimeLink, 'utf8');
      if (rawTarget !== reviewedRuntimeLink.target) {
        throw new Error(`reviewed OpenClaw runtime link target mismatch: ${runtimeLink}`);
      }
      allowedLinks.set(path.resolve(runtimeLink), resolvedOpenClawRoot);
      allowedRuntimeLinks.add(path.resolve(runtimeLink));
    }
  }

  const seenAllowed = new Set();
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(directory, entry.name);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) {
        if (!allowedLinks.has(path.resolve(full))) {
          throw new Error(`OpenClaw state contains an unapproved symbolic link: ${full}`);
        }
        seenAllowed.add(path.resolve(full));
        continue;
      }
      if (stat.isDirectory()) {
        walk(full);
        continue;
      }
      if (!stat.isFile()) throw new Error(`OpenClaw state contains a special file: ${full}`);
    }
  };
  walk(resolvedStateDir);
  for (const allowed of allowedLinks.keys()) {
    if (!seenAllowed.has(allowed)) throw new Error(`approved OpenClaw peer link was not found during state walk: ${allowed}`);
  }
  return {
    allowedPeerLinks: [...allowedPeerLinks].sort(),
    allowedRuntimeLinks: [...allowedRuntimeLinks].sort(),
    openClawPackageRoot: expectedTarget,
  };
}

export function auditManagedInstall({
  reportDir,
  privateArtifactPath,
  upstreamArtifactPath,
  patchedArtifactPath,
  patchPath,
  stateDir,
  stateDbPath,
  openClawPackageRoot = process.cwd(),
  allowReviewedRuntimeLink = false,
}) {
  const resolvedReportDir = path.resolve(reportDir);
  const resolvedPrivateArtifactPath = path.resolve(privateArtifactPath);
  const resolvedUpstreamArtifactPath = path.resolve(upstreamArtifactPath);
  const resolvedPatchedArtifactPath = path.resolve(patchedArtifactPath);
  const resolvedPatchPath = path.resolve(patchPath);
  const resolvedStateDir = path.resolve(stateDir);
  const resolvedStateDbPath = path.resolve(stateDbPath);
  fs.mkdirSync(resolvedReportDir, { recursive: true, mode: 0o700 });
  assertRealDirectory(resolvedReportDir, 'supply-chain report directory');
  fs.chmodSync(resolvedReportDir, 0o700);
  const artifactRoot = path.join(resolvedReportDir, 'artifacts');
  for (const artifact of [resolvedPrivateArtifactPath, resolvedUpstreamArtifactPath, resolvedPatchedArtifactPath]) {
    if (!isPathInside(artifact, artifactRoot)) {
      throw new Error('npm-pack artifacts must be inside the restricted supply-chain artifact directory');
    }
  }
  assertRegularFile(resolvedPatchPath, 'reviewed Weixin patch manifest');
  if (!isPathInside(resolvedReportDir, resolvedStateDir)) {
    throw new Error('supply-chain report directory must be inside OPENCLAW_STATE_DIR');
  }

  const hostContract = verifyOpenClawHostContractFiles({
    packageRoot: openClawPackageRoot,
    expectedTypeboxVersion: EXPECTED_PRIVATE_CRM.dependencies.typebox.version,
  });

  const installRecords = readOpenClawInstallRecords(resolvedStateDbPath);
  const managedNpmRoot = path.join(resolvedStateDir, 'npm');
  const reports = [];
  const registeredPackageDirs = [];
  for (const expected of PLUGINS) {
    const installRecord = installRecords[expected.id];
    if (!installRecord || typeof installRecord !== 'object') {
      throw new Error(`OpenClaw install record is missing: ${expected.id}`);
    }
    if (typeof installRecord.installPath !== 'string') {
      throw new Error(`OpenClaw installPath is missing: ${expected.id}`);
    }
    const pluginDir = path.resolve(installRecord.installPath);
    if (!isPathInside(pluginDir, managedNpmRoot)) {
      throw new Error(`managed installPath is outside the OpenClaw npm state root: ${expected.id}`);
    }
    const projectRoot = resolveManagedNpmProjectRoot(pluginDir);
    let artifact = null;
    if (expected.id === EXPECTED_WEIXIN.id) {
      artifact = verifyNpmPackSupplyChain({
        expected,
        upstreamArtifactPath: resolvedUpstreamArtifactPath,
        patchedArtifactPath: resolvedPatchedArtifactPath,
        patchPath: resolvedPatchPath,
        pluginDir,
        installRecord,
      });
    } else {
      artifact = verifyPrivateNpmPackSupplyChain({
        expected,
        artifactPath: resolvedPrivateArtifactPath,
        pluginDir,
        installRecord,
      });
    }
    registeredPackageDirs.push(pluginDir);

    const packageJson = readRegularJson(path.join(pluginDir, 'package.json'));
    if (packageJson.name !== expected.packageName || packageJson.version !== expected.version) {
      throw new Error(`managed plugin identity mismatch: ${expected.id}`);
    }
    const dependencies = verifyDependencies(pluginDir, projectRoot, expected);
    const files = {};
    for (const relative of expected.keyFiles) {
      const file = path.join(pluginDir, ...relative.split('/'));
      assertRegularFile(file, `managed plugin key file ${expected.id}/${relative}`);
      files[relative] = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    }
    const report = {
      schemaVersion: 2,
      verifiedAt: new Date().toISOString(),
      plugin: { id: expected.id, package: expected.packageName, version: expected.version },
      upstreamIntegrity: expected.upstreamIntegrity,
      dependencies: Object.fromEntries(Object.entries(expected.dependencies).map(([name, value]) => [name, {
        version: value.version,
        integrity: value.integrity,
      }])),
      npmTree: dependencies.resolved,
      dependencyLockPath: path.relative(resolvedStateDir, dependencies.lockPath).split(path.sep).join('/'),
      normalizedAuthoredTreeSha256: normalizedAuthoredTree(pluginDir),
      files,
      artifact,
      hostContract,
      autoUpdate: false,
    };
    const reportPath = path.join(resolvedReportDir, `${expected.id}.json`);
    const next = `${reportPath}.next-${process.pid}`;
    fs.writeFileSync(next, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(next, reportPath);
    fs.chmodSync(reportPath, 0o600);
    reports.push(report);
  }
  verifyManagedStateEntries({
    stateDir: resolvedStateDir,
    registeredPackageDirs,
    openClawPackageRoot,
    allowReviewedRuntimeLink,
  });
  return reports;
}

function main() {
  const [reportDirArg, privateArtifactPathArg, upstreamArtifactPathArg, patchedArtifactPathArg, patchPathArg] = process.argv.slice(2);
  if (!reportDirArg || !privateArtifactPathArg || !upstreamArtifactPathArg || !patchedArtifactPathArg || !patchPathArg) {
    throw new Error('usage: audit-managed-install.mjs <report-directory> <private-crm.tgz> <upstream-weixin.tgz> <patched-weixin.tgz> <reviewed-patch.json>');
  }
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  if (!stateDir || !path.isAbsolute(stateDir)) throw new Error('OPENCLAW_STATE_DIR must be an absolute path');
  const auditMode = process.env.OPENCLAW_AUDIT_MODE ?? 'strict';
  if (auditMode !== 'strict' && auditMode !== 'live') {
    throw new Error('OPENCLAW_AUDIT_MODE must be strict or live');
  }
  auditManagedInstall({
    reportDir: reportDirArg,
    privateArtifactPath: privateArtifactPathArg,
    upstreamArtifactPath: upstreamArtifactPathArg,
    patchedArtifactPath: patchedArtifactPathArg,
    patchPath: patchPathArg,
    stateDir,
    stateDbPath: path.join(stateDir, 'state', 'openclaw.sqlite'),
    allowReviewedRuntimeLink: auditMode === 'live',
  });
  process.stdout.write('managed private and Tencent npm-pack plugin trees/install records verified\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
