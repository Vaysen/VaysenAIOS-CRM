import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  EXPECTED_PRIVATE_CRM,
  hashFile,
  readNpmPackFiles,
  readOpenClawInstallRecords,
  sha512Integrity,
  verifyDependencies,
  verifyManagedStateEntries,
  verifyNpmPackSupplyChain,
  verifyPrivateNpmPackSupplyChain,
} from '../audit-managed-install.mjs';

const PACKAGE_NAME = '@tencent-weixin/openclaw-weixin';
const VERSION = '2.4.6';
const PLUGIN_ID = 'openclaw-weixin';

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function treeSha256(files) {
  const records = [...files.keys()].sort().map((relative) => {
    const content = files.get(relative);
    return `${relative}\0${content.length}\0${createHash('sha256').update(content).digest('hex')}`;
  });
  return createHash('sha256').update(`${records.join('\n')}\n`, 'utf8').digest('hex');
}

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vaysen-openclaw-audit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceDir = path.join(root, 'source');
  const artifactDir = path.join(root, 'supply-chain', 'artifacts');
  const pluginDir = path.join(root, 'state', 'npm', 'projects', 'fixture', 'node_modules', '@tencent-weixin', 'openclaw-weixin');
  fs.mkdirSync(path.join(sourceDir, 'dist'), { recursive: true });
  fs.mkdirSync(artifactDir, { recursive: true });
  writeJson(path.join(sourceDir, 'package.json'), {
    name: PACKAGE_NAME,
    version: VERSION,
    type: 'module',
    files: ['dist/', 'npm-shrinkwrap.json', 'openclaw.plugin.json'],
    openclaw: { runtimeExtensions: ['./dist/index.js'] },
  });
  writeJson(path.join(sourceDir, 'npm-shrinkwrap.json'), {
    name: PACKAGE_NAME,
    version: VERSION,
    lockfileVersion: 3,
    requires: true,
    packages: { '': { name: PACKAGE_NAME, version: VERSION } },
  });
  writeJson(path.join(sourceDir, 'openclaw.plugin.json'), { id: PLUGIN_ID, name: 'Fixture Weixin' });
  fs.writeFileSync(path.join(sourceDir, 'dist', 'index.js'), 'export default { id: "openclaw-weixin" };\n', 'utf8');

  const packed = spawnSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['pack', '--ignore-scripts', '--json', '--pack-destination', artifactDir],
    {
      cwd: sourceDir,
      encoding: 'utf8',
      env: { ...process.env, npm_config_update_notifier: 'false' },
      shell: process.platform === 'win32',
    },
  );
  assert.equal(packed.status, 0, packed.stderr || packed.stdout);
  const metadata = JSON.parse(packed.stdout);
  assert.equal(metadata.length, 1);
  const upstreamArtifactPath = path.resolve(artifactDir, metadata[0].filename);
  const patchedArtifactPath = path.join(artifactDir, 'fixture-patched.tgz');
  fs.copyFileSync(upstreamArtifactPath, patchedArtifactPath);
  const patchPath = path.join(root, 'reviewed-patch.json');
  const artifactFiles = readNpmPackFiles(patchedArtifactPath);
  for (const [relative, content] of artifactFiles) {
    const target = path.join(pluginDir, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }

  const upstreamIntegrity = sha512Integrity(upstreamArtifactPath);
  const upstreamShasum = hashFile(upstreamArtifactPath, 'sha1');
  const upstreamSha256 = hashFile(upstreamArtifactPath, 'sha256');
  const integrity = sha512Integrity(patchedArtifactPath);
  const shasum = hashFile(patchedArtifactPath, 'sha1');
  const patchedSha256 = hashFile(patchedArtifactPath, 'sha256');
  const patchedTreeSha256 = treeSha256(artifactFiles);
  writeJson(patchPath, {
    schemaVersion: 1,
    packageName: PACKAGE_NAME,
    version: VERSION,
    upstream: { integrity: upstreamIntegrity, sha1: upstreamShasum, sha256: upstreamSha256 },
    patched: { integrity, sha1: shasum, sha256: patchedSha256, treeSha256: patchedTreeSha256 },
    files: {},
    addFiles: {},
  });
  const expected = {
    id: PLUGIN_ID,
    packageName: PACKAGE_NAME,
    version: VERSION,
    upstreamIntegrity,
    upstreamShasum,
    upstreamSha256,
    patchSha256: hashFile(patchPath, 'sha256'),
    patchedIntegrity: integrity,
    patchedShasum: shasum,
    patchedSha256,
    patchedTreeSha256,
  };
  const resolvedSpec = `${PACKAGE_NAME}@${VERSION}`;
  const installRecord = {
    source: 'npm',
    spec: resolvedSpec,
    sourcePath: patchedArtifactPath,
    installPath: path.resolve(pluginDir),
    version: VERSION,
    resolvedName: PACKAGE_NAME,
    resolvedVersion: VERSION,
    resolvedSpec,
    integrity,
    shasum,
    artifactKind: 'npm-pack',
    artifactFormat: 'tgz',
    npmIntegrity: integrity,
    npmShasum: shasum,
    npmTarballName: 'tencent-weixin-openclaw-weixin-2.4.6.tgz',
  };
  return { root, upstreamArtifactPath, patchedArtifactPath, patchPath, pluginDir, expected, installRecord };
}

