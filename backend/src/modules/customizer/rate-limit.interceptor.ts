import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { isIP } from 'net';

/* ========================================
   Rate Limit Interceptor (TASK-046)
   Simple in-memory rate limiter for public endpoints.
   Prevents abuse of inquiry submission.
   ======================================== */

export const RATE_LIMIT_KEY = 'rateLimit';
export const RATE_LIMIT_DEFAULT = { limit: 5, windowMs: 60_000 }; // 5 requests per minute

export interface RateLimitConfig {
  limit: number;
  windowMs: number;
}

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

// In-memory store: Map<ip, RateLimitEntry>
const rateLimitStore = new Map<string, RateLimitEntry>();

function firstHeaderValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] || '' : value || '';
}

export function extractRateLimitClientIp(request: any): string {
  // Nginx overwrites X-Real-IP with $remote_addr. Prefer it over the
  // client-controlled left side of X-Forwarded-For.
  const realIp = firstHeaderValue(request.headers?.['x-real-ip']).trim();
  if (isIP(realIp)) return realIp;

  // Compatibility for a proxy that appends its observed client address:
  // the right-most valid entry cannot be changed by a forged prefix.
  const forwarded = firstHeaderValue(request.headers?.['x-forwarded-for'])
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  const rightMost = forwarded.at(-1) || '';
  if (isIP(rightMost)) return rightMost;

  return request.socket?.remoteAddress || request.connection?.remoteAddress || 'unknown';
}

// Cleanup expired entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore.entries()) {
    if (now > entry.resetTime) {
      rateLimitStore.delete(key);
    }
  }
}, 60_000).unref();

@Injectable()
export class RateLimitInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const config =
      this.reflector.get<RateLimitConfig>(RATE_LIMIT_KEY, context.getHandler()) ||
      RATE_LIMIT_DEFAULT;

    const request = context.switchToHttp().getRequest();
    const ip = extractRateLimitClientIp(request);

    const key = `${ip}:${request.route?.path || request.url}`;
    const now = Date.now();

    let entry = rateLimitStore.get(key);

    if (!entry || now > entry.resetTime) {
      entry = {
        count: 1,
        resetTime: now + config.windowMs,
      };
      rateLimitStore.set(key, entry);
    } else {
      entry.count++;

      if (entry.count > config.limit) {
        const retryAfter = Math.ceil((entry.resetTime - now) / 1000);
        // Set rate limit headers on response before throwing
        const res = context.switchToHttp().getResponse();
        res.setHeader('Retry-After', String(retryAfter));
        res.setHeader('X-RateLimit-Limit', String(config.limit));
        res.setHeader('X-RateLimit-Remaining', '0');
        res.setHeader('X-RateLimit-Reset', String(Math.ceil(entry.resetTime / 1000)));
        throw new HttpException(
          {
            statusCode: HttpStatus.TOO_MANY_REQUESTS,
            message: 'Too many requests, please try again later',
            error: 'Too Many Requests',
            retryAfter,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }

    // Add rate limit headers to response
    const response = context.switchToHttp().getResponse();
    response.setHeader('X-RateLimit-Limit', String(config.limit));
    response.setHeader('X-RateLimit-Remaining', String(Math.max(0, config.limit - entry.count)));
    response.setHeader('X-RateLimit-Reset', String(Math.ceil(entry.resetTime / 1000)));

    return next.handle().pipe(
      tap(() => {
        // Request completed successfully
      }),
    );
  }
}

/* ========================================
   RateLimit decorator
   Usage: @RateLimit(5, 60000) — 5 requests per 60 seconds
   ======================================== */

import { SetMetadata } from '@nestjs/common';

export const RateLimit = (limit: number = 5, windowMs: number = 60_000) =>
  SetMetadata(RATE_LIMIT_KEY, { limit, windowMs });
