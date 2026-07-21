#!/usr/bin/env node
// Fail-closed production environment validation. Secret values are never
// printed; diagnostics name only the offending variable and contract.

import fs from 'node:fs';
import path from 'node:path';

const envPath = path.resolve(process.argv[2] || '.env');

function fail(message) {
  console.error(`[ENV ERROR] ${message}`);
  process.exitCode = 1;
}

function parseEnv(text) {
  const values = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values.set(match[1], value);
  }
  return values;
}

if (!fs.existsSync(envPath) || fs.lstatSync(envPath).isSymbolicLink()) {
  console.error(`[ENV ERROR] environment file is missing or symlinked: ${envPath}`);
  process.exit(1);
}

const env = parseEnv(fs.readFileSync(envPath, 'utf8'));
const get = (name) => env.get(name) ?? '';
const placeholders = /(change[-_ ]?me|replace[-_ ]?me|example|not-a-real|your[_-]|password123|secret123|defaultsecret)/i;

function requireSecret(name, minLength) {
  const value = get(name);
  if (value.length < minLength) fail(`${name} must contain at least ${minLength} characters`);
  if (placeholders.test(value)) fail(`${name} contains a placeholder value`);
}

requireSecret('DB_PASSWORD', 16);
requireSecret('JWT_SECRET', 32);
requireSecret('JWT_REFRESH_SECRET', 32);
requireSecret('EMAIL_ENCRYPTION_KEY', 16);
requireSecret('N8N_ENCRYPTION_KEY', 32);
requireSecret('ZHIPU_API_KEY', 16);
requireSecret('OPENCLAW_GATEWAY_TOKEN', 32);
if (Buffer.byteLength(get('OPENCLAW_CRM_HMAC_SECRET'), 'utf8') < 48) {
  fail('OPENCLAW_CRM_HMAC_SECRET must contain at least 48 UTF-8 bytes');
}
if (placeholders.test(get('OPENCLAW_CRM_HMAC_SECRET'))) {
  fail('OPENCLAW_CRM_HMAC_SECRET contains a placeholder value');
}
if (get('JWT_SECRET') === get('JWT_REFRESH_SECRET')) {
  fail('JWT_SECRET and JWT_REFRESH_SECRET must be distinct');
}
for (const other of [
  'DB_PASSWORD',
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  'EMAIL_ENCRYPTION_KEY',
  'N8N_ENCRYPTION_KEY',
  'ZHIPU_API_KEY',
]) {
  if (get('OPENCLAW_GATEWAY_TOKEN') === get(other)) {
    fail(`OPENCLAW_GATEWAY_TOKEN must be distinct from ${other}`);
  }
  if (get('OPENCLAW_CRM_HMAC_SECRET') === get(other)) {
    fail(`OPENCLAW_CRM_HMAC_SECRET must be distinct from ${other}`);
  }
}
if (get('OPENCLAW_GATEWAY_TOKEN') === get('OPENCLAW_CRM_HMAC_SECRET')) {
  fail('OPENCLAW_GATEWAY_TOKEN and OPENCLAW_CRM_HMAC_SECRET must be distinct');
}

if (get('OPENCLAW_ENABLED') !== 'true') fail('OPENCLAW_ENABLED must equal true for this release');
if (get('OPENCLAW_RUNTIME_VERSION') !== '2026.7.1') fail('OPENCLAW_RUNTIME_VERSION must equal 2026.7.1');
if (get('OPENCLAW_WEIXIN_PLUGIN_VERSION') !== '2.4.6') {
  fail('OPENCLAW_WEIXIN_PLUGIN_VERSION must equal 2.4.6');
}
if (get('OPENCLAW_DATA_UID') !== '1000' || get('OPENCLAW_DATA_GID') !== '1000') {
  fail('OPENCLAW_DATA_UID and OPENCLAW_DATA_GID must both equal 1000');
}
if (!/^[A-Za-z0-9._-]{3,64}$/.test(get('OPENCLAW_CRM_HMAC_KEY_ID'))) {
  fail('OPENCLAW_CRM_HMAC_KEY_ID must contain 3-64 safe identifier characters');
}
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(get('OPENCLAW_OWNER_EMAIL'))) {
  fail('OPENCLAW_OWNER_EMAIL must be an explicit company owner email');
}
if (!/^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/.test(get('OPENCLAW_OWNER_COMPANY_SLUG'))) {
  fail('OPENCLAW_OWNER_COMPANY_SLUG must be an explicit existing company slug');
}
const ownerPeerDigest = get('OPENCLAW_WECHAT_OWNER_PEER_SHA256');
if (ownerPeerDigest && !/^[a-f0-9]{64}$/.test(ownerPeerDigest)) {
  fail('OPENCLAW_WECHAT_OWNER_PEER_SHA256 must be empty before pairing or exactly 64 lowercase hex characters');
}

