import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  deriveRuntimeLinkContract,
  serializeV2Manifest,
  verifyRuntimeLinkManifest,
  verifyRuntimeLinkTree,
} from './runtime-link-contract.mjs';

const SCRIPT = fileURLToPath(new URL('./runtime-link-contract.mjs', import.meta.url));
const CONTAINER_ROOT = '/home/node/.openclaw/npm/projects';
const SPECS = Object.freeze({
  'vaysen-crm': Object.freeze({
    packageName: '@vaysen/openclaw-crm-tools',
    version: '1.1.0',
    projectBase: 'vaysen-openclaw-crm-tools-f0ac731cd3',
  }),
  'openclaw-weixin': Object.freeze({
    packageName: '@tencent-weixin/openclaw-weixin',
    version: '2.4.6',
    projectBase: 'tencent-weixin-openclaw-weixin-7783ac86ba',
  }),
});

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function generationProject(base, id) {
  return `${base}__openclaw-generation__g-${id}`;
}

function createFixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vaysen-crm-runtime-links-'));
  const stateRoot = path.join(root, 'openclaw');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const records = {};
  const peers = new Map();
  const layouts = options.layouts ?? {};

  for (const [pluginId, spec] of Object.entries(SPECS)) {
    const project = layouts[pluginId] ?? spec.projectBase;
    const installPath = options.installPaths?.[pluginId]
      ?? `${CONTAINER_ROOT}/${project}/node_modules/${spec.packageName}`;
    const expectedSpec = `${spec.packageName}@${spec.version}`;
    records[pluginId] = {
      source: 'npm',
      spec: expectedSpec,
      installPath,
      version: spec.version,
      resolvedName: spec.packageName,
      resolvedVersion: spec.version,
      resolvedSpec: expectedSpec,
      ...(options.recordOverrides?.[pluginId] ?? {}),
    };

    const packageDir = path.join(
      stateRoot,
      'npm',
      'projects',
      project,
      'node_modules',
      ...spec.packageName.split('/'),
    );
    writeJson(path.join(packageDir, 'package.json'), {
      name: spec.packageName,
      version: options.packageVersions?.[pluginId] ?? spec.version,
    });
    const peer = path.join(packageDir, 'node_modules', 'openclaw');
    fs.mkdirSync(path.dirname(peer), { recursive: true });
    fs.writeFileSync(peer, 'virtual symlink placeholder\n', 'utf8');
    peers.set(path.resolve(peer), '/app');
  }

  if (options.extraRecord) records.unreviewed = options.extraRecord;
  const databasePath = path.join(stateRoot, 'state', 'openclaw.sqlite');
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
    ).run('installed-plugin-index', JSON.stringify(records));
  } finally {
    database.close();
  }
  return { root, stateRoot, databasePath, peers, records };
}

function virtualLinkFileSystem(peers, lstatOverrides = new Map()) {
  return {
    lstatSync(file) {
      const resolved = path.resolve(file);
      const override = lstatOverrides.get(resolved);
      if (override) return override(fs.lstatSync(resolved));
      if (peers.has(resolved)) {
        return {
          isDirectory: () => false,
          isFile: () => false,
          isSymbolicLink: () => true,
        };
      }
      return fs.lstatSync(resolved);
    },
    readFileSync: fs.readFileSync,
    readdirSync: fs.readdirSync,
    readlinkSync(file) {
      const resolved = path.resolve(file);
      if (!peers.has(resolved)) throw new Error(`not a virtual link: ${resolved}`);
      return peers.get(resolved);
    },
  };
}

