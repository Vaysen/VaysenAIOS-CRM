import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  validateProductionArtifacts,
  validateProductionCompose,
  validateProductionConfig,
} from './validate-openclaw-production.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const read = (...parts) => fs.readFileSync(path.join(projectRoot, ...parts), 'utf8').replace(/\r\n/g, '\n');
const compose = read('docker-compose.prod.yml');
const config = read('deploy', 'openclaw', 'config', 'openclaw.production.json');
const artifacts = {
  prepare: read('scripts', 'prepare-openclaw-runtime.sh'),
  privateInstallConfig: read('deploy', 'openclaw', 'config', 'openclaw.install-private.json'),
  login: read('scripts', 'openclaw-weixin-login.sh'),
  smoke: read('scripts', 'openclaw-runtime-smoke-test.sh'),
  readme: read('deploy', 'openclaw', 'README.md'),
  manifest: read('deploy', 'openclaw', 'plugins', 'vaysen-crm', 'openclaw.plugin.json'),
  privatePackage: read('deploy', 'openclaw', 'plugins', 'vaysen-crm', 'package.json'),
  shrinkwrap: read('deploy', 'openclaw', 'plugins', 'vaysen-crm', 'npm-shrinkwrap.json'),
  hostVerifier: read('deploy', 'openclaw', 'plugins', 'vaysen-crm', 'verify-host-contract.mjs'),
  runtime: read('deploy', 'openclaw', 'plugins', 'vaysen-crm', 'dist', 'runtime.js'),
  index: read('deploy', 'openclaw', 'plugins', 'vaysen-crm', 'dist', 'index.js'),
  patch: read('deploy', 'openclaw', 'plugins', 'vaysen-crm', 'weixin-v2.4.6.patch.json'),
  evidence: read('deploy', 'openclaw', 'plugins', 'vaysen-crm', 'weixin-patch-files', 'dist', 'src', 'security', 'acceptance-evidence.js'),
  audit: read('deploy', 'openclaw', 'plugins', 'vaysen-crm', 'audit-managed-install.mjs'),
  workspace: Object.fromEntries(['AGENTS.md', 'SOUL.md', 'TOOLS.md', 'IDENTITY.md', 'USER.md', 'HEARTBEAT.md']
    .map((name) => [name, read('deploy', 'openclaw', 'workspace', name)])),
};

test('reviewed production OpenClaw templates satisfy the static contract', () => {
  assert.deepEqual(validateProductionCompose(compose), []);
  assert.deepEqual(validateProductionConfig(config), []);
  assert.deepEqual(validateProductionArtifacts(artifacts), []);
});

test('rejects an empty bootstrap config that breaks repeated plugin preparation', () => {
  const unsafePrepare = artifacts.prepare.replace(
    'cp /opt/vaysen-config/openclaw.install-private.json "$OPENCLAW_CONFIG_PATH.next"',
    'cp /opt/vaysen-config/openclaw.install-bootstrap.json "$OPENCLAW_CONFIG_PATH.next"',
  );
  assert.notEqual(unsafePrepare, artifacts.prepare, 'test fixture must replace the first replay-safe config copy');
  assert.match(
    validateProductionArtifacts({ ...artifacts, prepare: unsafePrepare }).join('\n'),
    /replay-safe plugin configuration/i,
  );
});

test('rejects retained managed generation cleanup that is not fail-closed', () => {
  const unsafePrepare = artifacts.prepare.replace(
    'if (failures.length > 0) throw new AggregateError',
    'if (false) throw new AggregateError',
  );
  assert.notEqual(unsafePrepare, artifacts.prepare, 'test fixture must disable the cleanup error gate');
  assert.match(
    validateProductionArtifacts({ ...artifacts, prepare: unsafePrepare }).join('\n'),
    /retained managed generation cleanup/i,
  );
});

