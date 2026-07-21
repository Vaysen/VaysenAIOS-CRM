#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const EXPECTED_OPENCLAW_VERSION = '2026.7.1';

function unquoteYamlScalar(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2
    && ((trimmed.startsWith('"') && trimmed.endsWith('"'))
      || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function readTopLevelWorkspaceOverride(workspaceText, dependencyName) {
  const lines = workspaceText.replace(/\r\n/g, '\n').split('\n');
  const starts = lines
    .map((line, index) => (line === 'overrides:' ? index : -1))
    .filter((index) => index >= 0);
  if (starts.length !== 1) throw new Error('OpenClaw workspace must contain exactly one top-level overrides mapping');
  let value;
  for (let index = starts[0] + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (/^\S/.test(line)) break;
    const match = line.match(/^  ([^:#][^:]*):\s*(.*?)\s*$/);
    if (!match || match[1].trim() !== dependencyName) continue;
    if (value !== undefined) throw new Error(`OpenClaw workspace override is duplicated: ${dependencyName}`);
    value = unquoteYamlScalar(match[2]);
  }
  if (value === undefined || !value) throw new Error(`OpenClaw workspace override is missing: ${dependencyName}`);
  return value;
}

export function verifyOpenClawHostContract({
  packageJsonText,
  workspaceText,
  installedTypeboxPackageJsonText,
  expectedTypeboxVersion,
}) {
  if (!/^\d+\.\d+\.\d+$/.test(expectedTypeboxVersion ?? '')) {
    throw new Error('expected TypeBox version must be an exact semantic version');
  }
  const packageJson = JSON.parse(packageJsonText);
  if (packageJson?.name !== 'openclaw' || packageJson?.version !== EXPECTED_OPENCLAW_VERSION) {
    throw new Error(`OpenClaw host identity mismatch: expected openclaw@${EXPECTED_OPENCLAW_VERSION}`);
  }
  if (packageJson?.dependencies?.typebox !== expectedTypeboxVersion) {
    throw new Error(`OpenClaw host TypeBox dependency mismatch: expected ${expectedTypeboxVersion}`);
  }
  const override = readTopLevelWorkspaceOverride(workspaceText, 'typebox');
  if (override !== expectedTypeboxVersion) {
    throw new Error(`OpenClaw workspace TypeBox override mismatch: expected ${expectedTypeboxVersion}`);
  }
  const installedTypebox = JSON.parse(installedTypeboxPackageJsonText);
  if (installedTypebox?.name !== 'typebox' || installedTypebox?.version !== expectedTypeboxVersion) {
    throw new Error(`OpenClaw installed TypeBox mismatch: expected ${expectedTypeboxVersion}`);
  }
  return {
    package: `openclaw@${EXPECTED_OPENCLAW_VERSION}`,
    typeboxDependency: expectedTypeboxVersion,
    typeboxOverride: override,
    installedTypebox: installedTypebox.version,
  };
}

function assertRegularFile(file, label) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`unsafe ${label}: ${file}`);
}

export function verifyOpenClawHostContractFiles({ packageRoot, expectedTypeboxVersion }) {
  const resolvedRoot = path.resolve(packageRoot);
  const rootStat = fs.lstatSync(resolvedRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(`unsafe OpenClaw package root: ${resolvedRoot}`);
  const packagePath = path.join(resolvedRoot, 'package.json');
  const workspacePath = path.join(resolvedRoot, 'pnpm-workspace.yaml');
  const installedTypeboxPath = path.join(resolvedRoot, 'node_modules', 'typebox', 'package.json');
  assertRegularFile(packagePath, 'OpenClaw package manifest');
  assertRegularFile(workspacePath, 'OpenClaw workspace manifest');
  assertRegularFile(installedTypeboxPath, 'OpenClaw installed TypeBox manifest');
  return verifyOpenClawHostContract({
    packageJsonText: fs.readFileSync(packagePath, 'utf8'),
    workspaceText: fs.readFileSync(workspacePath, 'utf8'),
    installedTypeboxPackageJsonText: fs.readFileSync(installedTypeboxPath, 'utf8'),
    expectedTypeboxVersion,
  });
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1) throw new Error('usage: verify-host-contract.mjs <expected-typebox-version>');
  const result = verifyOpenClawHostContractFiles({
    packageRoot: '/app',
    expectedTypeboxVersion: args[0],
  });
  process.stdout.write(`OpenClaw host contract verified: ${result.package}, typebox=${result.typeboxDependency}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
