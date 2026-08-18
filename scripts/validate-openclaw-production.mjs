#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const read = (...parts) => fs.readFileSync(path.join(projectRoot, ...parts), 'utf8');
const EXPECTED_IMAGE = 'ghcr.io/openclaw/openclaw@sha256:6a31d44b2944e7adcd2b582bf6fb463111264ebca97a0201795b799135bd102c';
const WEIXIN_INTEGRITY = 'sha512-qw9k3PLTiMWGNjjsknHgcTManH1w4j+Ji1ArWIaYLKCq3aFRsVwcqnPi127bvOoVMJGW4dbyJ8NECEMgoO+iRw==';
const WEIXIN_PATCHED_INTEGRITY = 'sha512-WarnJ65LzlqhSluRnY4c/SvnnKnZTNhIEMXZEih+iQRDe4iZsVznsp3EySB+ADBdsa6XSH4MfhyijFLgiTPyhQ==';
const WEIXIN_PATCH_SHA256 = '59f180806b5687aa53f4804ec6c496f2ab406817dfaa4d6974f192c362a610e2';
const TYPEBOX_VERSION = '1.3.3';
const TYPEBOX_INTEGRITY = 'sha512-URXGUE31PJDQC+PtRMJeLdF4kmmOdFoVPikPCtV2oOIhUpNpppEdIz7W8bH8cFYPYHdDpaRvqwdegMTmHliudg==';
const QRCODE_INTEGRITY = 'sha512-EXtzRZmC+YGmGlDFbXKxQiMZNwCLEO6BANKXG4iCtSIM0yqc/pappSx3RIKr4r0uh5JsBckOXeKrB3Iz7mdQpQ==';
const ZOD_INTEGRITY = 'sha512-rftlrkhHZOcjDwkGlnUtZZkvaPHCsDATp4pGpuOOMDaTdDDXF91wuVDJoWoPsKX/3YPQ5fHuF3STjcYyKr+Qhg==';
const PRIVATE_CRM_INTEGRITY = 'sha512-hpI8KOB+A/Xc66V5kAA8Z74MsTcatFlUEnrg9QiV9r//UWPWtVu1IOz5KKG5YQXpQ2rGW+kXpYsIiZjWel8DjQ==';
const PRIVATE_CRM_SHASUM = 'df125cf3c7a2f323fcc4328d9401bbbbdd04b41a';
const PRIVATE_CRM_SHA256 = '1fadb55fa0be8cf451116e656cf8a5063348a2f37732e435a1d0b9ccc08c1e12';
const PRIVATE_CRM_TREE_SHA256 = '12c25963cfe68631b1e363886bf7001f56c06dc4844b656a1f4a33a5333f8893';
const EXPECTED_WORKSPACE = '/opt/vaysen-workspace';

const sorted = (value) => [...value].sort();
const sameSet = (actual, expected) => JSON.stringify(sorted(actual ?? [])) === JSON.stringify(sorted(expected));

function indentation(line) {
  return line.match(/^ */)[0].length;
}

function unquote(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'")))) return trimmed.slice(1, -1);
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  return trimmed;
}

function nestedSection(lines, name, indent) {
  const prefix = `${' '.repeat(indent)}${name}:`;
  const start = lines.findIndex((line) => line === prefix);
  if (start < 0) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (indentation(line) <= indent) {
      end = index;
      break;
    }
  }
  return lines.slice(start + 1, end);
}

function scalar(lines, name, indent) {
  const pattern = new RegExp(`^ {${indent}}${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\s*(.+?)\\s*$`);
  const match = lines.map((line) => line.match(pattern)).find(Boolean);
  return match ? unquote(match[1]) : undefined;
}

function hasKey(lines, name, indent) {
  const pattern = new RegExp(`^ {${indent}}${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`);
  return lines.some((line) => pattern.test(line));
}

function list(lines, name, indent) {
  const section = nestedSection(lines, name, indent);
  if (!section) return undefined;
  const itemPrefix = `${' '.repeat(indent + 2)}- `;
  return section.filter((line) => line.startsWith(itemPrefix)).map((line) => unquote(line.slice(itemPrefix.length)));
}

function mapping(lines, name, indent) {
  const section = nestedSection(lines, name, indent);
  if (!section) return {};
  const result = {};
  const pattern = new RegExp(`^ {${indent + 2}}([^:#][^:]*):\\s*(.*?)\\s*$`);
  for (const line of section) {
    const match = line.match(pattern);
    if (match) result[match[1].trim()] = unquote(match[2]);
  }
  return result;
}

