#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const defaultComposePath = path.join(
  projectRoot,
  'deploy',
  'openclaw-poc',
  'compose.openclaw-poc.yml',
);
const defaultConfigPath = path.join(
  projectRoot,
  'deploy',
  'openclaw-poc',
  'config',
  'openclaw.readonly.json',
);

const DIGEST_IMAGE_RE = /^(?:ghcr\.io\/openclaw\/openclaw|openclaw\/openclaw)@sha256:[a-f0-9]{64}$/;
const SECRET_PLACEHOLDER_RE = /(?:replace|example|changeme|your[_-]?|<|>)/i;

function exactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}

export function validateComposeContract(text) {
  const issues = [];
  let compose;
  try {
    compose = yaml.load(text, { json: false });
  } catch (error) {
    return [`Compose template must be valid YAML without duplicate keys: ${error.message}`];
  }

  if (!exactKeys(compose, ['name', 'services', 'networks', 'volumes'])) {
    issues.push('Compose root keys must be exactly name, services, networks and volumes');
  }
  if (compose?.name !== 'vaysen-openclaw-readonly-poc') issues.push('Compose project name is fixed');
  if (!exactKeys(compose?.services, ['openclaw-gateway'])) {
    issues.push('Compose must define exactly one service named openclaw-gateway');
  }

  const service = compose?.services?.['openclaw-gateway'];
  const serviceKeys = [
    'image', 'pull_policy', 'profiles', 'user', 'init', 'read_only', 'restart',
    'environment', 'volumes', 'tmpfs', 'cap_drop', 'security_opt', 'networks',
    'command', 'healthcheck',
  ];
  if (!exactKeys(service, serviceKeys)) issues.push('openclaw-gateway contains missing or unreviewed service keys');
  if (!/^\$\{OPENCLAW_IMAGE:\?[^}\r\n]+\}$/.test(service?.image ?? '')) {
    issues.push('image must be provided through a required OPENCLAW_IMAGE variable with no fallback');
  }
  if (JSON.stringify(service?.profiles) !== JSON.stringify(['openclaw-poc-readonly'])) {
    issues.push('service must require only the openclaw-poc-readonly profile');
  }
  if (service?.user !== '1000:1000') issues.push('service must run as uid/gid 1000');
  if (service?.init !== true || service?.read_only !== true || service?.restart !== 'no') {
    issues.push('service must use init, a read-only root filesystem and restart=no');
  }
  if (service?.pull_policy !== 'always') issues.push('service pull_policy must be always');

  const expectedEnvironmentKeys = [
    'HOME', 'OPENCLAW_HOME', 'OPENCLAW_STATE_DIR', 'OPENCLAW_CONFIG_PATH',
    'OPENCLAW_GATEWAY_TOKEN', 'OPENCLAW_LOG_LEVEL',
  ];
  if (!exactKeys(service?.environment, expectedEnvironmentKeys)) {
    issues.push('service environment contains missing or unreviewed variables');
  }
  if (!/^\$\{OPENCLAW_POC_GATEWAY_TOKEN:\?[^}\r\n]+\}$/.test(service?.environment?.OPENCLAW_GATEWAY_TOKEN ?? '')) {
    issues.push('gateway token must be a required runtime secret placeholder');
  }

  const expectedVolumes = [
    'openclaw_poc_state:/home/node/.openclaw',
    './config/openclaw.readonly.json:/etc/openclaw/openclaw.json:ro',
  ];
  if (JSON.stringify(service?.volumes) !== JSON.stringify(expectedVolumes)) {
    issues.push('service volumes must be exactly the dedicated state volume and reviewed read-only config');
  }
  const expectedTmpfs = [
    '/tmp:rw,noexec,nosuid,nodev,size=128m,mode=1777',
    '/home/node/.openclaw/workspace:rw,noexec,nosuid,nodev,size=64m,uid=1000,gid=1000,mode=0700',
  ];
  if (JSON.stringify(service?.tmpfs) !== JSON.stringify(expectedTmpfs)) issues.push('service tmpfs contract changed');
  if (JSON.stringify(service?.cap_drop) !== JSON.stringify(['ALL'])) issues.push('all Linux capabilities must be dropped');
  if (JSON.stringify(service?.security_opt) !== JSON.stringify(['no-new-privileges:true'])) {
    issues.push('no-new-privileges must be enabled');
  }
  if (JSON.stringify(service?.networks) !== JSON.stringify(['openclaw_poc_internal'])) {
    issues.push('service must join only the dedicated internal network');
  }
  const expectedCommand = ['node', 'dist/index.js', 'gateway', '--bind', 'loopback', '--port', '18789'];
  if (JSON.stringify(service?.command) !== JSON.stringify(expectedCommand)) issues.push('gateway command must bind only to loopback');

  if (!exactKeys(service?.healthcheck, ['test', 'interval', 'timeout', 'retries', 'start_period'])) {
    issues.push('healthcheck contains missing or unreviewed keys');
  }
  if (!Array.isArray(service?.healthcheck?.test) || !service.healthcheck.test.join(' ').includes('127.0.0.1:18789/healthz')) {
    issues.push('healthcheck must probe the loopback /healthz endpoint');
  }
  if (!exactKeys(compose?.networks, ['openclaw_poc_internal']) || compose.networks.openclaw_poc_internal?.internal !== true) {
    issues.push('the dedicated OpenClaw network must be the only network and must be internal');
  }
  if (!exactKeys(compose?.volumes, ['openclaw_poc_state'])) {
    issues.push('only the dedicated OpenClaw state volume may be declared');
  }

  return issues;
}

