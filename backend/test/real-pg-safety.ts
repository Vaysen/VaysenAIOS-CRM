import { URL } from 'node:url';

export const REAL_PG_ENABLE_ENV = 'LAN_COMMUNICATIONS_REAL_PG';
export const DEFAULT_REAL_PG_PORT = '55433';

const DISPOSABLE_DATABASE_PATTERN = /(?:^|_)(?:test|testing|ci|tmp|temp|sandbox|disposable|fix)(?:_|$)/i;
const DESIGNATED_REAL_PG_USER = 'lan_tools';
const FORBIDDEN_DATABASE_NAMES = new Set([
  'postgres',
  'production',
  'prod',
  'main',
  'live',
  'vaysen-crm',
  'vaysen-crm_prod',
  'vaysen-crm_production',
  'vaysen',
  'vaysen_prod',
  'vaysen_production',
]);

export type RealPgExpectedIdentity = {
  database: string;
  user: string;
  serverHost: string;
  serverPort: string;
};

export type RealPgIdentity = {
  currentDatabase: string | null;
  currentUser: string | null;
  serverAddr: string | null;
  serverPort: number | string | null;
};

export function assertRealPgEnabled(env: NodeJS.ProcessEnv = process.env): void {
  assertRealPgSwitchEnabled(REAL_PG_ENABLE_ENV, env);
}

export function assertRealPgSwitchEnabled(
  enableEnv: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!/^[A-Z][A-Z0-9_]+$/.test(enableEnv) || env[enableEnv] !== '1') {
    throw new Error(`${enableEnv}=1 is required for the destructive real PostgreSQL integration test`);
  }
}

export function parseRealPgDatabaseUrl(
  databaseUrl: string | undefined,
): RealPgExpectedIdentity {
  if (!databaseUrl || /[\u0000-\u001f\u007f]/.test(databaseUrl)) {
    throw new Error('DATABASE_URL is missing or contains control characters');
  }

  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL is not a valid PostgreSQL URL');
  }

  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('DATABASE_URL must use the postgres or postgresql scheme');
  }
  if (parsed.hash || parsed.username.length === 0 || parsed.hostname.length === 0) {
    throw new Error('DATABASE_URL must contain a username and hostname without a fragment');
  }
  const user = decodeCredential(parsed.username, 'username');
  const password = decodeCredential(parsed.password, 'password');
  if (user !== DESIGNATED_REAL_PG_USER) throw new Error('DATABASE_URL user is not the designated disposable PostgreSQL user');
  if (!password && parsed.password.length > 0) throw new Error('DATABASE_URL password is not valid URL encoding');

  const host = normalizeHost(parsed.hostname);
  if (!isLoopbackHost(host)) {
    throw new Error('DATABASE_URL host must be a loopback address');
  }

  const port = parsed.port || '5432';
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error('DATABASE_URL port is invalid');
  }
  if (port !== DEFAULT_REAL_PG_PORT) {
    throw new Error(`DATABASE_URL must use the designated disposable PostgreSQL port ${DEFAULT_REAL_PG_PORT}`);
  }

  const database = decodeDatabaseName(parsed.pathname);
  const normalizedDatabase = database.toLowerCase();
  if (!database || FORBIDDEN_DATABASE_NAMES.has(normalizedDatabase)) {
    throw new Error('DATABASE_URL database name is not disposable');
  }
  if (!DISPOSABLE_DATABASE_PATTERN.test(database)) {
    throw new Error('DATABASE_URL database name must contain a test or disposable marker');
  }

  return {
    database,
    user,
    serverHost: host,
    serverPort: port,
  };
}

export function assertRealPgIdentity(
  expected: RealPgExpectedIdentity,
  actual: RealPgIdentity,
): void {
  const actualPort = String(actual.serverPort ?? '');
  const actualHost = normalizeServerAddress(actual.serverAddr);
  const identityMatches =
    actual.currentDatabase === expected.database &&
    actual.currentUser === expected.user &&
    actualPort === expected.serverPort &&
    isLoopbackHost(actualHost) &&
    isExpectedLoopbackAddress(expected.serverHost, actualHost);

  if (!identityMatches) {
    throw new Error('Connected PostgreSQL identity does not match the guarded disposable target');
  }
}

function decodeDatabaseName(pathname: string): string {
  if (!pathname.startsWith('/') || pathname.length <= 1 || pathname.slice(1).includes('/')) {
    throw new Error('DATABASE_URL must contain exactly one database path segment');
  }
  try {
    const database = decodeURIComponent(pathname.slice(1));
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(database)) throw new Error('DATABASE_URL database name contains unsupported characters');
    return database;
  } catch {
    throw new Error('DATABASE_URL database path is not valid URL encoding');
  }
}

function decodeCredential(value: string, label: string): string {
  try {
    const decoded = decodeURIComponent(value);
    if (/[\u0000-\u001f\u007f]/.test(decoded)) throw new Error('control character');
    return decoded;
  } catch {
    throw new Error(`DATABASE_URL ${label} is not valid URL encoding`);
  }
}

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function normalizeHost(host: string): string {
  return host.toLowerCase().replace(/^\[(.*)\]$/, '$1');
}

function normalizeServerAddress(address: string | null): string {
  if (!address) return '';
  const normalized = normalizeHost(address);
  if (normalized.endsWith('/32')) return normalized.slice(0, -3);
  if (normalized.endsWith('/128')) return normalized.slice(0, -4);
  return normalized;
}

function isExpectedLoopbackAddress(expectedHost: string, actualHost: string): boolean {
  if (expectedHost === 'localhost') return isLoopbackHost(actualHost);
  return expectedHost === actualHost;
}