function namedBlocks(lines, indent) {
  const result = {};
  const pattern = new RegExp(`^ {${indent}}([A-Za-z0-9_-]+):$`);
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(pattern);
    if (!match) continue;
    const block = nestedSection(lines, match[1], indent);
    if (block) result[match[1]] = block;
  }
  return result;
}

export function validateProductionCompose(text) {
  const issues = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const serviceSection = nestedSection(lines, 'services', 0);
  if (!serviceSection) return ['production Compose is missing its services mapping'];
  const services = namedBlocks(serviceSection, 2);
  const gateway = services['openclaw-gateway'];
  const backend = services.backend;
  if (!gateway) return ['openclaw-gateway service is required'];
  if (scalar(gateway, 'image', 4) !== '${OPENCLAW_IMAGE:?OPENCLAW_IMAGE must be the reviewed OpenClaw digest}') {
    issues.push('gateway image must be a required digest-pinned OPENCLAW_IMAGE');
  }
  if (scalar(gateway, 'entrypoint', 4) !== '["/bin/sh", "-c"]'
    || scalar(gateway, 'command', 4) !== '["umask 077; exec node dist/index.js gateway --bind lan --port 18789"]') {
    issues.push('gateway must set umask 077 before starting the fixed OpenClaw command');
  }
  if (hasKey(gateway, 'ports', 4)) issues.push('gateway must not publish a host port');
  if (JSON.stringify(list(gateway, 'expose', 4)) !== JSON.stringify(['18789'])) issues.push('gateway may expose only container port 18789');
  if (!sameSet(list(gateway, 'networks', 4), ['openclaw'])) issues.push('gateway must join only the dedicated openclaw network');
  if (!sameSet(backend ? list(backend, 'networks', 4) : [], ['vaysen-crm', 'openclaw'])) issues.push('backend must bridge vaysen-crm and openclaw networks');
  for (const [name, service] of Object.entries(services)) {
    if (!['backend', 'openclaw-gateway'].includes(name) && (list(service, 'networks', 4) ?? []).includes('openclaw')) {
      issues.push(`${name} must not join the openclaw network`);
    }
  }
  if (scalar(gateway, 'user', 4) !== '${OPENCLAW_DATA_UID:-1000}:${OPENCLAW_DATA_GID:-1000}') issues.push('gateway uid/gid contract changed');
  if (scalar(gateway, 'read_only', 4) !== true || scalar(gateway, 'privileged', 4) === true) issues.push('gateway root filesystem must be read-only and unprivileged');
  if (!sameSet(list(gateway, 'cap_drop', 4), ['ALL'])) issues.push('gateway must drop all Linux capabilities');
  if (!sameSet(list(gateway, 'security_opt', 4), ['no-new-privileges:true'])) issues.push('gateway must enable no-new-privileges');
  const expectedVolumes = [
    '${APP_DATA_DIR:?APP_DATA_DIR must be an approved absolute host path}/openclaw:/home/node/.openclaw',
    './deploy/openclaw/config:/opt/vaysen-config:ro',
    './deploy/openclaw/workspace:/opt/vaysen-workspace:ro',
    './deploy/openclaw/plugins:/opt/vaysen-plugins:ro',
  ];
  const gatewayVolumes = list(gateway, 'volumes', 4) ?? [];
  if (JSON.stringify(gatewayVolumes) !== JSON.stringify(expectedVolumes)) issues.push('gateway volume contract changed');
  if (/(docker\.sock|\.ssh|\/var\/lib\/postgres|\/data:|\/workspace:rw)/i.test(JSON.stringify(gatewayVolumes))) {
    issues.push('gateway contains a forbidden privileged/data mount');
  }
  const env = mapping(gateway, 'environment', 4);
  for (const forbidden of ['DATABASE_URL', 'DB_PASSWORD', 'REDIS_HOST', 'JWT_SECRET', 'ZAI_API_KEY']) {
    if (forbidden in env) issues.push(`gateway must not receive ${forbidden}`);
  }
  if (Object.keys(env).some((key) => key.startsWith('NEXT_PUBLIC_'))) issues.push('gateway must not receive browser environment variables');
  if (env.OPENCLAW_CRM_HMAC_KEY_ID !== '${OPENCLAW_CRM_HMAC_KEY_ID}'
    || env.OPENCLAW_CRM_HMAC_SECRET !== '${OPENCLAW_CRM_HMAC_SECRET}') {
    issues.push('gateway CRM HMAC environment contract changed');
  }
  if (env.NPM_CONFIG_CACHE !== '/tmp/npm-cache'
    || env.npm_config_cache !== '/tmp/npm-cache'
    || env.NPM_CONFIG_UPDATE_NOTIFIER !== 'false'
    || env.NPM_CONFIG_BIN_LINKS !== 'false') {
    issues.push('read-only gateway npm cache must stay on protected /tmp');
  }
  const backendEnv = backend ? mapping(backend, 'environment', 4) : {};
  if (backendEnv.OPENCLAW_GATEWAY_URL !== 'http://openclaw-gateway:18789') issues.push('backend private gateway URL changed');
  if (backendEnv.OPENCLAW_RELEASE_VERSION !== '${OPENCLAW_RUNTIME_VERSION:-2026.7.1}') {
    issues.push('backend OpenClaw release version contract changed');
  }
  const logging = nestedSection(gateway, 'logging', 4) ?? [];
  const loggingOptions = mapping(logging, 'options', 6);
  if (scalar(logging, 'driver', 6) !== 'json-file'
    || loggingOptions['max-size'] !== '5m'
    || loggingOptions['max-file'] !== '2') {
    issues.push('gateway sensitive Docker logs must be capped at 2 x 5 MiB');
  }
  const frontend = services.frontend ?? [];
  const frontendEnv = mapping(frontend, 'environment', 4);
  const frontendBuild = nestedSection(frontend, 'build', 4) ?? [];
  const frontendArgs = mapping(frontendBuild, 'args', 6);
  for (const name of ['OPENCLAW_GATEWAY_TOKEN', 'OPENCLAW_CRM_HMAC_SECRET']) {
    if (Object.prototype.hasOwnProperty.call(frontendEnv, name) || Object.prototype.hasOwnProperty.call(frontendArgs, name)) {
      issues.push(`frontend must never receive ${name}`);
    }
  }
  const networkSection = nestedSection(lines, 'networks', 0);
  const openclawNetwork = networkSection ? nestedSection(networkSection, 'openclaw', 2) : null;
  if (!openclawNetwork || scalar(openclawNetwork, 'driver', 4) !== 'bridge') {
    issues.push('dedicated openclaw bridge network is required');
  }
  return issues;
}