test('rejects live plugin audits that do not opt into the exact runtime-link policy', () => {
  const unsafePrepare = artifacts.prepare.replace('-e OPENCLAW_AUDIT_MODE=live', '-e OPENCLAW_AUDIT_MODE=strict');
  assert.notEqual(unsafePrepare, artifacts.prepare);
  assert.match(
    validateProductionArtifacts({ ...artifacts, prepare: unsafePrepare }).join('\n'),
    /peer-link allowlist verifier/i,
  );
});

test('rejects a private TypeBox pin that drifts from the OpenClaw host override', () => {
  const unsafePackage = artifacts.privatePackage.replace('"typebox": "1.3.3"', '"typebox": "1.1.38"');
  assert.notEqual(unsafePackage, artifacts.privatePackage);
  assert.match(
    validateProductionArtifacts({ ...artifacts, privatePackage: unsafePackage }).join('\n'),
    /TypeBox pin.*host dependency\/override/i,
  );
});

test('rejects direct conversation ids in mutating OpenClaw action schemas', () => {
  const unsafeIndex = artifacts.index.replace(
    'selectionTokenProperty = () => Type.Optional(Type.String({ maxLength: 128 }))',
    "conversationId: Type.String({ format: 'uuid' })",
  );
  assert.notEqual(unsafeIndex, artifacts.index, 'test fixture must replace the reviewed token schema');
  assert.match(
    validateProductionArtifacts({ ...artifacts, index: unsafeIndex }).join('\n'),
    /action parameter contract/i,
  );
});

test('rejects gateway host publication, vaysen-crm membership and Docker socket mount', () => {
  const port = compose.replace('    expose:\n      - "18789"', '    ports:\n      - "18789:18789"\n    expose:\n      - "18789"');
  assert.notEqual(port, compose, 'port fixture must modify the gateway service');
  assert.match(validateProductionCompose(port).join('\n'), /host port/i);
  const network = compose.replace('    networks:\n      - openclaw\n    logging:\n      driver: json-file', '    networks:\n      - openclaw\n      - vaysen-crm\n    logging:\n      driver: json-file');
  assert.match(validateProductionCompose(network).join('\n'), /only the dedicated/i);
  const socket = compose.replace(
    '      - ./deploy/openclaw/plugins:/opt/vaysen-plugins:ro',
    '      - ./deploy/openclaw/plugins:/opt/vaysen-plugins:ro\n      - /var/run/docker.sock:/var/run/docker.sock',
  );
  assert.match(validateProductionCompose(socket).join('\n'), /volume|forbidden/i);
  const looseUmask = compose.replace('umask 077; exec node', 'exec node');
  assert.notEqual(looseUmask, compose);
  assert.match(validateProductionCompose(looseUmask).join('\n'), /umask 077/i);
});

test('rejects frontend gateway secret exposure', () => {
  const marker = '      NEXT_PUBLIC_API_URL: ${NEXT_PUBLIC_API_URL}';
  const position = compose.lastIndexOf(marker);
  assert.notEqual(position, -1);
  const unsafe = `${compose.slice(0, position)}      OPENCLAW_GATEWAY_TOKEN: \${OPENCLAW_GATEWAY_TOKEN}\n${compose.slice(position)}`;
  assert.match(validateProductionCompose(unsafe).join('\n'), /frontend must never/i);
});

test('rejects raw provider model and unused ZAI plugin activation', () => {
  const rawModel = JSON.parse(config);
  rawModel.agents.list[0].model = 'zhipu/glm-5';
  assert.match(validateProductionConfig(JSON.stringify(rawModel)).join('\n'), /agent\/model/i);
  const zai = JSON.parse(config);
  zai.plugins.allow.push('zai');
  zai.plugins.entries.zai = { enabled: true };
  assert.match(validateProductionConfig(JSON.stringify(zai)).join('\n'), /plugin|ZAI/i);
});

test('rejects a mutable workspace or enabled bootstrap writes', () => {
  const unsafe = JSON.parse(config);
  unsafe.agents.defaults.workspace = '/home/node/.openclaw/workspace';
  unsafe.agents.list[0].workspace = '/home/node/.openclaw/workspace';
  unsafe.agents.defaults.skipBootstrap = false;
  assert.match(validateProductionConfig(JSON.stringify(unsafe)).join('\n'), /read-only bootstrap/i);
});

