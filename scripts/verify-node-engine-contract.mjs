#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const expectedNode = readFileSync(join(root, '.node-version'), 'utf8').trim();
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));

if (!semver.valid(expectedNode)) {
  console.error(`[node-engine-contract] .node-version 不是有效版本号: ${expectedNode}`);
  process.exit(2);
}

const failures = [];
let checked = 0;

for (const [location, metadata] of Object.entries(lock.packages ?? {})) {
  if (!location || metadata.dev === true || !metadata.engines?.node) continue;

  checked += 1;
  const range = metadata.engines.node;
  try {
    if (!semver.satisfies(expectedNode, range, { includePrerelease: true })) {
      failures.push({ location, version: metadata.version ?? '(workspace)', range });
    }
  } catch (error) {
    failures.push({
      location,
      version: metadata.version ?? '(workspace)',
      range: `${range}（无法解析: ${error.message}）`,
    });
  }
}

if (failures.length > 0) {
  console.error(
    `[node-engine-contract] FAIL: ${failures.length} 个生产依赖不支持锁定的 Node ${expectedNode}`,
  );
  for (const failure of failures) {
    console.error(
      `  - ${failure.location}@${failure.version}: engines.node=${failure.range}`,
    );
  }
  process.exit(1);
}

console.log(
  `[node-engine-contract] PASS: ${checked} 个生产依赖均支持 Node ${expectedNode}`,
);