test('accepts a byte-pinned npm-pack, matching install record, and identical published tree', (t) => {
  const fixture = createFixture(t);
  const result = verifyNpmPackSupplyChain(fixture);
  assert.equal(result.upstream.integrity, fixture.expected.upstreamIntegrity);
  assert.equal(result.patched.integrity, fixture.expected.patchedIntegrity);
  assert.equal(result.installRecord.artifactKind, 'npm-pack');
  assert.ok(result.patched.published.files['dist/index.js']);
});

test('rejects a tgz changed after its expected integrity was recorded', (t) => {
  const fixture = createFixture(t);
  fs.appendFileSync(fixture.upstreamArtifactPath, Buffer.from([0x00]));
  assert.throws(
    () => verifyNpmPackSupplyChain(fixture),
    /upstream npm-pack artifact integrity mismatch/,
  );
});

test('rejects changed managed top-level code even when package identity still matches', (t) => {
  const fixture = createFixture(t);
  fs.writeFileSync(path.join(fixture.pluginDir, 'dist', 'index.js'), 'export default { compromised: true };\n');
  assert.throws(
    () => verifyNpmPackSupplyChain(fixture),
    /managed published file mismatch: dist\/index\.js/,
  );
});

test('rejects an OpenClaw npm-pack install record with mismatched integrity facts', (t) => {
  const fixture = createFixture(t);
  fixture.installRecord = { ...fixture.installRecord, npmIntegrity: 'sha512-not-the-artifact' };
  assert.throws(
    () => verifyNpmPackSupplyChain(fixture),
    /OpenClaw install record npmIntegrity mismatch/,
  );
});

test('rejects the external artifact basename in place of npm canonical tarball metadata', (t) => {
  const fixture = createFixture(t);
  fixture.installRecord = { ...fixture.installRecord, npmTarballName: path.basename(fixture.patchedArtifactPath) };
  assert.throws(
    () => verifyNpmPackSupplyChain(fixture),
    /npmTarballName mismatch.*tencent-weixin-openclaw-weixin-2\.4\.6\.tgz.*fixture-patched\.tgz/,
  );
});

function privateNpmPackFixture(t) {
  const fixture = createFixture(t);
  return {
    ...fixture,
    artifactPath: fixture.patchedArtifactPath,
    expected: {
      ...fixture.expected,
      artifactIntegrity: fixture.expected.patchedIntegrity,
      artifactShasum: fixture.expected.patchedShasum,
      artifactSha256: fixture.expected.patchedSha256,
      artifactTreeSha256: fixture.expected.patchedTreeSha256,
    },
  };
}

test('accepts a pinned private npm-pack, matching install record, and identical managed tree', (t) => {
  const fixture = privateNpmPackFixture(t);
  const result = verifyPrivateNpmPackSupplyChain(fixture);
  assert.equal(result.private.integrity, fixture.expected.artifactIntegrity);
  assert.equal(result.installRecord.sourcePath, fixture.artifactPath);
});

test('rejects a private npm-pack install record with the wrong source path', (t) => {
  const fixture = privateNpmPackFixture(t);
  fixture.installRecord = { ...fixture.installRecord, sourcePath: `${fixture.artifactPath}.other` };
  assert.throws(
    () => verifyPrivateNpmPackSupplyChain(fixture),
    /sourcePath mismatch/,
  );
});

test('rejects a private managed tree changed after npm-pack installation', (t) => {
  const fixture = privateNpmPackFixture(t);
  fs.writeFileSync(path.join(fixture.pluginDir, 'dist', 'index.js'), 'export default { compromised: true };\n');
  assert.throws(
    () => verifyPrivateNpmPackSupplyChain(fixture),
    /managed published file mismatch/,
  );
});