test('rejects a Zhipu model without the locked max_tokens compatibility field', () => {
  const unsafe = JSON.parse(config);
  delete unsafe.models.providers['zhipu-cn'].models[0].compat;
  assert.match(validateProductionConfig(JSON.stringify(unsafe)).join('\n'), /zhipu-cn provider/i);
});

test('rejects a legacy allow policy and infrastructure-bypass boundary drift', () => {
  const legacyAllow = JSON.parse(config);
  legacyAllow.tools.allow = legacyAllow.tools.alsoAllow;
  delete legacyAllow.tools.alsoAllow;
  assert.match(
    validateProductionConfig(JSON.stringify(legacyAllow)).join('\n'),
    /business-supervisor.*coding profile/i,
  );

  const residualMinimalTool = JSON.parse(config);
  residualMinimalTool.tools.deny = residualMinimalTool.tools.deny
    .filter((name) => name !== 'exec');
  assert.match(
    validateProductionConfig(JSON.stringify(residualMinimalTool)).join('\n'),
    /infrastructure-bypass boundary/i,
  );

  const extraPluginTool = JSON.parse(config);
  extraPluginTool.tools.alsoAllow.push('unreviewed_plugin_tool');
  assert.match(
    validateProductionConfig(JSON.stringify(extraPluginTool)).join('\n'),
    /business-supervisor.*exact tool extension/i,
  );
});

test('rejects a non-webchat CRM HTTP ingress or an unlocked owner bit', () => {
  const unsafeChannel = artifacts.runtime
    .replace("const HTTP_INGRESS_CHANNEL = 'webchat';", "const HTTP_INGRESS_CHANNEL = 'vaysen-crm';");
  assert.notEqual(unsafeChannel, artifacts.runtime);
  assert.match(
    validateProductionArtifacts({ ...artifacts, runtime: unsafeChannel }).join('\n'),
    /registered webchat transport/i,
  );
  const unsafeOwner = artifacts.runtime.replace('toolContext.senderIsOwner === false', 'true');
  assert.notEqual(unsafeOwner, artifacts.runtime);
  assert.match(
    validateProductionArtifacts({ ...artifacts, runtime: unsafeOwner }).join('\n'),
    /fixed false owner bit/i,
  );
  const unsafeSession = artifacts.runtime.replace(
    "const CRM_HTTP_SESSION_PATTERN = /^agent:vaysen-crm:(vaysen-crm:[a-f0-9]{64})$/;",
    "const CRM_HTTP_SESSION_PATTERN = /^(vaysen-crm:[a-f0-9]{64})$/;",
  );
  assert.notEqual(unsafeSession, artifacts.runtime);
  assert.match(
    validateProductionArtifacts({ ...artifacts, runtime: unsafeSession }).join('\n'),
    /canonical agent session/i,
  );
  const unsafeSmoke = artifacts.smoke
    .replace("'x-openclaw-message-channel': 'webchat'", "'x-openclaw-message-channel': 'vaysen-crm'");
  assert.notEqual(unsafeSmoke, artifacts.smoke);
  assert.match(
    validateProductionArtifacts({ ...artifacts, smoke: unsafeSmoke }).join('\n'),
    /fixed vaysen-crm agent context/i,
  );
});

test('rejects workspace source files without the reviewed identity policy', () => {
  const unsafeWorkspace = { ...artifacts.workspace, 'IDENTITY.md': '# unknown\n' };
  assert.match(
    validateProductionArtifacts({ ...artifacts, workspace: unsafeWorkspace }).join('\n'),
    /workspace identity/i,
  );
});