export function validateProductionConfig(text) {
  const issues = [];
  let config;
  try {
    config = JSON.parse(text);
  } catch (error) {
    return [`production OpenClaw config is invalid JSON: ${error.message}`];
  }
  if (config?.gateway?.mode !== 'local' || config?.gateway?.bind !== 'lan') issues.push('gateway must use local mode on its isolated LAN bridge');
  if (config?.gateway?.auth?.mode !== 'token' || config?.gateway?.auth?.token !== '${OPENCLAW_GATEWAY_TOKEN}') {
    issues.push('gateway token authentication is required');
  }
  if (config?.gateway?.http?.endpoints?.chatCompletions?.enabled !== true) issues.push('chat completions endpoint must be explicitly enabled');
  if (config?.logging?.level !== 'warn'
    || config?.logging?.consoleLevel !== 'warn'
    || config?.logging?.maxFileBytes !== 5242880
    || config?.logging?.redactSensitive !== 'tools'
    || Object.prototype.hasOwnProperty.call(config?.logging ?? {}, 'redactPatterns')) {
    issues.push('logging must stay warn/warn with built-in tool redaction and default patterns');
  }
  if (!sameSet(Object.keys(config?.models?.providers ?? {}), ['zhipu-cn'])) issues.push('only the custom zhipu-cn provider may be configured');
  const provider = config?.models?.providers?.['zhipu-cn'];
  if (provider?.baseUrl !== '${ZHIPU_BASE_URL}' || provider?.apiKey !== '${ZHIPU_API_KEY}'
    || provider?.api !== 'openai-completions' || provider?.models?.[0]?.id !== '${ZHIPU_MODEL}'
    || provider?.models?.[0]?.compat?.maxTokensField !== 'max_tokens') {
    issues.push('zhipu-cn provider contract changed');
  }
  if (config?.agents?.defaults?.model?.primary !== 'zhipu-cn/${ZHIPU_MODEL}'
    || config?.agents?.defaults?.workspace !== EXPECTED_WORKSPACE
    || config?.agents?.defaults?.skipBootstrap !== true
    || config?.agents?.list?.length !== 1
    || config.agents.list[0]?.id !== 'vaysen-crm'
    || config.agents.list[0]?.workspace !== EXPECTED_WORKSPACE
    || config.agents.list[0]?.model !== 'zhipu-cn/${ZHIPU_MODEL}') {
    issues.push('vaysen-crm agent/model/read-only bootstrap contract changed');
  }
  const expectedPlugins = ['admin-http-rpc', 'openclaw-weixin', 'vaysen-crm'];
  if (!sameSet(config?.plugins?.allow, expectedPlugins)
    || !sameSet(Object.keys(config?.plugins?.entries ?? {}), expectedPlugins)
    || expectedPlugins.some((id) => config.plugins.entries[id]?.enabled !== true)) {
    issues.push('enabled plugin allowlist must contain exactly the reviewed three plugins');
  }
  if (/\bzai\b/i.test(JSON.stringify(config?.plugins ?? {}))) issues.push('unused ZAI provider plugin is forbidden');
  if (config?.channels?.['openclaw-weixin']?.enabled !== true
    || config?.session?.dmScope !== 'per-account-channel-peer') {
    issues.push('Weixin channel/session isolation contract changed');
  }
  const expectedTools = [
    'crm_work_brief', 'crm_customer_search', 'crm_customer_get',
    'crm_customer_add_note', 'crm_customer_update', 'crm_customer_set_stage', 'crm_task_create',
    'crm_order_list', 'crm_order_create_draft', 'crm_order_update_stage',
    'crm_quote_list', 'crm_quote_create_draft', 'crm_product_search',
    'crm_start_background_research', 'crm_prepare_quote_delivery',
    'crm_whatsapp_messages_read', 'crm_whatsapp_send_text', 'crm_whatsapp_send_quote',
    'crm_email_messages_read', 'crm_email_send', 'crm_email_reply',
    'heartbeat_respond', 'tts',
  ];
  if (config?.tools?.profile !== 'coding'
    || Object.hasOwn(config?.tools ?? {}, 'allow')
    || !sameSet(config?.tools?.alsoAllow, expectedTools)) {
    issues.push('the business-supervisor agent must use the reviewed coding profile and exact tool extension set');
  }
  const expectedDeniedTools = [
    'exec', 'process', 'gateway', 'nodes', 'message', 'browser', 'browser-automation',
  ];
  if (!sameSet(config?.tools?.deny, expectedDeniedTools)) {
    issues.push('tools.deny must keep the exact infrastructure-bypass boundary');
  }
  const exposedTools = [
    ...(config?.tools?.allow ?? []),
    ...(config?.tools?.alsoAllow ?? []),
  ].map((tool) => String(tool).trim().toLowerCase());
  if (exposedTools.some((tool) => (
    tool === 'browser'
    || tool === 'browser-automation'
    || tool.startsWith('browser.')
    || tool.startsWith('browser_')
  ))) {
    issues.push('production Supervisor must not expose general browser or browser-automation tools');
  }
  if (config?.tools?.elevated?.enabled !== false || config?.tools?.fs?.workspaceOnly !== true) issues.push('elevated/filesystem tool boundary changed');
  return issues;
}