test('reads the 2026.7.1 install record from state/openclaw.sqlite installed_plugin_index', (t) => {
  const fixture = createFixture(t);
  const databasePath = path.join(fixture.root, 'state', 'openclaw.sqlite');
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  try {
    database.exec(`
      CREATE TABLE installed_plugin_index (
        index_key TEXT NOT NULL PRIMARY KEY,
        install_records_json TEXT NOT NULL
      )
    `);
    database.prepare(
      'INSERT INTO installed_plugin_index (index_key, install_records_json) VALUES (?, ?)',
    ).run('installed-plugin-index', JSON.stringify({ [PLUGIN_ID]: fixture.installRecord }));
  } finally {
    database.close();
  }
  const records = readOpenClawInstallRecords(databasePath);
  assert.equal(records[PLUGIN_ID].artifactKind, 'npm-pack');
  assert.equal(records[PLUGIN_ID].npmIntegrity, fixture.expected.patchedIntegrity);
  assert.equal(records[PLUGIN_ID].npmShasum, fixture.installRecord.npmShasum);
  assert.equal(records[PLUGIN_ID].npmTarballName, 'tencent-weixin-openclaw-weixin-2.4.6.tgz');
});

function createPrivateDependencyFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vaysen-openclaw-private-deps-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectRoot = path.join(root, 'managed-project');
  const pluginDir = path.join(projectRoot, 'node_modules', '@vaysen', 'openclaw-crm-tools');
  const typeboxDir = path.join(projectRoot, 'node_modules', 'typebox');
  const trimmedOpenClawRoot = path.join(root, 'trimmed-openclaw');
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.mkdirSync(typeboxDir, { recursive: true });
  fs.mkdirSync(trimmedOpenClawRoot, { recursive: true });
  writeJson(path.join(projectRoot, 'package.json'), {
    name: 'managed-private-fixture',
    version: '1.0.0',
    private: true,
    dependencies: { '@vaysen/openclaw-crm-tools': EXPECTED_PRIVATE_CRM.version },
  });
  writeJson(path.join(pluginDir, 'package.json'), {
    name: EXPECTED_PRIVATE_CRM.packageName,
    version: EXPECTED_PRIVATE_CRM.version,
    dependencies: { typebox: EXPECTED_PRIVATE_CRM.dependencies.typebox.spec },
    peerDependencies: { openclaw: '>=2026.7.1 <2026.8.0' },
  });
  writeJson(path.join(typeboxDir, 'package.json'), {
    name: 'typebox',
    version: EXPECTED_PRIVATE_CRM.dependencies.typebox.version,
  });
  writeJson(path.join(trimmedOpenClawRoot, 'package.json'), {
    name: 'openclaw',
    version: '2026.7.1',
    dependencies: { 'image-build-only-missing-package': '1.0.0' },
  });
  const peerLink = path.join(pluginDir, 'node_modules', 'openclaw');
  fs.mkdirSync(path.dirname(peerLink), { recursive: true });
  fs.symlinkSync(trimmedOpenClawRoot, peerLink, process.platform === 'win32' ? 'junction' : 'dir');
  const lockPath = path.join(projectRoot, 'package-lock.json');
  writeJson(lockPath, {
    name: 'managed-private-fixture',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': {
        name: 'managed-private-fixture',
        version: '1.0.0',
        dependencies: { '@vaysen/openclaw-crm-tools': EXPECTED_PRIVATE_CRM.version },
      },
      'node_modules/@vaysen/openclaw-crm-tools': {
        version: EXPECTED_PRIVATE_CRM.version,
        dependencies: { typebox: EXPECTED_PRIVATE_CRM.dependencies.typebox.spec },
      },
      'node_modules/typebox': {
        version: EXPECTED_PRIVATE_CRM.dependencies.typebox.version,
        integrity: EXPECTED_PRIVATE_CRM.dependencies.typebox.integrity,
      },
    },
  });
  return {
    projectRoot,
    pluginDir,
    typeboxDir,
    typeboxPackagePath: path.join(typeboxDir, 'package.json'),
    lockPath,
  };
}

test('verifies the private managed typebox tree without recursively auditing the trimmed host peer', (t) => {
  const fixture = createPrivateDependencyFixture(t);
  const result = verifyDependencies(fixture.pluginDir, fixture.projectRoot, EXPECTED_PRIVATE_CRM);
  assert.equal(result.resolved.typebox, '1.3.3');
});