test('rejects workspace rules that omit deterministic owner acceptance-marker routing', () => {
  const unsafeWorkspace = {
    ...artifacts.workspace,
    'TOOLS.md': artifacts.workspace['TOOLS.md']
      .replaceAll('JYACC_OWNER_[a-f0-9]{16}', 'REMOVED_OWNER_MARKER'),
    'AGENTS.md': artifacts.workspace['AGENTS.md']
      .replaceAll('JYACC_OWNER_[a-f0-9]{16}', 'REMOVED_OWNER_MARKER'),
  };
  assert.match(
    validateProductionArtifacts({ ...artifacts, workspace: unsafeWorkspace }).join('\n'),
    /acceptance-marker routing/i,
  );
});

test('rejects verbose/default-overriding logging and uncapped gateway logs', () => {
  const verbose = JSON.parse(config);
  verbose.logging.level = 'info';
  assert.match(validateProductionConfig(JSON.stringify(verbose)).join('\n'), /logging/i);
  const patterns = JSON.parse(config);
  patterns.logging.redactPatterns = ['custom'];
  assert.match(validateProductionConfig(JSON.stringify(patterns)).join('\n'), /logging/i);
  const uncapped = compose.replace('max-file: "2"', 'max-file: "5"');
  assert.match(validateProductionCompose(uncapped).join('\n'), /capped/i);
});

test('rejects a missing backend OpenClaw release version', () => {
  const missing = compose.replace(
    '      OPENCLAW_RELEASE_VERSION: ${OPENCLAW_RUNTIME_VERSION:-2026.7.1}\n',
    '',
  );
  assert.notEqual(missing, compose, 'release-version fixture must modify the backend environment');
  assert.match(validateProductionCompose(missing).join('\n'), /release version/i);
});

test('rejects a read-only gateway npm cache outside tmpfs', () => {
  const unsafe = compose.replace('      NPM_CONFIG_CACHE: /tmp/npm-cache', '      NPM_CONFIG_CACHE: /home/node/.npm');
  assert.match(validateProductionCompose(unsafe).join('\n'), /npm cache/i);
});

test('rejects an OpenClaw plugin installation path that is not forced offline', () => {
  const unsafe = artifacts.prepare.replaceAll(
    '-e NPM_CONFIG_OFFLINE=true -e npm_config_offline=true',
    '-e NPM_CONFIG_PREFER_OFFLINE=true',
  );
  assert.notEqual(unsafe, artifacts.prepare, 'offline-install fixture must modify the prepare script');
  assert.match(validateProductionArtifacts({ ...artifacts, prepare: unsafe }).join('\n'), /offline-only/i);
});

test('rejects reinstalling the private CRM plugin from a dependency-skipping directory path', () => {
  const unsafe = artifacts.prepare.replace(
    'plugins install "npm-pack:$private_artifact" --force',
    'plugins install /opt/vaysen-plugins/vaysen-crm --force',
  );
  assert.notEqual(unsafe, artifacts.prepare, 'private-install fixture must modify the prepare script');
  assert.match(validateProductionArtifacts({ ...artifacts, prepare: unsafe }).join('\n'), /private CRM deterministic npm-pack/i);
});

test('rejects an offline plugin cache that is not mounted at the sanitized npm default', () => {
  const unsafe = artifacts.prepare.replace(
    '        -v "$PREPARE_NPM_CACHE_HOST:/home/node/.npm" \\\n',
    '',
  );
  assert.notEqual(unsafe, artifacts.prepare, 'default-cache fixture must modify the prepare script');
  assert.match(validateProductionArtifacts({ ...artifacts, prepare: unsafe }).join('\n'), /offline-only/i);
});

test('rejects a plugin cache without an exact lock warm-up and offline replay', () => {
  const unsafe = artifacts.prepare.replace('\nwarm_verified_install_cache\n', '\n');
  assert.notEqual(unsafe, artifacts.prepare, 'lock-warm fixture must modify the prepare script');
  assert.match(validateProductionArtifacts({ ...artifacts, prepare: unsafe }).join('\n'), /offline-only/i);
});

test('rejects a private-plugin install configuration without the internal broker contract', () => {
  const unsafe = JSON.parse(artifacts.privateInstallConfig);
  unsafe.plugins.entries['vaysen-crm'].config.apiBaseUrl = 'https://example.com';
  assert.match(
    validateProductionArtifacts({ ...artifacts, privateInstallConfig: JSON.stringify(unsafe) }).join('\n'),
    /installation config/i,
  );
});

