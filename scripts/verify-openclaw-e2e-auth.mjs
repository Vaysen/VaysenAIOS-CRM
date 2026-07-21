import { readFileSync, lstatSync } from 'node:fs';

const baseUrl = new URL(process.env.OPENCLAW_E2E_BASE_URL || '');
const tokenFile = process.env.OPENCLAW_E2E_BEARER_TOKEN_FILE || '';
const companyId = process.env.OPENCLAW_E2E_COMPANY_ID || '';
const ownerEmail = process.env.OPENCLAW_E2E_OWNER_EMAIL || '';

if (!['http:', 'https:'].includes(baseUrl.protocol) || baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash) {
  throw new Error('OpenClaw E2E auth base URL is invalid');
}
const privateHttp = baseUrl.protocol === 'http:' && (
  ['localhost', '127.0.0.1', '::1'].includes(baseUrl.hostname)
  || /^10\./.test(baseUrl.hostname)
  || /^192\.168\./.test(baseUrl.hostname)
  || /^172\.(1[6-9]|2\d|3[01])\./.test(baseUrl.hostname)
);
if (baseUrl.protocol !== 'https:' && !privateHttp) throw new Error('plain HTTP is allowed only on loopback/private LAN');
if (!/^[0-9a-f-]{36}$/i.test(companyId) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)) {
  throw new Error('OpenClaw E2E auth identity contract is invalid');
}
const tokenStat = lstatSync(tokenFile);
if (!tokenStat.isFile() || tokenStat.isSymbolicLink() || (tokenStat.mode & 0o077) !== 0) {
  throw new Error('OpenClaw E2E bearer token file must be a private regular file');
}
const token = readFileSync(tokenFile, 'utf8');
if (/\r|\n/.test(token) || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
  throw new Error('OpenClaw E2E bearer token has an invalid shape');
}

const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 15_000);
let response;
try {
  response = await fetch(new URL('/api/auth/me', baseUrl), {
    headers: { accept: 'application/json', authorization: `Bearer ${token}` },
    signal: controller.signal,
  });
} finally {
  clearTimeout(timer);
}
const text = await response.text();
let profile;
try { profile = text ? JSON.parse(text) : null; } catch { profile = null; }
if (!response.ok || !profile || typeof profile.id !== 'string') {
  throw new Error(`OpenClaw E2E administrator authentication failed with HTTP ${response.status}`);
}
if (String(profile.email || '').toLowerCase() !== ownerEmail.toLowerCase()) {
  throw new Error('authenticated E2E profile does not match the configured owner email');
}
const relation = Array.isArray(profile.companies)
  ? profile.companies.filter((item) => item?.id === companyId && item?.role === 'company_admin')
  : [];
if (relation.length !== 1) {
  throw new Error('authenticated E2E profile lacks the exact company_admin relation');
}
process.stdout.write('[OPENCLAW E2E AUTH OK] real JWT guard accepted the short-lived company administrator\n');