const validatePrivateBindIp = (name, value) => {
  if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(value)
    || value.split('.').some((part) => Number(part) > 255)
    || ['0.0.0.0', '127.0.0.1'].includes(value)) {
    fail(`${name} must be an explicit non-loopback IPv4 address`);
  }
  const [a, b] = value.split('.').map(Number);
  if (!(a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168))) {
    fail(`${name} must be an RFC1918/ZeroTier IPv4 address`);
  }
};

const lanIp = get('LAN_BIND_IP');
validatePrivateBindIp('LAN_BIND_IP', lanIp);
const approvedLanIp = get('APPROVED_LAN_BIND_IP');
if (lanIp !== approvedLanIp) {
  fail('LAN_BIND_IP must exactly match APPROVED_LAN_BIND_IP');
}
const localLanIp = get('LOCAL_LAN_BIND_IP');
validatePrivateBindIp('LOCAL_LAN_BIND_IP', localLanIp);
if (localLanIp !== get('APPROVED_LOCAL_LAN_BIND_IP')) {
  fail('LOCAL_LAN_BIND_IP must exactly match APPROVED_LOCAL_LAN_BIND_IP');
}
if (localLanIp === lanIp) {
  fail('LOCAL_LAN_BIND_IP must differ from the stable ZeroTier LAN_BIND_IP');
}
const lanOrigin = `http://${lanIp}`;
const localLanOrigin = `http://${localLanIp}`;
if (get('FRONTEND_URL') !== lanOrigin) fail(`FRONTEND_URL must equal ${lanOrigin}`);
if (get('API_BASE_URL') !== `${lanOrigin}/api`) fail(`API_BASE_URL must equal ${lanOrigin}/api`);
if (get('CORS_ORIGIN') !== `${lanOrigin},${localLanOrigin}`) {
  fail(`CORS_ORIGIN must equal ${lanOrigin},${localLanOrigin}`);
}
if (get('NEXT_PUBLIC_API_URL') !== '/api') fail('NEXT_PUBLIC_API_URL must equal /api');
if (get('ENABLE_SWAGGER') !== 'false') fail('ENABLE_SWAGGER must equal false for the LAN release');

const whatsappProxy = get('WHATSAPP_PROXY');
if (whatsappProxy) {
  try {
    const url = new URL(whatsappProxy);
    if (!['http:', 'https:', 'socks4:', 'socks5:', 'socks5h:'].includes(url.protocol)
      || !url.hostname || !url.port || url.pathname !== '/' || url.search || url.hash
      || placeholders.test(url.hostname)) {
      throw new Error('unsafe WhatsApp proxy URL');
    }
  } catch {
    fail('WHATSAPP_PROXY must be empty or an explicit http(s)/socks proxy URL with host and port');
  }
}

const appDataDir = get('APP_DATA_DIR');
if (!/^\/[A-Za-z0-9._/-]+$/.test(appDataDir) || appDataDir === '/'
  || appDataDir.split('/').includes('..')) {
  fail('APP_DATA_DIR must be a safe absolute Linux path below / without traversal or shell metacharacters');
}

