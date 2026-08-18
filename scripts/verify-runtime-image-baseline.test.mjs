import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  REQUIRED_SERVICES,
  renderOverride,
  validateBaseline,
  verifyCompose,
  verifyContainers,
  verifyHealth,
  verifyImages,
} from './verify-runtime-image-baseline.mjs';

const baselinePath = new URL('../security/release-runtime-baselines/vaysen-crm-lan-pilot-v1.4.82-r101.json', import.meta.url);
const source = JSON.parse(readFileSync(baselinePath, 'utf8'));
const clone = () => structuredClone(source);
const imageMap = new Map(source.services.map((entry) => [entry.imageRef, {
  Id: entry.imageId,
  Config: { Labels: entry.expectedRevision ? { 'org.opencontainers.image.revision': entry.expectedRevision } : {} },
}]));
for (const entry of source.services) imageMap.set(entry.imageId, imageMap.get(entry.imageRef));
const containerMap = new Map(source.services.map((entry) => [entry.container, {
  Config: {
    Image: entry.imageRef,
    Labels: {
      'com.docker.compose.project': entry.composeProject,
      'com.docker.compose.service': entry.composeService,
    },
  },
  Image: entry.imageId,
  State: {
    Status: entry.requiredState,
    ...(entry.requiredHealth === 'none' ? {} : { Health: { Status: entry.requiredHealth } }),
  },
}]));
const inspectImage = (target) => {
  if (!imageMap.has(target)) throw new Error('missing image');
  return structuredClone(imageMap.get(target));
};
const inspectContainer = (target) => {
  if (!containerMap.has(target)) throw new Error('missing container');
  return structuredClone(containerMap.get(target));
};

test('accepts the exact mixed-revision R101 sixteen-service baseline', () => {
  const baseline = validateBaseline(clone(), {
    tag: source.release.tag,
    commit: source.release.commit,
    project: source.composeProject,
  });
  assert.equal(baseline.services.length, 16);
  assert.deepEqual([...baseline.services.map((entry) => entry.service)].sort(), [...REQUIRED_SERVICES].sort());
  verifyContainers(baseline, inspectImage, inspectContainer, true);
  assert.equal(baseline.services.find((entry) => entry.service === 'python-service').expectedRevision, '6052466b4da62ccb3abab615bb5d23a9d0857bcc');
});

test('rejects missing, duplicate, and identity-mismatched services', () => {
  const missing = clone();
  missing.services.pop();
  assert.throws(() => validateBaseline(missing), /exactly 16 services/);
  const duplicate = clone();
  duplicate.services[1].service = duplicate.services[0].service;
  assert.throws(() => validateBaseline(duplicate), /duplicate service/);
  assert.throws(() => validateBaseline(clone(), { tag: 'vaysen-crm-lan-pilot-v9.9.9-r999' }), /expected tag/);
  assert.throws(() => validateBaseline(clone(), { commit: '0'.repeat(40) }), /expected commit/);
});

test('rejects missing images, reference ID drift, and revision drift', () => {
  const baseline = validateBaseline(clone());
  assert.throws(() => verifyImages(baseline, () => { throw new Error('missing'); }), /missing/);
  assert.throws(() => verifyImages(baseline, (target) => {
    const value = inspectImage(target);
    if (target === baseline.services[0].imageRef) value.Id = `sha256:${'0'.repeat(64)}`;
    return value;
  }), /reference ID drift/);
  assert.throws(() => verifyImages(baseline, (target) => {
    const value = inspectImage(target);
    if (target === baseline.services[0].imageId) value.Config.Labels['org.opencontainers.image.revision'] = '0'.repeat(40);
    return value;
  }), /revision drift/);
});

test('rejects container reference, image ID, compose label, state, and health drift', () => {
  const baseline = validateBaseline(clone());
  const mutate = (field) => (target) => {
    const value = inspectContainer(target);
    if (target === baseline.services[0].container) field(value);
    return value;
  };
  assert.throws(() => verifyContainers(baseline, inspectImage, mutate((value) => { value.Config.Image = 'wrong:tag'; }), true), /reference drift/);
  assert.throws(() => verifyContainers(baseline, inspectImage, mutate((value) => { value.Image = `sha256:${'0'.repeat(64)}`; }), true), /image ID drift/);
  assert.throws(() => verifyContainers(baseline, inspectImage, mutate((value) => { value.Config.Labels['com.docker.compose.project'] = 'wrong'; }), true), /compose project drift/);
  assert.throws(() => verifyContainers(baseline, inspectImage, mutate((value) => { value.State.Status = 'exited'; }), true), /state drift/);
  assert.throws(() => verifyContainers(baseline, inspectImage, mutate((value) => { value.State.Health.Status = 'unhealthy'; }), true), /health drift/);
});

test('renders exact image overrides and rejects rendered Compose drift', () => {
  const baseline = validateBaseline(clone());
  const compose = { services: Object.fromEntries(baseline.services.map((entry) => [entry.service, { image: entry.imageRef }])) };
  verifyCompose(baseline, compose);
  compose.services['python-service'].image = 'vaysen-crm-python-service:987808b5';
  assert.throws(() => verifyCompose(baseline, compose), /rendered Compose image drift/);
  const override = renderOverride(baseline);
  assert.match(override, /vaysen-crm-python-service:6052466b/);
  assert.doesNotMatch(override, /vaysen-crm-python-service:987808b5/);
});

test('enforces the published R101 health identity', () => {
  const baseline = validateBaseline(clone());
  verifyHealth(baseline, { status: 'ok', release: { ...baseline.health } });
  assert.throws(() => verifyHealth(baseline, { status: 'ok', release: { ...baseline.health, matchesBuild: false } }), /matchesBuild/);
  assert.throws(() => verifyHealth(baseline, { status: 'ok', release: { ...baseline.health, commit: '0'.repeat(40) } }), /commit/);
});