test('rejects an extraneous top-level managed dependency at depth zero', (t) => {
  const fixture = createPrivateDependencyFixture(t);
  const unexpected = path.join(fixture.projectRoot, 'node_modules', 'unexpected-managed-package');
  fs.mkdirSync(unexpected, { recursive: true });
  writeJson(path.join(unexpected, 'package.json'), { name: 'unexpected-managed-package', version: '1.0.0' });
  assert.throws(
    () => verifyDependencies(fixture.pluginDir, fixture.projectRoot, EXPECTED_PRIVATE_CRM),
    /managed plugin npm dependency tree has problems/,
  );
});

test('rejects a private managed install with typebox missing', (t) => {
  const fixture = createPrivateDependencyFixture(t);
  fs.unlinkSync(fixture.typeboxPackagePath);
  assert.equal(fs.existsSync(fixture.typeboxPackagePath), false);
  assert.throws(
    () => verifyDependencies(fixture.pluginDir, fixture.projectRoot, EXPECTED_PRIVATE_CRM),
    /vaysen-crm\/typebox: managed plugin dependency is missing/,
  );
});

test('rejects a private managed dependency with a spoofed package identity', (t) => {
  const fixture = createPrivateDependencyFixture(t);
  writeJson(fixture.typeboxPackagePath, {
    name: 'not-typebox',
    version: EXPECTED_PRIVATE_CRM.dependencies.typebox.version,
  });
  assert.throws(
    () => verifyDependencies(fixture.pluginDir, fixture.projectRoot, EXPECTED_PRIVATE_CRM),
    /resolved dependency identity mismatch: vaysen-crm\/typebox/,
  );
});

test('rejects a private managed leaf dependency with nested packages', (t) => {
  const fixture = createPrivateDependencyFixture(t);
  const nested = path.join(fixture.typeboxDir, 'node_modules', 'unexpected-nested-package');
  fs.mkdirSync(nested, { recursive: true });
  writeJson(path.join(nested, 'package.json'), { name: 'unexpected-nested-package', version: '1.0.0' });
  assert.throws(
    () => verifyDependencies(fixture.pluginDir, fixture.projectRoot, EXPECTED_PRIVATE_CRM),
    /managed leaf dependency contains nested packages: typebox/,
  );
});

test('rejects an extra lock-only package outside the reviewed dependency closure', (t) => {
  const fixture = createPrivateDependencyFixture(t);
  const lock = JSON.parse(fs.readFileSync(fixture.lockPath, 'utf8'));
  lock.packages['node_modules/lock-only-package'] = { version: '1.0.0' };
  writeJson(fixture.lockPath, lock);
  assert.throws(
    () => verifyDependencies(fixture.pluginDir, fixture.projectRoot, EXPECTED_PRIVATE_CRM),
    /lock package closure mismatch: vaysen-crm/,
  );
});

test('rejects a managed dependency lock with an unsupported lockfile version', (t) => {
  const fixture = createPrivateDependencyFixture(t);
  const lock = JSON.parse(fs.readFileSync(fixture.lockPath, 'utf8'));
  lock.lockfileVersion = 2;
  writeJson(fixture.lockPath, lock);
  assert.throws(
    () => verifyDependencies(fixture.pluginDir, fixture.projectRoot, EXPECTED_PRIVATE_CRM),
    /lockfile version mismatch: vaysen-crm/,
  );
});

test('rejects a private managed install with a changed typebox lock integrity', (t) => {
  const fixture = createPrivateDependencyFixture(t);
  const lock = JSON.parse(fs.readFileSync(fixture.lockPath, 'utf8'));
  lock.packages['node_modules/typebox'].integrity = 'sha512-not-reviewed';
  writeJson(fixture.lockPath, lock);
  assert.throws(
    () => verifyDependencies(fixture.pluginDir, fixture.projectRoot, EXPECTED_PRIVATE_CRM),
    /lock integrity mismatch: vaysen-crm\/typebox/,
  );
});

test('rejects a private managed install with a changed typebox lock version', (t) => {
  const fixture = createPrivateDependencyFixture(t);
  const lock = JSON.parse(fs.readFileSync(fixture.lockPath, 'utf8'));
  lock.packages['node_modules/typebox'].version = '1.1.38';
  writeJson(fixture.lockPath, lock);
  assert.throws(
    () => verifyDependencies(fixture.pluginDir, fixture.projectRoot, EXPECTED_PRIVATE_CRM),
    /lock version mismatch: vaysen-crm\/typebox/,
  );
});

function createPeerLinkFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vaysen-openclaw-peer-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stateDir = path.join(root, 'state');
  const openClawPackageRoot = path.join(root, 'image-openclaw');
  const packageDir = path.join(stateDir, 'extensions', 'fixture-plugin');
  const nodeModules = path.join(packageDir, 'node_modules');
  fs.mkdirSync(path.join(openClawPackageRoot, 'dist'), { recursive: true });
  fs.mkdirSync(nodeModules, { recursive: true });
  writeJson(path.join(openClawPackageRoot, 'package.json'), { name: 'openclaw', version: '2026.7.1' });
  fs.writeFileSync(path.join(openClawPackageRoot, 'dist', 'index.js'), 'export {}\n');
  writeJson(path.join(packageDir, 'package.json'), {
    name: '@fixture/openclaw-plugin',
    peerDependencies: { openclaw: '>=2026.7.1 <2026.8.0' },
  });
  const peerLink = path.join(nodeModules, 'openclaw');
  fs.symlinkSync(openClawPackageRoot, peerLink, process.platform === 'win32' ? 'junction' : 'dir');
  return { root, stateDir, openClawPackageRoot, packageDir, nodeModules, peerLink };
}

test('allows only the registered plugin-local OpenClaw peer link to the image package root', (t) => {
  const fixture = createPeerLinkFixture(t);
  const result = verifyManagedStateEntries({
    stateDir: fixture.stateDir,
    registeredPackageDirs: [fixture.packageDir],
    openClawPackageRoot: fixture.openClawPackageRoot,
  });
  assert.deepEqual(result.allowedPeerLinks, [path.resolve(fixture.peerLink)]);
});

test('allows the empty real npm .bin directory produced by generation reinstall', (t) => {
  const fixture = createPeerLinkFixture(t);
  fs.mkdirSync(path.join(fixture.nodeModules, '.bin'));
  const result = verifyManagedStateEntries({
    stateDir: fixture.stateDir,
    registeredPackageDirs: [fixture.packageDir],
    openClawPackageRoot: fixture.openClawPackageRoot,
  });
  assert.deepEqual(result.allowedPeerLinks, [path.resolve(fixture.peerLink)]);
});

function createReviewedRuntimeLink(fixture, targetName = 'browser-automation') {
  const target = path.join(fixture.openClawPackageRoot, 'dist', 'extensions', 'browser', 'skills', targetName);
  const runtimeLink = path.join(fixture.stateDir, 'plugin-skills', 'browser-automation');
  fs.mkdirSync(target, { recursive: true });
  fs.mkdirSync(path.dirname(runtimeLink), { recursive: true });
  fs.symlinkSync(target, runtimeLink, process.platform === 'win32' ? 'junction' : 'dir');
  return { runtimeLink, target, rawTarget: fs.readlinkSync(runtimeLink, 'utf8') };
}

test('live audit allows only the exact reviewed OpenClaw browser skill link', (t) => {
  const fixture = createPeerLinkFixture(t);
  const { runtimeLink, rawTarget } = createReviewedRuntimeLink(fixture);
  const result = verifyManagedStateEntries({
    stateDir: fixture.stateDir,
    registeredPackageDirs: [fixture.packageDir],
    openClawPackageRoot: fixture.openClawPackageRoot,
    allowReviewedRuntimeLink: true,
    reviewedRuntimeLink: { relativePath: 'plugin-skills/browser-automation', target: rawTarget },
  });
  assert.deepEqual(result.allowedPeerLinks, [path.resolve(fixture.peerLink)]);
  assert.deepEqual(result.allowedRuntimeLinks, [path.resolve(runtimeLink)]);
});

test('strict audit still rejects the reviewed OpenClaw browser skill link', (t) => {
  const fixture = createPeerLinkFixture(t);
  createReviewedRuntimeLink(fixture);
  assert.throws(
    () => verifyManagedStateEntries({
      stateDir: fixture.stateDir,
      registeredPackageDirs: [fixture.packageDir],
      openClawPackageRoot: fixture.openClawPackageRoot,
    }),
    /unapproved symbolic link/,
  );
});

test('live audit rejects a browser skill link with a changed target', (t) => {
  const fixture = createPeerLinkFixture(t);
  const { rawTarget } = createReviewedRuntimeLink(fixture, 'not-reviewed');
  assert.throws(
    () => verifyManagedStateEntries({
      stateDir: fixture.stateDir,
      registeredPackageDirs: [fixture.packageDir],
      openClawPackageRoot: fixture.openClawPackageRoot,
      allowReviewedRuntimeLink: true,
      reviewedRuntimeLink: { relativePath: 'plugin-skills/browser-automation', target: `${rawTarget}-changed` },
    }),
    /runtime link target mismatch/,
  );
});

