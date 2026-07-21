import assert from 'node:assert/strict';
import test from 'node:test';

import {
  verifyOpenClawHostContract,
} from '../verify-host-contract.mjs';

const packageJson = JSON.stringify({
  name: 'openclaw',
  version: '2026.7.1',
  dependencies: { typebox: '1.3.3' },
});
const workspace = `packages:\n  - .\n\noverrides:\n  typebox: 1.3.3\n  zod: 4.3.6\n`;
const installedTypeboxPackageJson = JSON.stringify({ name: 'typebox', version: '1.3.3' });

test('accepts the exact OpenClaw 2026.7.1 TypeBox dependency and workspace override', () => {
  assert.deepEqual(verifyOpenClawHostContract({
    packageJsonText: packageJson,
    workspaceText: workspace,
    installedTypeboxPackageJsonText: installedTypeboxPackageJson,
    expectedTypeboxVersion: '1.3.3',
  }), {
    package: 'openclaw@2026.7.1',
    typeboxDependency: '1.3.3',
    typeboxOverride: '1.3.3',
    installedTypebox: '1.3.3',
  });
});

test('rejects a changed OpenClaw host TypeBox dependency before plugin installation', () => {
  const changed = JSON.stringify({
    name: 'openclaw',
    version: '2026.7.1',
    dependencies: { typebox: '1.1.38' },
  });
  assert.throws(
    () => verifyOpenClawHostContract({
      packageJsonText: changed,
      workspaceText: workspace,
      installedTypeboxPackageJsonText: installedTypeboxPackageJson,
      expectedTypeboxVersion: '1.3.3',
    }),
    /host TypeBox dependency mismatch/,
  );
});

test('rejects a missing or changed OpenClaw workspace TypeBox override', () => {
  for (const changed of [
    'packages:\n  - .\n\noverrides:\n  zod: 4.3.6\n',
    'packages:\n  - .\n\noverrides:\n  typebox: 1.1.38\n',
  ]) {
    assert.throws(
      () => verifyOpenClawHostContract({
        packageJsonText: packageJson,
        workspaceText: changed,
        installedTypeboxPackageJsonText: installedTypeboxPackageJson,
        expectedTypeboxVersion: '1.3.3',
      }),
      /workspace override is missing|workspace TypeBox override mismatch/,
    );
  }
});

test('rejects an unexpected OpenClaw host version', () => {
  const changed = JSON.stringify({
    name: 'openclaw',
    version: '2026.7.2',
    dependencies: { typebox: '1.3.3' },
  });
  assert.throws(
    () => verifyOpenClawHostContract({
      packageJsonText: changed,
      workspaceText: workspace,
      installedTypeboxPackageJsonText: installedTypeboxPackageJson,
      expectedTypeboxVersion: '1.3.3',
    }),
    /host identity mismatch/,
  );
});

test('rejects a changed TypeBox version already installed in the OpenClaw image', () => {
  assert.throws(
    () => verifyOpenClawHostContract({
      packageJsonText: packageJson,
      workspaceText: workspace,
      installedTypeboxPackageJsonText: JSON.stringify({ name: 'typebox', version: '1.1.38' }),
      expectedTypeboxVersion: '1.3.3',
    }),
    /installed TypeBox mismatch/,
  );
});
