import { createHash, timingSafeEqual } from 'crypto';

export interface DisabledEvolutionConfig {
  enabled: false;
}

export interface EnabledEvolutionConfig {
  enabled: true;
  apiUrl: string;
  apiKey: string;
  webhookSecret: string;
  backendUrl: string;
}

export type EvolutionConfig = DisabledEvolutionConfig | EnabledEvolutionConfig;

const PLACEHOLDER = /(change[-_ ]?me|replace[-_ ]?me|example|password|secret123|default)/i;

function requiredSecret(env: NodeJS.ProcessEnv, name: string, minimumLength: number): string {
  const value = String(env[name] || '').trim();
  if (value.length < minimumLength || PLACEHOLDER.test(value)) {
    throw new Error(`${name} must be a non-placeholder secret with at least ${minimumLength} characters`);
  }
  return value;
}

function normalizeServiceUrl(name: string, rawValue: string, requireRootPath = false): string {
  let url: URL;
  try {
    url = new URL(rawValue);
  } catch {
    throw new Error(`${name} must be an explicit http(s) URL`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || url.search || url.hash) {
    throw new Error(`${name} must be a credential-free http(s) origin without query or fragment`);
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost')
    || hostname === '0.0.0.0' || hostname === '::' || hostname === '::1'
    || hostname.startsWith('127.') || hostname.startsWith('::ffff:127.')) {
    throw new Error(`${name} must not use a loopback or wildcard host`);
  }
  if (requireRootPath && url.pathname !== '/') {
    throw new Error(`${name} must be an origin without a path`);
  }
  return url.toString().replace(/\/$/, '');
}

export function loadEvolutionConfig(env: NodeJS.ProcessEnv = process.env): EvolutionConfig {
  if (env.EVOLUTION_API_ENABLED !== 'true') return { enabled: false };

  return {
    enabled: true,
    apiUrl: normalizeServiceUrl('EVOLUTION_API_URL', String(env.EVOLUTION_API_URL || '').trim()),
    apiKey: requiredSecret(env, 'EVOLUTION_API_KEY', 16),
    webhookSecret: requiredSecret(env, 'EVOLUTION_WEBHOOK_SECRET', 32),
    backendUrl: normalizeServiceUrl('BACKEND_URL', String(env.BACKEND_URL || '').trim(), true),
  };
}

export function requireEvolutionConfig(env: NodeJS.ProcessEnv = process.env): EnabledEvolutionConfig {
  const config = loadEvolutionConfig(env);
  if (!config.enabled) throw new Error('Evolution API is disabled');
  return config;
}

export function isValidWebhookSecret(provided: unknown, expected: string): boolean {
  const suppliedDigest = createHash('sha256').update(String(provided || ''), 'utf8').digest();
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(suppliedDigest, expectedDigest) && String(provided || '').length > 0;
}