export function validateProductionArtifacts(files) {
  const issues = [];
  const replaySafeConfig = "compose_run_sandboxed_phase 'write replay-safe installation configuration'";
  const replaySafeConfigIndex = files.prepare.indexOf(replaySafeConfig);
  const replaySafeCopyIndex = files.prepare.indexOf(
    'cp /opt/vaysen-config/openclaw.install-private.json "$OPENCLAW_CONFIG_PATH.next"',
    replaySafeConfigIndex,
  );
  const firstWeixinInstallIndex = files.prepare.indexOf('install_verified_weixin "$WEIXIN_SPEC"');
  if (replaySafeConfigIndex < 0
    || replaySafeCopyIndex < replaySafeConfigIndex
    || firstWeixinInstallIndex < replaySafeCopyIndex
    || files.prepare.includes('cp /opt/vaysen-config/openclaw.install-bootstrap.json "$OPENCLAW_CONFIG_PATH.next"')) {
    issues.push('prepare replay-safe plugin configuration contract is missing');
  }
  const privateInstallIndex = files.prepare.indexOf('install_verified_private_crm "$PRIVATE_CRM_NAME"');
  const retainedPruneIndex = files.prepare.indexOf("compose_run_sandboxed_phase 'prune inactive retained npm generations'");
  const managedAuditIndex = files.prepare.indexOf("compose_run_sandboxed_phase 'audit managed plugin installation'");
  if (privateInstallIndex < 0
    || retainedPruneIndex < privateInstallIndex
    || managedAuditIndex < retainedPruneIndex
    || !files.prepare.includes('/app/dist/managed-npm-retention-BTuFzcN9.js')
    || !files.prepare.includes('readOpenClawInstallRecords(path.join(stateDir, "state", "openclaw.sqlite"))')
    || !files.prepare.includes('activeInstallPaths,')
    || !files.prepare.includes('if (failures.length > 0) throw new AggregateError')) {
    issues.push('fail-closed retained managed generation cleanup contract is missing');
  }
  if (!files.prepare.includes(`OPENCLAW_IMAGE_PIN='${EXPECTED_IMAGE}'`)) issues.push('prepare script image digest changed');
  const privatePackage = JSON.parse(files.privatePackage);
  const privateShrinkwrap = JSON.parse(files.shrinkwrap);
  if (privatePackage?.dependencies?.typebox !== TYPEBOX_VERSION
    || privateShrinkwrap?.packages?.['']?.dependencies?.typebox !== TYPEBOX_VERSION
    || privateShrinkwrap?.packages?.['node_modules/typebox']?.version !== TYPEBOX_VERSION
    || privateShrinkwrap?.packages?.['node_modules/typebox']?.integrity !== TYPEBOX_INTEGRITY
    || !files.hostVerifier.includes("EXPECTED_OPENCLAW_VERSION = '2026.7.1'")
    || !files.hostVerifier.includes('packageJson?.dependencies?.typebox !== expectedTypeboxVersion')
    || !files.hostVerifier.includes("readTopLevelWorkspaceOverride(workspaceText, 'typebox')")
    || !files.hostVerifier.includes("path.join(resolvedRoot, 'node_modules', 'typebox', 'package.json')")
    || !files.prepare.includes('verify-host-contract.mjs "$TYPEBOX_VERSION"')
    || !files.audit.includes('verifyOpenClawHostContractFiles')) {
    issues.push('private CRM TypeBox pin must match the fail-closed OpenClaw host dependency/override contract');
  }
  if (privatePackage?.name !== '@vaysen/openclaw-crm-tools'
    || privatePackage?.version !== '1.3.2'
    || !files.readme.includes('`@vaysen/openclaw-crm-tools@1.3.2`')
    || !files.readme.includes('21 个 `vaysen-crm` 工具')
    || !files.readme.includes('OutboundComplianceService')
    || !files.readme.includes('ExternalActionOutbox')
    || !files.readme.includes('人工审批或短期授权')) {
    issues.push('private CRM README must match the reviewed 1.3.2, 21-tool, human-gated Guard/Outbox contract');
  }
  const privateInstallConfig = JSON.parse(files.privateInstallConfig);
  const privateInstallPlugins = privateInstallConfig?.plugins;
  const privateInstallEntries = privateInstallPlugins?.entries;
  const privateInstallEntry = privateInstallConfig?.plugins?.entries?.['vaysen-crm'];
  const privateInstallEntryConfig = privateInstallEntry?.config;
  if (privateInstallConfig?.plugins?.enabled !== true
    || privateInstallEntry?.enabled !== true
    || privateInstallEntryConfig?.apiBaseUrl !== 'http://backend:4000'
    || privateInstallEntryConfig?.keyId !== '${OPENCLAW_CRM_HMAC_KEY_ID}'
    || privateInstallEntryConfig?.hmacSecret !== '${OPENCLAW_CRM_HMAC_SECRET}'
    || privateInstallEntryConfig?.requestTimeoutMs !== 15000
    || !sameSet(Object.keys(privateInstallConfig ?? {}), ['plugins'])
    || !sameSet(Object.keys(privateInstallPlugins ?? {}), ['enabled', 'entries'])
    || !sameSet(Object.keys(privateInstallEntries ?? {}), ['vaysen-crm'])
    || !sameSet(Object.keys(privateInstallEntry ?? {}), ['enabled', 'config'])
    || !sameSet(Object.keys(privateInstallEntryConfig ?? {}), ['apiBaseUrl', 'keyId', 'hmacSecret', 'requestTimeoutMs'])) {
    issues.push('private CRM installation config must remain minimal and use redacted environment references');
  }
  if (!files.prepare.includes(WEIXIN_INTEGRITY)) issues.push('Weixin npm integrity pin is missing');
  if (!files.prepare.includes(WEIXIN_PATCHED_INTEGRITY)
    || !files.prepare.includes(WEIXIN_PATCH_SHA256)
    || !files.prepare.includes('plugins install "npm-pack:$patched_artifact" --force')
    || files.prepare.includes('plugins install "npm-pack:$upstream_artifact" --force')) {
    issues.push('Weixin reviewed patch/install-only-patched artifact contract is missing');
  }
  const npmPackInstalls = files.prepare.match(/plugins install "npm-pack:\$[A-Za-z_][A-Za-z0-9_]*" --force/g)?.length ?? 0;
  if (!files.prepare.includes(PRIVATE_CRM_INTEGRITY)
    || !files.prepare.includes(PRIVATE_CRM_SHASUM)
    || !files.prepare.includes(PRIVATE_CRM_SHA256)
    || !files.prepare.includes(PRIVATE_CRM_TREE_SHA256)
    || !files.audit.includes(PRIVATE_CRM_INTEGRITY)
    || !files.audit.includes(PRIVATE_CRM_SHASUM)
    || !files.audit.includes(PRIVATE_CRM_SHA256)
    || !files.audit.includes(PRIVATE_CRM_TREE_SHA256)
    || !files.prepare.includes('plugins install "npm-pack:$private_artifact" --force')
    || files.prepare.includes('plugins install /opt/vaysen-plugins/vaysen-crm')
    || !files.prepare.includes('cmp "$artifact_a" "$artifact_b"')
    || !files.prepare.includes('for relative in package.json npm-shrinkwrap.json openclaw.plugin.json README.md dist/index.js dist/runtime.js')
    || !files.prepare.includes('chmod 644 "$target"')
    || !files.prepare.includes('npm pack "$package_source" --ignore-scripts --json --offline')
    || !files.audit.includes('verifyPrivateNpmPackSupplyChain')
    || npmPackInstalls !== 2) {
    issues.push('private CRM deterministic npm-pack/install-record supply-chain contract is missing');
  }
  if (!files.patch.includes('"patchId": "vaysen-weixin-in-app-qr-owner-digest-6"')
    || !files.patch.includes('gatewayMethods: [\\"web.login.start\\", \\"web.login.wait\\"]')
    || !files.patch.includes('normalizeAccountId(params.accountId || result.accountId)')
    || !files.patch.includes('ownerPeerDigest')
    || !files.patch.includes('createHash(\\"sha256\\").update(ownerPeerId, \\"utf8\\").digest(\\"hex\\")')
    || !files.patch.includes('result.alreadyConnected === true')
    || !files.patch.includes('GROUP_REJECTED')
    || !files.patch.includes('NON_OWNER_REJECTED')
    || !files.patch.includes('SenderId: from_user_id')
    || !files.patch.includes('ctx.OwnerAllowFrom = [senderId]')
    || !files.patch.includes('trustedOwnerIds.includes(senderId)')
    || !files.evidence.includes('JYACC_GROUP_[a-f0-9]{16}')
    || !files.evidence.includes('JYACC_NONOWNER_[a-f0-9]{16}')) {
    issues.push('Weixin direct-only/sanitized acceptance evidence patch is missing');
  }
  const liveAuditModes = files.prepare.match(/-e OPENCLAW_AUDIT_MODE=live --entrypoint node openclaw-gateway/g)?.length ?? 0;
  if (!files.audit.includes('verifyManagedStateEntries')
    || !files.audit.includes("path.join(nodeModules, 'openclaw')")
    || !files.audit.includes('registered plugin OpenClaw peer target mismatch')
    || !files.audit.includes('managed installPath is outside the OpenClaw npm state root')
    || !files.audit.includes("relativePath: 'plugin-skills/browser-automation'")
    || !files.audit.includes("target: '/app/dist/extensions/browser/skills/browser-automation'")
    || !files.audit.includes("auditMode !== 'strict' && auditMode !== 'live'")
    || liveAuditModes !== 2) {
    issues.push('managed OpenClaw peer-link allowlist verifier is missing');
  }
  if (!files.prepare.includes(TYPEBOX_INTEGRITY) || !files.shrinkwrap.includes(TYPEBOX_INTEGRITY)) issues.push('typebox lock/integrity evidence is missing');
  if (!files.prepare.includes(QRCODE_INTEGRITY)
    || !files.prepare.includes(ZOD_INTEGRITY)
    || !files.prepare.includes("ZOD_SPEC='zod@4.3.6'")) {
    issues.push('Weixin transitive dependency pins are missing');
  }
  if (/zai-provider|OPENCLAW_ZAI_PLUGIN_VERSION/.test(files.prepare)) issues.push('unused ZAI provider installation is forbidden');
  const forcedOfflineInstalls = files.prepare.match(/-e NPM_CONFIG_OFFLINE=true -e npm_config_offline=true/g)?.length ?? 0;
  const cacheWarmContractUses = files.prepare.match(/\bwarm_verified_install_cache\b/g)?.length ?? 0;
  if (!files.prepare.includes('PREPARE_NPM_CACHE_HOST="$APP_DATA_DIR/openclaw/.prepare-npm-cache"')
    || !files.prepare.includes('-v "$PREPARE_NPM_CACHE_HOST:/tmp/npm-cache"')
    || !files.prepare.includes('-v "$PREPARE_NPM_CACHE_HOST:/home/node/.npm"')
    || !files.prepare.includes('NPM_CONFIG_USERCONFIG=/opt/vaysen-config/npm-user.empty')
    || !files.prepare.includes('NPM_CONFIG_GLOBALCONFIG=/opt/vaysen-config/npm-global.empty')
    || !files.prepare.includes('--cache "$NPM_CONFIG_CACHE" --update-notifier=false')
    || !files.prepare.includes('verify_pack "$offline_stage" offline')
    || cacheWarmContractUses !== 2
    || !files.prepare.includes('npm install --package-lock-only --ignore-scripts')
    || !files.prepare.includes('npm install --offline --ignore-scripts')
    || !files.prepare.includes('verify_lock "$offline_stage"')
    || !files.prepare.includes('test "$default_cache" = /home/node/.npm')
    || !files.prepare.includes('npm config get offline --location=project')
    || !files.prepare.includes('OpenClaw state contains a forbidden npm project configuration')
    || !files.prepare.includes('.vaysen-cache-alias-$$')
    || !files.prepare.includes('write private CRM installation configuration')
    || !files.prepare.includes('openclaw.install-private.json')
    || forcedOfflineInstalls !== 2
    || !files.prepare.includes("docker_root_phase 'remove transient npm preparation cache'")) {
    issues.push('verified persistent cache and offline-only plugin installation contract is missing');
  }
  if (!files.prepare.includes('find /target/openclaw -xdev -type d -exec chmod 700')
    || !files.prepare.includes('find /target/openclaw -xdev -type f -exec chmod 600')
    || !files.readme.includes('2 × 5 MiB')) {
    issues.push('protected OpenClaw state/report and short log-retention contract is missing');
  }
  const requiredWorkspaceFiles = ['AGENTS.md', 'SOUL.md', 'TOOLS.md', 'IDENTITY.md', 'USER.md', 'HEARTBEAT.md'];
  if (requiredWorkspaceFiles.some((name) => typeof files.workspace?.[name] !== 'string')) {
    issues.push('reviewed read-only workspace file contract is missing');
  }
  if (!/^# IDENTITY\.md — JY AI 业务助理$/m.test(files.workspace?.['IDENTITY.md'] ?? '')
    || !/Vaysen包装（Vaysen Packaging）/.test(files.workspace?.['USER.md'] ?? '')
    || !/不配置任何自主心跳任务/.test(files.workspace?.['HEARTBEAT.md'] ?? '')) {
    issues.push('reviewed workspace identity, owner context, or disabled-heartbeat policy is missing');
  }
  const markerPolicy = `${files.workspace?.['TOOLS.md'] ?? ''}\n${files.workspace?.['AGENTS.md'] ?? ''}`;
  if (!markerPolicy.includes('JYACC_OWNER_[a-f0-9]{16}')
    || !markerPolicy.includes('acceptanceMarker')
    || !markerPolicy.includes('crm_work_brief')
    || !markerPolicy.includes('调用一次')) {
    issues.push('deterministic owner acceptance-marker routing policy is missing');
  }
  if (/never leave the gateway process or appear in logs|without logging the raw Weixin id/i.test(
    `${files.login}\n${files.readme}`,
  )) {
    issues.push('Weixin privacy documentation contains an inaccurate no-raw-log claim');
  }
  const manifest = JSON.parse(files.manifest);
  if (manifest?.configSchema?.properties?.hmacSecret?.minLength !== 48) issues.push('plugin HMAC secret schema must require 48 characters');
  if (!files.runtime.includes('\\/api\\/internal\\/openclaw\\/tools\\/')
    || !/Buffer\.byteLength\(config\.hmacSecret, 'utf8'\)\s*<\s*48/.test(files.runtime)) {
    issues.push('plugin broker path or 48-byte HMAC runtime contract is missing');
  }
  if (!files.runtime.includes("const HTTP_INGRESS_CHANNEL = 'webchat';")
    || !files.runtime.includes("const CRM_HTTP_SESSION_PATTERN = /^agent:vaysen-crm:(vaysen-crm:[a-f0-9]{64})$/;")
    || !files.runtime.includes('channel === HTTP_INGRESS_CHANNEL')
    || !files.runtime.includes('toolContext.senderIsOwner === false')
    || !files.runtime.includes('sessionKey: crmSessionKey')
    || files.runtime.includes('const isCrmGatewayOwner = channel === CRM_CHANNEL')) {
    issues.push('plugin HTTP ingress must use the registered webchat transport, fixed false owner bit, and canonical agent session');
  }
  if (!files.index.includes("path: '/api/internal/openclaw/tools/work-brief'")
    || !files.index.includes("path: '/api/internal/openclaw/tools/start-background-research'")
    || !files.index.includes("path: '/api/internal/openclaw/tools/prepare-quote-delivery'")
    || !files.index.includes('selectionTokenProperty = () => Type.Optional(Type.String({ maxLength: 128 }))')
    || !files.index.includes('const trustedParams = useExactSelectionToken(baseActor, name, params)')
    || !files.index.includes('selectionToken: normalizeSelectionToken(params.selectionToken)')
    || files.index.includes("conversationId: Type.String({ format: 'uuid' })")) {
    issues.push('plugin exact backend route/action parameter contract is missing');
  }
  if (!files.login.includes("createHash('sha256').update(ownerId, 'utf8')")
    || !files.login.includes('OPENCLAW_WECHAT_OWNER_PEER_SHA256=')
    || !files.login.includes('channels status --json --probe')) {
    issues.push('Weixin owner digest enrollment/probe contract is missing');
  }
  if (!files.smoke.includes("model: 'openclaw/vaysen-crm'")
    || !files.smoke.includes("'x-openclaw-agent-id': 'vaysen-crm'")
    || !files.smoke.includes("'x-openclaw-message-channel': 'webchat'")
    || files.smoke.includes('model: `zhipu/')) {
    issues.push('real model smoke must target the fixed vaysen-crm agent context');
  }
  if (!files.smoke.includes('const sanitizeDetail = (value)')
    || !files.smoke.includes('model smoke failed: ${JSON.stringify(safeFailure)}')
    || !files.smoke.includes('runtime-created OpenClaw state remains restricted to 0700/0600')
    || files.smoke.includes('throw new Error(`model smoke HTTP ${modelResponse.status}`)')) {
    issues.push('real model smoke must preserve sanitized failure evidence and enforce runtime state modes');
  }
  return issues;
}

export function main() {
  let files;
  try {
    files = {
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
  } catch (error) {
    console.error(`FAIL: unable to read production OpenClaw inputs: ${error.message}`);
    return 2;
  }
  const issues = [
    ...validateProductionCompose(read('docker-compose.prod.yml')),
    ...validateProductionConfig(read('deploy', 'openclaw', 'config', 'openclaw.production.json')),
    ...validateProductionArtifacts(files),
  ];
  if (issues.length) {
    for (const issue of issues) console.error(`FAIL: ${issue}`);
    return 1;
  }
  console.log('PASS: production OpenClaw isolation, supply-chain, model, plugin and smoke contracts passed.');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
