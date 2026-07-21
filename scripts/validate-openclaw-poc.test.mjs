import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  validateComposeContract,
  validateOpenClawConfig,
  validateRuntimeEnvironment,
} from './validate-openclaw-poc.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const compose = fs.readFileSync(
  path.join(projectRoot, 'deploy', 'openclaw-poc', 'compose.openclaw-poc.yml'),
  'utf8',
);
const config = fs.readFileSync(
  path.join(projectRoot, 'deploy', 'openclaw-poc', 'config', 'openclaw.readonly.json'),
  'utf8',
);

test('reviewed template satisfies the static contract', () => {
  assert.deepEqual(validateComposeContract(compose), []);
  assert.deepEqual(validateOpenClawConfig(config), []);
});

test('rejects mutable image fallback', () => {
  const unsafe = compose.replace(
    '${OPENCLAW_IMAGE:?Set OPENCLAW_IMAGE to an approved official image digest}',
    '${OPENCLAW_IMAGE:-ghcr.io/openclaw/openclaw:latest}',
  );
  assert.match(validateComposeContract(unsafe).join('\n'), /image|mutable/i);
});

test('rejects host port publication', () => {
  const unsafe = compose.replace('    volumes:\n', '    ports:\n      - "18789:18789"\n    volumes:\n');
  assert.match(validateComposeContract(unsafe).join('\n'), /unreviewed service keys/i);
});

test('rejects a second root service even when the reviewed service is unchanged', () => {
  const unsafe = compose.replace(
    '\nnetworks:',
    '\n  attacker:\n    image: alpine:latest\n    volumes:\n      - /etc/passwd:/stolen:ro\n\nnetworks:',
  );
  assert.match(validateComposeContract(unsafe).join('\n'), /exactly one service/i);
});

test('rejects inline ports and unreviewed service keys', () => {
  const unsafe = compose.replace(
    '    pull_policy: always',
    '    pull_policy: always\n    ports: ["18789:18789"]',
  );
  assert.match(validateComposeContract(unsafe).join('\n'), /unreviewed service keys/i);
});

test('rejects Docker socket and project mounts', () => {
  for (const mount of [
    '/var/run/docker.sock:/var/run/docker.sock',
    '../:/workspace',
    '/root/.ssh:/home/node/.ssh:ro',
    '/backups:/backups',
    '/opt/vaysen-ai-crm:/workspace',
    '/etc/passwd:/etc/passwd:ro',
  ]) {
    const unsafe = compose.replace(
      '      - openclaw_poc_state:/home/node/.openclaw\n',
      `      - openclaw_poc_state:/home/node/.openclaw\n      - ${mount}\n`,
    );
    assert.match(validateComposeContract(unsafe).join('\n'), /dangerous|volumes must be exactly/i, mount);
  }
});

test('rejects privileged filesystem and execution posture', () => {
  assert.match(validateComposeContract(compose.replace('    read_only: true', '    read_only: false')).join('\n'), /read-only/i);
  assert.match(validateComposeContract(compose.replace('      - ALL', '      - NET_RAW')).join('\n'), /capabilities/i);
  const parsed = JSON.parse(config);
  parsed.tools.exec.mode = 'full';
  parsed.tools.deny = parsed.tools.deny.filter((item) => item !== 'group:fs');
  assert.match(validateOpenClawConfig(JSON.stringify(parsed)).join('\n'), /exec|group:fs/i);
});

test('rejects non-local or non-loopback gateway', () => {
  const parsed = JSON.parse(config);
  parsed.gateway.mode = 'remote';
  parsed.gateway.bind = 'lan';
  assert.match(validateOpenClawConfig(JSON.stringify(parsed)).join('\n'), /local|loopback/i);
});

test('rejects additive tool grants and unreviewed config sections', () => {
  const parsed = JSON.parse(config);
  parsed.tools.alsoAllow = ['web_fetch'];
  parsed.channels = { whatsapp: { enabled: true } };
  assert.match(validateOpenClawConfig(JSON.stringify(parsed)).join('\n'), /additive|only the reviewed/i);
});

test('rejects unreviewed nested gateway and filesystem bypass keys', () => {
  const insecureGateway = JSON.parse(config);
  insecureGateway.gateway.controlUi = { allowInsecureAuth: true };
  assert.match(
    validateOpenClawConfig(JSON.stringify(insecureGateway)).join('\n'),
    /gateway may contain only/i,
  );

  const filesystemGrant = JSON.parse(config);
  filesystemGrant.tools.fs = { workspaceOnly: false };
  assert.match(
    validateOpenClawConfig(JSON.stringify(filesystemGrant)).join('\n'),
    /tools may contain only/i,
  );

  const execBypass = JSON.parse(config);
  execBypass.tools.exec.commandAllowlist = ['bash'];
  assert.match(
    validateOpenClawConfig(JSON.stringify(execBypass)).join('\n'),
    /tools\.exec may contain only/i,
  );
});

test('runtime accepts only official digest and non-placeholder secrets', () => {
  const good = {
    OPENCLAW_IMAGE: `ghcr.io/openclaw/openclaw@sha256:${'a'.repeat(64)}`,
    OPENCLAW_POC_GATEWAY_TOKEN: 'g'.repeat(48),
  };
  assert.deepEqual(validateRuntimeEnvironment(good), []);

  for (const image of [
    'ghcr.io/openclaw/openclaw:latest',
    'ghcr.io/openclaw/openclaw:2026.7.1',
    `evil.invalid/openclaw@sha256:${'a'.repeat(64)}`,
    `ghcr.io/openclaw/openclaw@sha256:${'a'.repeat(63)}`,
  ]) {
    assert.match(validateRuntimeEnvironment({ ...good, OPENCLAW_IMAGE: image }).join('\n'), /digest/i, image);
  }

  assert.match(
    validateRuntimeEnvironment({ ...good, OPENCLAW_POC_GATEWAY_TOKEN: 'replace-me' }).join('\n'),
    /GATEWAY_TOKEN/,
  );
});