function writeManifest(root, name, content) {
  const file = path.join(root, name);
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

test('derives a deterministic v2 manifest from stable project roots and accepts v1/v2', (t) => {
  const fixture = createFixture(t);
  const contract = deriveRuntimeLinkContract(fixture.stateRoot);
  assert.equal(contract.schemaVersion, 2);
  assert.deepEqual(contract.links.map((link) => link.pluginId), ['vaysen-crm', 'openclaw-weixin']);
  assert.deepEqual(contract.links.map((link) => link.target), ['/app', '/app']);

  const v2 = writeManifest(fixture.root, '.vaysen-crm-runtime-links-v2.json', serializeV2Manifest(contract));
  const v1 = writeManifest(
    fixture.root,
    '.vaysen-crm-runtime-links-v1',
    `${contract.links.map(({ relativePath }) => relativePath).reverse().join('\r\n')}\r\n`,
  );
  const expected = contract.links.map(({ relativePath }) => relativePath);
  assert.deepEqual(verifyRuntimeLinkManifest(fixture.stateRoot, v2), expected);
  assert.deepEqual(verifyRuntimeLinkManifest(fixture.stateRoot, v1), expected);
});

test('accepts generation and mixed active install layouts and verifies the exact peer-link tree', async (t) => {
  const layouts = [
    {
      'vaysen-crm': generationProject(SPECS['vaysen-crm'].projectBase, 'c8c77eb604dd2228'),
      'openclaw-weixin': generationProject(SPECS['openclaw-weixin'].projectBase, 'da663653010cdc3b'),
    },
    {
      'vaysen-crm': SPECS['vaysen-crm'].projectBase,
      'openclaw-weixin': generationProject(SPECS['openclaw-weixin'].projectBase, '0123456789abcdef'),
    },
  ];
  for (const [index, layout] of layouts.entries()) {
    await t.test(`layout ${index + 1}`, (st) => {
      const fixture = createFixture(st, { layouts: layout });
      const contract = deriveRuntimeLinkContract(fixture.stateRoot);
      assert.deepEqual(
        verifyRuntimeLinkTree(fixture.stateRoot, { fileSystem: virtualLinkFileSystem(fixture.peers) }),
        contract.links.map(({ relativePath }) => relativePath),
      );
    });
  }
});

test('accepts the exact previous CRM plugin during rollback backup and records its actual version', (t) => {
  const legacySpec = '@vaysen/openclaw-crm-tools@1.0.0';
  const fixture = createFixture(t, {
    packageVersions: { 'vaysen-crm': '1.0.0' },
    recordOverrides: {
      'vaysen-crm': {
        spec: legacySpec,
        version: '1.0.0',
        resolvedVersion: '1.0.0',
        resolvedSpec: legacySpec,
      },
    },
  });
  const contract = deriveRuntimeLinkContract(fixture.stateRoot);
  assert.equal(contract.links.find(({ pluginId }) => pluginId === 'vaysen-crm')?.version, '1.0.0');
  assert.deepEqual(
    verifyRuntimeLinkTree(fixture.stateRoot, { fileSystem: virtualLinkFileSystem(fixture.peers) }),
    contract.links.map(({ relativePath }) => relativePath),
  );
});

test('CLI emit-v2 and verify-manifest have stdout-only deterministic success contracts', (t) => {
  const fixture = createFixture(t, {
    layouts: {
      'vaysen-crm': generationProject(SPECS['vaysen-crm'].projectBase, '1111111111111111'),
    },
  });
  const cliOptions = { encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' } };
  const emitted = spawnSync(process.execPath, [SCRIPT, 'emit-v2', fixture.stateRoot], cliOptions);
  assert.equal(emitted.status, 0, emitted.stderr);
  assert.equal(emitted.stderr, '');
  const parsed = JSON.parse(emitted.stdout);
  assert.equal(parsed.schemaVersion, 2);
  const manifest = writeManifest(fixture.root, 'cli-v2.json', emitted.stdout);
  const verified = spawnSync(
    process.execPath,
    [SCRIPT, 'verify-manifest', fixture.stateRoot, manifest],
    cliOptions,
  );
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(verified.stderr, '');
  assert.deepEqual(
    verified.stdout.trimEnd().split(/\r?\n/),
    parsed.links.map(({ relativePath }) => relativePath),
  );
});

test('rejects a symlinked or special OpenClaw database before SQLite reads it', (t) => {
  const fixture = createFixture(t);
  const symlinkStats = new Map([[
    path.resolve(fixture.databasePath),
    () => ({
      isDirectory: () => false,
      isFile: () => false,
      isSymbolicLink: () => true,
    }),
  ]]);
  assert.throws(
    () => deriveRuntimeLinkContract(fixture.stateRoot, {
      fileSystem: virtualLinkFileSystem(new Map(), symlinkStats),
    }),
    /database must be a regular non-symlink file/,
  );

  fs.unlinkSync(fixture.databasePath);
  assert.equal(fs.existsSync(fixture.databasePath), false);
  fs.mkdirSync(fixture.databasePath);
  assert.throws(
    () => deriveRuntimeLinkContract(fixture.stateRoot),
    /database must be a regular non-symlink file/,
  );
});

test('rejects escaped, wrong-hash, malformed-generation, and wrong-package install paths', async (t) => {
  const invalidPaths = [
    `${CONTAINER_ROOT}/${SPECS['vaysen-crm'].projectBase}/node_modules/${SPECS['vaysen-crm'].packageName}/../../escape`,
    `${CONTAINER_ROOT}/vaysen-openclaw-crm-tools-deadbeef00/node_modules/${SPECS['vaysen-crm'].packageName}`,
    `${CONTAINER_ROOT}/${SPECS['vaysen-crm'].projectBase}__openclaw-generation__g-ABCDEF0123456789/node_modules/${SPECS['vaysen-crm'].packageName}`,
    `${CONTAINER_ROOT}/${SPECS['vaysen-crm'].projectBase}/node_modules/@vaysen/wrong-package`,
  ];
  for (const [index, installPath] of invalidPaths.entries()) {
    await t.test(`invalid installPath ${index + 1}`, (st) => {
      const fixture = createFixture(st, { installPaths: { 'vaysen-crm': installPath } });
      assert.throws(
        () => deriveRuntimeLinkContract(fixture.stateRoot),
        /outside the reviewed project\/package grammar/,
      );
    });
  }
});

test('rejects wrong database and on-disk package identities and an extra managed record', async (t) => {
  await t.test('database source', (st) => {
    const fixture = createFixture(st, {
      recordOverrides: { 'openclaw-weixin': { source: 'path' } },
    });
    assert.throws(() => deriveRuntimeLinkContract(fixture.stateRoot), /source mismatch/);
  });
  await t.test('database name', (st) => {
    const fixture = createFixture(st, {
      recordOverrides: { 'openclaw-weixin': { resolvedName: '@tencent-weixin/not-reviewed' } },
    });
    assert.throws(() => deriveRuntimeLinkContract(fixture.stateRoot), /resolvedName mismatch/);
  });
  await t.test('database version', (st) => {
    const fixture = createFixture(st, {
      recordOverrides: { 'openclaw-weixin': { resolvedVersion: '2.4.7' } },
    });
    assert.throws(() => deriveRuntimeLinkContract(fixture.stateRoot), /resolvedVersion mismatch/);
  });
  await t.test('unreviewed CRM migration version', (st) => {
    const version = '1.2.2';
    const fixture = createFixture(st, {
      recordOverrides: {
        'vaysen-crm': {
          spec: `@vaysen/openclaw-crm-tools@${version}`,
          version,
          resolvedVersion: version,
          resolvedSpec: `@vaysen/openclaw-crm-tools@${version}`,
        },
      },
      packageVersions: { 'vaysen-crm': version },
    });
    assert.throws(() => deriveRuntimeLinkContract(fixture.stateRoot), /outside the reviewed migration set/);
  });
  await t.test('package.json version', (st) => {
    const fixture = createFixture(st, { packageVersions: { 'vaysen-crm': '9.9.9' } });
    assert.throws(() => deriveRuntimeLinkContract(fixture.stateRoot), /managed package identity mismatch/);
  });
  await t.test('extra record', (st) => {
    const fixture = createFixture(st, { extraRecord: { installPath: '/tmp/unreviewed' } });
    assert.throws(() => deriveRuntimeLinkContract(fixture.stateRoot), /exactly the two reviewed plugins/);
  });
});

test('rejects missing, extra, and wrong-target links in the runtime tree', async (t) => {
  await t.test('missing link', (st) => {
    const fixture = createFixture(st);
    const reduced = new Map([...fixture.peers.entries()].slice(0, 1));
    assert.throws(
      () => verifyRuntimeLinkTree(fixture.stateRoot, { fileSystem: virtualLinkFileSystem(reduced) }),
      /symlink set\/targets/,
    );
  });
  await t.test('extra link', (st) => {
    const fixture = createFixture(st);
    const extra = path.join(fixture.stateRoot, 'unreviewed', 'extra-link');
    fs.mkdirSync(path.dirname(extra), { recursive: true });
    fs.writeFileSync(extra, 'virtual extra link\n');
    const peers = new Map(fixture.peers).set(path.resolve(extra), '/app');
    assert.throws(
      () => verifyRuntimeLinkTree(fixture.stateRoot, { fileSystem: virtualLinkFileSystem(peers) }),
      /symlink set\/targets/,
    );
  });
  await t.test('wrong target', (st) => {
    const fixture = createFixture(st);
    const peers = new Map(fixture.peers);
    peers.set(peers.keys().next().value, '/tmp/not-openclaw');
    assert.throws(
      () => verifyRuntimeLinkTree(fixture.stateRoot, { fileSystem: virtualLinkFileSystem(peers) }),
      /symlink set\/targets/,
    );
  });
});

test('live-tree mode permits only the exact reviewed browser skill link', async (t) => {
  const transientRelative = path.join('plugin-skills', 'browser-automation');
  const transientPathFor = (fixture) => path.join(fixture.stateRoot, transientRelative);
  const reviewedTarget = '/app/dist/extensions/browser/skills/browser-automation';

  await t.test('exact reviewed link', (st) => {
    const fixture = createFixture(st);
    const transient = transientPathFor(fixture);
    fs.mkdirSync(path.dirname(transient), { recursive: true });
    fs.writeFileSync(transient, 'virtual transient link\n');
    const peers = new Map(fixture.peers).set(path.resolve(transient), reviewedTarget);
    const fileSystem = virtualLinkFileSystem(peers);
    assert.throws(() => verifyRuntimeLinkTree(fixture.stateRoot, { fileSystem }), /symlink set\/targets/);
    assert.doesNotThrow(() => verifyRuntimeLinkTree(fixture.stateRoot, {
      fileSystem,
      allowReviewedTransientLink: true,
    }));
  });

  await t.test('wrong target', (st) => {
    const fixture = createFixture(st);
    const transient = transientPathFor(fixture);
    fs.mkdirSync(path.dirname(transient), { recursive: true });
    fs.writeFileSync(transient, 'virtual transient link\n');
    const peers = new Map(fixture.peers).set(path.resolve(transient), '/tmp/not-reviewed');
    assert.throws(() => verifyRuntimeLinkTree(fixture.stateRoot, {
      fileSystem: virtualLinkFileSystem(peers),
      allowReviewedTransientLink: true,
    }), /target mismatch/);
  });

  await t.test('regular file', (st) => {
    const fixture = createFixture(st);
    const transient = transientPathFor(fixture);
    fs.mkdirSync(path.dirname(transient), { recursive: true });
    fs.writeFileSync(transient, 'not a link\n');
    assert.throws(() => verifyRuntimeLinkTree(fixture.stateRoot, {
      fileSystem: virtualLinkFileSystem(fixture.peers),
      allowReviewedTransientLink: true,
    }), /not a symlink/);
  });

  await t.test('unrelated extra link remains blocked', (st) => {
    const fixture = createFixture(st);
    const transient = transientPathFor(fixture);
    const extra = path.join(fixture.stateRoot, 'plugin-skills', 'unreviewed');
    fs.mkdirSync(path.dirname(transient), { recursive: true });
    fs.writeFileSync(transient, 'virtual transient link\n');
    fs.writeFileSync(extra, 'virtual extra link\n');
    const peers = new Map(fixture.peers)
      .set(path.resolve(transient), reviewedTarget)
      .set(path.resolve(extra), '/app');
    assert.throws(() => verifyRuntimeLinkTree(fixture.stateRoot, {
      fileSystem: virtualLinkFileSystem(peers),
      allowReviewedTransientLink: true,
    }), /symlink set\/targets/);
  });

  await t.test('special entry remains blocked', (st) => {
    const fixture = createFixture(st);
    const special = path.join(fixture.stateRoot, 'runtime-special-entry');
    fs.writeFileSync(special, 'fixture\n');
    const overrides = new Map([[
      path.resolve(special),
      () => ({
        isDirectory: () => false,
        isFile: () => false,
        isSymbolicLink: () => false,
      }),
    ]]);
    assert.throws(() => verifyRuntimeLinkTree(fixture.stateRoot, {
      fileSystem: virtualLinkFileSystem(fixture.peers, overrides),
      allowReviewedTransientLink: true,
    }), /special entry/);
  });
});

test('rejects v1/v2 manifest mismatches, duplicates, and unknown fields', async (t) => {
  const fixture = createFixture(t);
  const contract = deriveRuntimeLinkContract(fixture.stateRoot);
  await t.test('v1 duplicate', () => {
    const file = writeManifest(
      fixture.root,
      'bad-v1',
      `${contract.links[0].relativePath}\n${contract.links[0].relativePath}\n`,
    );
    assert.throws(() => verifyRuntimeLinkManifest(fixture.stateRoot, file), /does not match/);
  });
  await t.test('v2 path mismatch', () => {
    const changed = JSON.parse(serializeV2Manifest(contract));
    changed.links[0].relativePath = 'openclaw/npm/projects/wrong/node_modules/openclaw';
    const file = writeManifest(fixture.root, 'bad-v2-path.json', serializeV2Manifest(changed));
    assert.throws(() => verifyRuntimeLinkManifest(fixture.stateRoot, file), /does not match/);
  });
  await t.test('v2 unknown field', () => {
    const changed = JSON.parse(serializeV2Manifest(contract));
    changed.links[0].unreviewed = true;
    const file = writeManifest(fixture.root, 'bad-v2-field.json', serializeV2Manifest(changed));
    assert.throws(() => verifyRuntimeLinkManifest(fixture.stateRoot, file), /unexpected fields/);
  });
});

test('CLI rejects unknown commands and reports only a bounded error', () => {
  const result = spawnSync(process.execPath, [SCRIPT, 'unknown'], {
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /^\[RUNTIME LINK CONTRACT ERROR] usage:/);
});