export function validateOpenClawConfig(configText) {
  const issues = [];
  let config;
  try {
    config = JSON.parse(configText);
  } catch (error) {
    return [`OpenClaw config must be strict JSON: ${error.message}`];
  }

  if (!exactKeys(config, ['gateway', 'tools'])) {
    issues.push('PoC config may contain only the reviewed gateway and tools sections');
  }

  if (!exactKeys(config?.gateway, ['mode', 'bind', 'auth'])) {
    issues.push('gateway may contain only mode, bind and auth');
  }
  if (!exactKeys(config?.gateway?.auth, ['mode'])) {
    issues.push('gateway.auth may contain only mode');
  }
  if (!exactKeys(config?.tools, ['profile', 'deny', 'exec', 'elevated'])) {
    issues.push('tools may contain only profile, deny, exec and elevated');
  }
  if (!exactKeys(config?.tools?.exec, ['mode'])) {
    issues.push('tools.exec may contain only mode');
  }
  if (!exactKeys(config?.tools?.elevated, ['enabled'])) {
    issues.push('tools.elevated may contain only enabled');
  }

  if (config?.gateway?.mode !== 'local') issues.push('gateway.mode must be local');
  if (config?.gateway?.bind !== 'loopback') issues.push('gateway.bind must be loopback');
  if (config?.gateway?.auth?.mode !== 'token') issues.push('gateway.auth.mode must be token');
  if (config?.tools?.profile !== 'minimal') issues.push('tools.profile must be minimal');
  if (config?.tools?.exec?.mode !== 'deny') issues.push('tools.exec.mode must be deny');
  if (config?.tools?.elevated?.enabled !== false) issues.push('elevated tools must be disabled');
  if (config?.tools?.allow || config?.tools?.alsoAllow || config?.tools?.toolsBySender || config?.tools?.byProvider) {
    issues.push('additive or sender/provider-specific tool grants are forbidden in the read-only PoC');
  }

  const denied = new Set(config?.tools?.deny ?? []);
  for (const tool of [
    'group:runtime',
    'group:fs',
    'group:ui',
    'group:nodes',
    'group:automation',
    'group:messaging',
    'group:plugins',
    'exec',
    'process',
    'code_execution',
    'bash',
    'write',
    'edit',
    'apply_patch',
    'nodes',
    'gateway',
    'message',
  ]) {
    if (!denied.has(tool)) issues.push(`tools.deny must include ${tool}`);
  }

  if (/ZAI_API_KEY|OPENCLAW_GATEWAY_TOKEN|sk-[A-Za-z0-9_-]{12,}/.test(configText)) {
    issues.push('secrets must not be embedded in the OpenClaw config');
  }

  return issues;
}

export function validateRuntimeEnvironment(env) {
  const issues = [];
  if (!DIGEST_IMAGE_RE.test(env.OPENCLAW_IMAGE ?? '')) {
    issues.push('OPENCLAW_IMAGE must be an official image pinned by a 64-hex sha256 digest');
  }
  for (const name of ['OPENCLAW_POC_GATEWAY_TOKEN']) {
    const value = env[name] ?? '';
    if (value.length < 32 || SECRET_PLACEHOLDER_RE.test(value)) {
      issues.push(`${name} must be a non-placeholder runtime secret of at least 32 characters`);
    }
  }
  return issues;
}

function parseArgs(argv) {
  const options = {
    template: false,
    composePath: defaultComposePath,
    configPath: defaultConfigPath,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--template') options.template = true;
    else if (value === '--compose') options.composePath = path.resolve(argv[++index] ?? '');
    else if (value === '--config') options.configPath = path.resolve(argv[++index] ?? '');
    else throw new Error(`Unknown argument: ${value}`);
  }
  return options;
}

export function main(argv = process.argv.slice(2), env = process.env) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(error.message);
    return 2;
  }

  let composeText;
  let configText;
  try {
    composeText = fs.readFileSync(options.composePath, 'utf8');
    configText = fs.readFileSync(options.configPath, 'utf8');
  } catch (error) {
    console.error(`Unable to read PoC inputs: ${error.message}`);
    return 2;
  }

  const issues = [
    ...validateComposeContract(composeText),
    ...validateOpenClawConfig(configText),
    ...(options.template ? [] : validateRuntimeEnvironment(env)),
  ];

  if (issues.length > 0) {
    for (const issue of issues) console.error(`FAIL: ${issue}`);
    return 1;
  }

  console.log(options.template
    ? 'PASS: OpenClaw read-only PoC template satisfies the static security contract.'
    : 'PASS: OpenClaw read-only PoC template and runtime environment satisfy the static security contract.');
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
