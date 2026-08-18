#!/usr/bin/env node
import { readFileSync, lstatSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const REQUIRED_SERVICES = Object.freeze([
  'backend',
  'frontend',
  'n8n',
  'nginx',
  'openclaw-gateway',
  'postgres',
  'python-service',
  'reacher',
  'redis',
  'searxng',
  'worker-deep-research',
  'worker-email-compose',
  'worker-email-send',
  'worker-email-validate',
  'worker-maintenance',
  'worker-prospect-search',
]);

const TOP_KEYS = ['captureMethod', 'capturedAt', 'composeProject', 'health', 'release', 'schemaVersion', 'services'];
const RELEASE_KEYS = ['commit', 'commitShort', 'tag'];
const HEALTH_KEYS = ['buildCommit', 'commit', 'commitShort', 'matchesBuild', 'status', 'tag'];
const SERVICE_KEYS = [
  'composeProject', 'composeService', 'container', 'expectedRevision', 'imageId',
  'imageRef', 'requiredHealth', 'requiredState', 'service',
];
const SHA = /^[0-9a-f]{40}$/;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const RELEASE_TAG = /^vaysen-crm-lan(?:-pilot)?-v\d+\.\d+\.\d+-r\d+$/;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function exactKeys(value, expected, label) {
  invariant(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
  const actual = Object.keys(value).sort();
  invariant(JSON.stringify(actual) === JSON.stringify([...expected].sort()), `${label} has missing or unknown fields`);
}

export function validateBaseline(value, expected = {}) {
  exactKeys(value, TOP_KEYS, 'baseline');
  invariant(value.schemaVersion === 1, 'baseline schemaVersion must be 1');
  invariant(typeof value.capturedAt === 'string' && !Number.isNaN(Date.parse(value.capturedAt)), 'baseline capturedAt is invalid');
  invariant(value.captureMethod === 'read-only docker inspect on the verified R101 production host', 'baseline captureMethod is invalid');
  exactKeys(value.release, RELEASE_KEYS, 'baseline.release');
  invariant(RELEASE_TAG.test(value.release.tag), 'baseline release tag is invalid');
  invariant(SHA.test(value.release.commit), 'baseline release commit is invalid');
  invariant(value.release.commitShort === value.release.commit.slice(0, 8), 'baseline release short commit is invalid');
  invariant(typeof value.composeProject === 'string' && value.composeProject.length > 0, 'baseline composeProject is invalid');
  exactKeys(value.health, HEALTH_KEYS, 'baseline.health');
  invariant(value.health.status === 'ok', 'baseline health status must be ok');
  invariant(value.health.tag === value.release.tag, 'baseline health tag does not match release tag');
  invariant(value.health.commit === value.release.commit, 'baseline health commit does not match release commit');
  invariant(value.health.commitShort === value.release.commitShort, 'baseline health short commit does not match release');
  invariant(value.health.buildCommit === value.release.commit, 'baseline health buildCommit does not match release commit');
  invariant(value.health.matchesBuild === true, 'baseline health matchesBuild must be true');
  if (expected.tag) invariant(value.release.tag === expected.tag, 'baseline release tag does not match expected tag');
  if (expected.commit) invariant(value.release.commit === expected.commit, 'baseline release commit does not match expected commit');
  if (expected.project) invariant(value.composeProject === expected.project, 'baseline compose project does not match expected project');
  invariant(Array.isArray(value.services), 'baseline services must be an array');
  invariant(value.services.length === REQUIRED_SERVICES.length, `baseline must contain exactly ${REQUIRED_SERVICES.length} services`);
  const names = new Set();
  const containers = new Set();
  for (const entry of value.services) {
    exactKeys(entry, SERVICE_KEYS, 'baseline service entry');
    invariant(REQUIRED_SERVICES.includes(entry.service), `baseline contains unknown service: ${entry.service}`);
    invariant(!names.has(entry.service), `baseline contains duplicate service: ${entry.service}`);
    invariant(!containers.has(entry.container), `baseline contains duplicate container: ${entry.container}`);
    names.add(entry.service);
    containers.add(entry.container);
    invariant(entry.container === `vaysen-crm-${entry.service}`, `baseline container name is not canonical for ${entry.service}`);
    invariant(typeof entry.imageRef === 'string' && entry.imageRef.length > 0 && !/[\s\u0000-\u001f]/.test(entry.imageRef), `baseline imageRef is invalid for ${entry.service}`);
    invariant(IMAGE_ID.test(entry.imageId), `baseline imageId is invalid for ${entry.service}`);
    invariant(entry.expectedRevision === null || SHA.test(entry.expectedRevision), `baseline expectedRevision is invalid for ${entry.service}`);
    invariant(entry.composeProject === value.composeProject, `baseline compose project mismatch for ${entry.service}`);
    invariant(entry.composeService === entry.service, `baseline compose service mismatch for ${entry.service}`);
    invariant(entry.requiredState === 'running', `baseline requiredState is invalid for ${entry.service}`);
    invariant(entry.requiredHealth === 'healthy' || entry.requiredHealth === 'none', `baseline requiredHealth is invalid for ${entry.service}`);
  }
  const missing = REQUIRED_SERVICES.filter((name) => !names.has(name));
  invariant(missing.length === 0, `baseline is missing services: ${missing.join(',')}`);
  return value;
}

export function verifyImages(baseline, inspectImage) {
  for (const entry of baseline.services) {
    const byRef = inspectImage(entry.imageRef);
    const byId = inspectImage(entry.imageId);
    invariant(byRef?.Id === entry.imageId, `image reference ID drift for ${entry.service}`);
    invariant(byId?.Id === entry.imageId, `image ID is missing or inconsistent for ${entry.service}`);
    const revision = byId?.Config?.Labels?.['org.opencontainers.image.revision'] || null;
    invariant(revision === entry.expectedRevision, `image revision drift for ${entry.service}`);
  }
}

export function verifyContainers(baseline, inspectImage, inspectContainer, requireRuntimeState = false) {
  verifyImages(baseline, inspectImage);
  for (const entry of baseline.services) {
    const container = inspectContainer(entry.container);
    invariant(container?.Config?.Image === entry.imageRef, `container image reference drift for ${entry.service}`);
    invariant(container?.Image === entry.imageId, `container image ID drift for ${entry.service}`);
    invariant(container?.Config?.Labels?.['com.docker.compose.project'] === entry.composeProject, `container compose project drift for ${entry.service}`);
    invariant(container?.Config?.Labels?.['com.docker.compose.service'] === entry.composeService, `container compose service drift for ${entry.service}`);
    if (requireRuntimeState) {
      invariant(container?.State?.Status === entry.requiredState, `container state drift for ${entry.service}`);
      const health = container?.State?.Health?.Status || 'none';
      invariant(health === entry.requiredHealth, `container health drift for ${entry.service}`);
    }
  }
}

export function verifyCompose(baseline, compose) {
  invariant(compose && typeof compose === 'object' && compose.services && typeof compose.services === 'object', 'rendered Compose JSON is invalid');
  for (const entry of baseline.services) {
    invariant(compose.services?.[entry.composeService]?.image === entry.imageRef, `rendered Compose image drift for ${entry.service}`);
  }
}

export function verifyHealth(baseline, health) {
  invariant(health?.status === baseline.health.status, 'published health status does not match baseline');
  const release = health?.release || {};
  invariant(release.tag === baseline.health.tag, 'published health tag does not match baseline');
  invariant(release.commit === baseline.health.commit, 'published health commit does not match baseline');
  invariant(release.commitShort === baseline.health.commitShort, 'published health short commit does not match baseline');
  invariant(release.buildCommit === baseline.health.buildCommit, 'published health buildCommit does not match baseline');
  invariant(release.matchesBuild === baseline.health.matchesBuild, 'published health matchesBuild does not match baseline');
}

export function renderOverride(baseline) {
  const lines = ['services:'];
  for (const entry of baseline.services) {
    lines.push(`  ${entry.composeService}:`, `    image: ${JSON.stringify(entry.imageRef)}`);
  }
  return `${lines.join('\n')}\n`;
}

function dockerInspect(kind, target) {
  const result = spawnSync('docker', [kind, 'inspect', target], { encoding: 'utf8', windowsHide: true });
  invariant(result.status === 0, `docker ${kind} inspect failed for ${target}`);
  let parsed;
  try { parsed = JSON.parse(result.stdout); } catch { throw new Error(`docker ${kind} inspect returned invalid JSON for ${target}`); }
  invariant(Array.isArray(parsed) && parsed.length === 1, `docker ${kind} inspect returned an unexpected result for ${target}`);
  return parsed[0];
}

function parseArgs(argv) {
  const result = { requireRuntimeState: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--require-runtime-state') { result.requireRuntimeState = true; continue; }
    invariant(arg.startsWith('--') && i + 1 < argv.length, `invalid argument: ${arg}`);
    result[arg.slice(2)] = argv[++i];
  }
  return result;
}

function readStdin() {
  return readFileSync(0, 'utf8');
}

export function runCli(argv) {
  const args = parseArgs(argv);
  invariant(args.baseline, '--baseline is required');
  const stat = lstatSync(args.baseline);
  invariant(stat.isFile() && !stat.isSymbolicLink(), 'baseline must be a regular non-symlink file');
  const baseline = validateBaseline(JSON.parse(readFileSync(args.baseline, 'utf8')), {
    tag: args['expected-tag'],
    commit: args['expected-commit'],
    project: args['expected-project'],
  });
  const mode = args.mode || 'validate';
  if (mode === 'validate') {
    // Static validation already completed.
  } else if (mode === 'verify-images') {
    verifyImages(baseline, (target) => dockerInspect('image', target));
  } else if (mode === 'verify-containers') {
    verifyContainers(
      baseline,
      (target) => dockerInspect('image', target),
      (target) => dockerInspect('container', target),
      args.requireRuntimeState,
    );
  } else if (mode === 'verify-compose') {
    verifyCompose(baseline, JSON.parse(readStdin()));
  } else if (mode === 'verify-health') {
    verifyHealth(baseline, JSON.parse(readStdin()));
  } else if (mode === 'print-override') {
    process.stdout.write(renderOverride(baseline));
    return;
  } else {
    throw new Error(`unknown mode: ${mode}`);
  }
  process.stdout.write(`[runtime baseline OK] mode=${mode} tag=${baseline.release.tag} services=${baseline.services.length}\n`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try { runCli(process.argv.slice(2)); } catch (error) {
    process.stderr.write(`[runtime baseline ERROR] ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