test('rejects additional private-plugin install configuration keys', () => {
  const unsafe = JSON.parse(artifacts.privateInstallConfig);
  unsafe.plugins.entries.unreviewed = { enabled: true };
  assert.match(
    validateProductionArtifacts({ ...artifacts, privateInstallConfig: JSON.stringify(unsafe) }).join('\n'),
    /installation config/i,
  );
});

function productionEnv(overrides = {}) {
  const digest = (name) => `${name}@sha256:${'0'.repeat(64)}`;
  return {
    DB_PASSWORD: 'correct-horse-battery-staple',
    JWT_SECRET: 'a'.repeat(64),
    JWT_REFRESH_SECRET: 'b'.repeat(64),
    EMAIL_ENCRYPTION_KEY: 'c'.repeat(32),
    N8N_ENCRYPTION_KEY: 'd'.repeat(64),
    ZHIPU_API_KEY: 'zhipu-contract-key-1234567890',
    OPENCLAW_ENABLED: 'true',
    OPENCLAW_RUNTIME_VERSION: '2026.7.1',
    OPENCLAW_WEIXIN_PLUGIN_VERSION: '2.4.6',
    OPENCLAW_DATA_UID: '1000',
    OPENCLAW_DATA_GID: '1000',
    OPENCLAW_GATEWAY_TOKEN: 'g'.repeat(64),
    OPENCLAW_CRM_HMAC_KEY_ID: 'vaysen-openclaw-v1',
    OPENCLAW_CRM_HMAC_SECRET: 'h'.repeat(64),
    OPENCLAW_OWNER_EMAIL: 'admin@example.com',
    OPENCLAW_OWNER_COMPANY_SLUG: 'example-trading-company',
    OPENCLAW_WECHAT_OWNER_PEER_SHA256: '',
    LAN_BIND_IP: '127.0.0.1',
    APPROVED_LAN_BIND_IP: '127.0.0.1',
    LOCAL_LAN_BIND_IP: '127.0.0.1',
    APPROVED_LOCAL_LAN_BIND_IP: '127.0.0.1',
    FRONTEND_URL: 'http://127.0.0.1',
    API_BASE_URL: 'http://127.0.0.1/api',
    CORS_ORIGIN: 'http://127.0.0.1,http://127.0.0.1',
    NEXT_PUBLIC_API_URL: '/api',
    APP_DATA_DIR: '/var/lib/vaysen-crm/data',
    ENABLE_SWAGGER: 'false',
    EMAIL_SEND_DISABLED: 'true',
    WHATSAPP_PROXY: '',
    WHATSAPP_RESTORE_SESSIONS: 'true',
    DEEP_RESEARCH_RECONCILE_ENABLED: 'true',
    EMAIL_SEED_TEST_ENABLED: 'false',
    EMAIL_SEED_TEST_ADDRESS: '',
    EMAIL_SEED_TEST_APPROVED_ADDRESSES: '',
    EMAIL_SEED_TEST_INTERVAL: '100',
    EVOLUTION_API_ENABLED: 'false',
    NODE_IMAGE: digest('node'),
    PYTHON_IMAGE: digest('python'),
    POSTGRES_IMAGE: digest('postgres'),
    REDIS_IMAGE: digest('redis'),
    NGINX_IMAGE: digest('nginx'),
    REACHER_IMAGE: digest('reacher'),
    SEARXNG_IMAGE: digest('searxng'),
    N8N_IMAGE: digest('n8n'),
    OPENCLAW_IMAGE: 'ghcr.io/openclaw/openclaw@sha256:6a31d44b2944e7adcd2b582bf6fb463111264ebca97a0201795b799135bd102c',
    ...overrides,
  };
}