test('live audit rejects a regular file at the reviewed runtime-link path', (t) => {
  const fixture = createPeerLinkFixture(t);
  const runtimeLink = path.join(fixture.stateDir, 'plugin-skills', 'browser-automation');
  fs.mkdirSync(path.dirname(runtimeLink), { recursive: true });
  fs.writeFileSync(runtimeLink, 'not a link\n');
  assert.throws(
    () => verifyManagedStateEntries({
      stateDir: fixture.stateDir,
      registeredPackageDirs: [fixture.packageDir],
      openClawPackageRoot: fixture.openClawPackageRoot,
      allowReviewedRuntimeLink: true,
    }),
    /must be a symbolic link/,
  );
});

test('rejects content inside the generation reinstall npm .bin directory', (t) => {
  const fixture = createPeerLinkFixture(t);
  const localBin = path.join(fixture.nodeModules, '.bin');
  fs.mkdirSync(localBin);
  fs.writeFileSync(path.join(localBin, 'unexpected-command'), 'not executable\n');
  assert.throws(
    () => verifyManagedStateEntries({
      stateDir: fixture.stateDir,
      registeredPackageDirs: [fixture.packageDir],
      openClawPackageRoot: fixture.openClawPackageRoot,
    }),
    /non-empty plugin-local \.bin directory/,
  );
});

test('rejects a linked generation reinstall npm .bin directory', (t) => {
  const fixture = createPeerLinkFixture(t);
  const externalBin = path.join(fixture.root, 'external-bin');
  fs.mkdirSync(externalBin);
  fs.symlinkSync(externalBin, path.join(fixture.nodeModules, '.bin'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(
    () => verifyManagedStateEntries({
      stateDir: fixture.stateDir,
      registeredPackageDirs: [fixture.packageDir],
      openClawPackageRoot: fixture.openClawPackageRoot,
    }),
    /unsafe plugin-local \.bin directory/,
  );
});

test('rejects a registered peer link that targets arbitrary state', (t) => {
  const fixture = createPeerLinkFixture(t);
  fs.unlinkSync(fixture.peerLink);
  fs.symlinkSync(fixture.stateDir, fixture.peerLink, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(
    () => verifyManagedStateEntries({
      stateDir: fixture.stateDir,
      registeredPackageDirs: [fixture.packageDir],
      openClawPackageRoot: fixture.openClawPackageRoot,
    }),
    /peer target mismatch/,
  );
});

test('rejects every extra link even when the approved peer link is valid', (t) => {
  const fixture = createPeerLinkFixture(t);
  fs.symlinkSync(fixture.openClawPackageRoot, path.join(fixture.stateDir, 'extra-link'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(
    () => verifyManagedStateEntries({
      stateDir: fixture.stateDir,
      registeredPackageDirs: [fixture.packageDir],
      openClawPackageRoot: fixture.openClawPackageRoot,
    }),
    /unapproved symbolic link/,
  );
});

test('rejects every extra regular package in plugin-local node_modules', (t) => {
  const fixture = createPeerLinkFixture(t);
  const unexpected = path.join(fixture.nodeModules, 'unexpected-regular-package');
  fs.mkdirSync(unexpected);
  writeJson(path.join(unexpected, 'package.json'), { name: 'unexpected-regular-package', version: '1.0.0' });
  assert.throws(
    () => verifyManagedStateEntries({
      stateDir: fixture.stateDir,
      registeredPackageDirs: [fixture.packageDir],
      openClawPackageRoot: fixture.openClawPackageRoot,
    }),
    /unexpected plugin-local node_modules entry/,
  );
});

test('rejects node_modules itself when it is a link', (t) => {
  const fixture = createPeerLinkFixture(t);
  fs.unlinkSync(fixture.peerLink);
  fs.rmdirSync(fixture.nodeModules);
  const externalNodeModules = path.join(fixture.root, 'external-node-modules');
  fs.mkdirSync(externalNodeModules);
  fs.symlinkSync(externalNodeModules, fixture.nodeModules, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(
    () => verifyManagedStateEntries({
      stateDir: fixture.stateDir,
      registeredPackageDirs: [fixture.packageDir],
      openClawPackageRoot: fixture.openClawPackageRoot,
    }),
    /unsafe plugin-local node_modules directory/,
  );
});
