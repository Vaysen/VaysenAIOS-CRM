import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';

type WindowEntry = { count: number; resetAt: number };
const windows = new Map<string, WindowEntry>();
const MAX_WINDOWS = 10_000;
let requestsSincePrune = 0;

export function assertFixedWindowRateLimit(
  scope: string,
  requestKey: string,
  limit: number,
  windowMs: number,
) {
  const now = Date.now();
  requestsSincePrune += 1;
  if (requestsSincePrune >= 128 || windows.size >= MAX_WINDOWS) {
    for (const [windowKey, entry] of windows) {
      if (entry.resetAt <= now) windows.delete(windowKey);
    }
    while (windows.size >= MAX_WINDOWS) {
      const oldestKey = windows.keys().next().value as string | undefined;
      if (!oldestKey) break;
      windows.delete(oldestKey);
    }
    requestsSincePrune = 0;
  }
  const key = `${scope}:${requestKey}`;
  const current = windows.get(key);
  if (!current || current.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return;
  }
  current.count += 1;
  if (current.count > limit) {
    throw new HttpException(
      'Too many requests; try again later',
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

export function getRequestIp(request: any): string {
  if (process.env.TRUST_PROXY === 'true') {
    const forwarded = String(request?.headers?.['x-forwarded-for'] || '')
      .split(',')[0]
      .trim();
    if (forwarded) return forwarded.slice(0, 128);
  }
  return String(
    request?.ip
    || request?.socket?.remoteAddress
    || 'unknown',
  ).slice(0, 128);
}

export function getCookie(request: any, name: string): string | undefined {
  const cookieHeader = String(request?.headers?.cookie || '');
  for (const part of cookieHeader.split(';')) {
    const [rawName, ...rawValue] = part.trim().split('=');
    if (rawName === name) {
      try {
        return decodeURIComponent(rawValue.join('='));
      } catch {
        throw new BadRequestException('Malformed authentication cookie');
      }
    }
  }
  return undefined;
}

export function assertTrustedCookieOrigin(request: any) {
  const origin = String(request?.headers?.origin || '').trim();
  if (!origin) {
    throw new ForbiddenException('Origin is required for cookie authentication');
  }
  const configured = [
    process.env.FRONTEND_URL,
    process.env.CORS_ORIGIN,
    process.env.CORS_ORIGINS,
  ]
    .flatMap((value) => String(value || '').split(','))
    .map((value) => value.trim())
    .filter(Boolean);

  const isProduction = process.env.NODE_ENV === 'production'
    && process.env.APP_MODE !== 'preview'
    && process.env.APP_MODE !== 'development';
  if (!isProduction) {
    configured.push(
      'http://localhost:4001',
      'http://localhost:4002',
      'http://127.0.0.1:4001',
      'http://127.0.0.1:4002',
    );
  }

  let normalizedOrigin: string;
  try {
    normalizedOrigin = new URL(origin).origin;
  } catch {
    throw new ForbiddenException('Untrusted request origin');
  }
  const trusted = new Set(configured.map((value) => {
    try {
      return new URL(value).origin;
    } catch {
      return '';
    }
  }).filter(Boolean));
  if (!trusted.has(normalizedOrigin)) {
    throw new ForbiddenException('Untrusted request origin');
  }
}

export function envLimit(
  name: string,
  fallback: number,
  min: number,
  max: number,
) {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
}

export function resetRateLimitsForTests() {
  windows.clear();
  requestsSincePrune = 0;
}