if (!/^(true|false)$/.test(get('EMAIL_SEND_DISABLED'))) {
  fail('EMAIL_SEND_DISABLED must be explicitly true or false');
}
if (!/^(true|false)$/.test(get('WHATSAPP_RESTORE_SESSIONS'))) {
  fail('WHATSAPP_RESTORE_SESSIONS must be explicitly true or false');
}
if (!/^(true|false)$/.test(get('DEEP_RESEARCH_RECONCILE_ENABLED'))) {
  fail('DEEP_RESEARCH_RECONCILE_ENABLED must be explicitly true or false');
}
if (!/^(true|false)$/.test(get('EMAIL_SEED_TEST_ENABLED'))) {
  fail('EMAIL_SEED_TEST_ENABLED must be explicitly true or false');
}
if (get('EMAIL_SEED_TEST_ENABLED') === 'true'
  && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(get('EMAIL_SEED_TEST_ADDRESS'))) {
  fail('EMAIL_SEED_TEST_ADDRESS must be an approved email when seed testing is enabled');
}
if (get('EMAIL_SEED_TEST_ENABLED') === 'true') {
  const approvedSeedAddresses = get('EMAIL_SEED_TEST_APPROVED_ADDRESSES')
    .split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (!approvedSeedAddresses.includes(get('EMAIL_SEED_TEST_ADDRESS').trim().toLowerCase())) {
    fail('EMAIL_SEED_TEST_ADDRESS must appear in EMAIL_SEED_TEST_APPROVED_ADDRESSES');
  }
}
if (!/^\d+$/.test(get('EMAIL_SEED_TEST_INTERVAL')) || Number(get('EMAIL_SEED_TEST_INTERVAL')) < 1) {
  fail('EMAIL_SEED_TEST_INTERVAL must be a positive integer');
}

if (!/^(true|false)$/.test(get('EVOLUTION_API_ENABLED'))) {
  fail('EVOLUTION_API_ENABLED must be explicitly true or false');
}
if (get('EVOLUTION_API_ENABLED') === 'true') {
  for (const name of ['EVOLUTION_API_KEY', 'EVOLUTION_WEBHOOK_SECRET']) {
    if (get(name).length < (name === 'EVOLUTION_API_KEY' ? 16 : 32) || placeholders.test(get(name))) {
      fail(`${name} must be a non-placeholder secret when Evolution API is enabled`);
    }
  }
  for (const name of ['EVOLUTION_API_URL', 'BACKEND_URL']) {
    try {
      const url = new URL(get(name));
      const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
        || url.search || url.hash || host === 'localhost' || host === '0.0.0.0'
        || host === '::' || host === '::1' || host.startsWith('127.')) {
        throw new Error('unsafe URL');
      }
      if (name === 'BACKEND_URL' && url.pathname !== '/') throw new Error('path not allowed');
    } catch {
      fail(`${name} must be an explicit non-loopback http(s) URL when Evolution API is enabled`);
    }
  }
}

for (const name of [
  'NODE_IMAGE', 'PYTHON_IMAGE', 'POSTGRES_IMAGE', 'REDIS_IMAGE', 'NGINX_IMAGE',
  'REACHER_IMAGE', 'SEARXNG_IMAGE', 'N8N_IMAGE', 'OPENCLAW_IMAGE',
]) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._\/:@-]*@sha256:[a-f0-9]{64}$/.test(get(name))) {
    fail(`${name} must be pinned as repository@sha256:<64 lowercase hex>`);
  }
}

const reviewedOpenClawImage = 'ghcr.io/openclaw/openclaw@sha256:6a31d44b2944e7adcd2b582bf6fb463111264ebca97a0201795b799135bd102c';
if (get('OPENCLAW_IMAGE') !== reviewedOpenClawImage) {
  fail('OPENCLAW_IMAGE must exactly match the reviewed OpenClaw 2026.7.1 multi-architecture digest');
}
for (const name of env.keys()) {
  if (/^NEXT_PUBLIC_.*OPENCLAW/i.test(name)) {
    fail(`${name} is forbidden because OpenClaw credentials must remain backend-only`);
  }
}

if (process.exitCode) process.exit(process.exitCode);
console.log('[ENV OK] production secrets, LAN endpoints, data path, and image digests passed');