function validateEnv(env) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openclaw-env-test-'));
  const file = path.join(directory, '.env');
  fs.writeFileSync(file, `${Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n')}\n`, { mode: 0o600 });
  try {
    return spawnSync(process.execPath, [path.join(scriptDir, 'validate-production-env.mjs'), file], { encoding: 'utf8' });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('production env accepts reviewed OpenClaw values', () => {
  const result = validateEnv(productionEnv());
  assert.equal(result.status, 0, result.stderr);
  const paired = validateEnv(productionEnv({
    OPENCLAW_WECHAT_OWNER_PEER_SHA256: '1'.repeat(64),
  }));
  assert.equal(paired.status, 0, paired.stderr);
});

for (const [name, overrides, pattern] of [
  ['HMAC shorter than 48 UTF-8 bytes', { OPENCLAW_CRM_HMAC_SECRET: 'h'.repeat(47) }, /48 UTF-8 bytes/],
  ['reused HMAC secret', { OPENCLAW_CRM_HMAC_SECRET: 'a'.repeat(64) }, /distinct/],
  ['gateway token reused as database password', { OPENCLAW_GATEWAY_TOKEN: 'correct-horse-battery-staple' }, /distinct from DB_PASSWORD/],
  ['HMAC secret reused as email encryption key', {
    EMAIL_ENCRYPTION_KEY: 'h'.repeat(64),
  }, /distinct from EMAIL_ENCRYPTION_KEY/],
  ['missing owner slug', { OPENCLAW_OWNER_COMPANY_SLUG: '' }, /COMPANY_SLUG/],
  ['invalid owner slug', { OPENCLAW_OWNER_COMPANY_SLUG: '../wrong' }, /COMPANY_SLUG/],
  ['uppercase owner peer digest', { OPENCLAW_WECHAT_OWNER_PEER_SHA256: 'A'.repeat(64) }, /64 lowercase hex/],
  ['short owner peer digest', { OPENCLAW_WECHAT_OWNER_PEER_SHA256: 'a'.repeat(63) }, /64 lowercase hex/],
  ['floating OpenClaw image', { OPENCLAW_IMAGE: 'ghcr.io/openclaw/openclaw:2026.7.1' }, /OPENCLAW_IMAGE/],
  ['browser OpenClaw secret', { NEXT_PUBLIC_OPENCLAW_TOKEN: 'leak' }, /forbidden/],
  ['malformed WhatsApp restore opt-in', { WHATSAPP_RESTORE_SESSIONS: 'TRUE' }, /WHATSAPP_RESTORE_SESSIONS/],
  ['public local LAN bind', {
    LOCAL_LAN_BIND_IP: '8.8.8.8',
    APPROVED_LOCAL_LAN_BIND_IP: '8.8.8.8',
    CORS_ORIGIN: 'http://127.0.0.1,http://8.8.8.8',
  }, /RFC1918/],
  ['duplicate stable and local LAN binds', {
    LOCAL_LAN_BIND_IP: '127.0.0.1',
    APPROVED_LOCAL_LAN_BIND_IP: '127.0.0.1',
    CORS_ORIGIN: 'http://127.0.0.1,http://127.0.0.1',
  }, /must differ/],
  ['unapproved local LAN bind', { LOCAL_LAN_BIND_IP: '192.168.2.220' }, /APPROVED_LOCAL_LAN_BIND_IP/],
  ['CORS without physical LAN origin', { CORS_ORIGIN: 'http://127.0.0.1' }, /CORS_ORIGIN/],
  ['WhatsApp proxy without an explicit port', { WHATSAPP_PROXY: 'socks5://proxy.internal' }, /WHATSAPP_PROXY/],
  ['WhatsApp proxy with an unsafe protocol', { WHATSAPP_PROXY: 'file:///tmp/proxy' }, /WHATSAPP_PROXY/],
  ['missing deep-research reconcile opt-in', { DEEP_RESEARCH_RECONCILE_ENABLED: '' }, /DEEP_RESEARCH_RECONCILE_ENABLED/],
]) {
  test(`production env rejects ${name}`, () => {
    const result = validateEnv(productionEnv(overrides));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, pattern);
  });
}
