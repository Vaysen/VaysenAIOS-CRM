import { BadRequestException } from '@nestjs/common';

const CANONICAL_IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{7,199}$/;

export function normalizeIdempotencyKey(value: unknown): string {
  const key = typeof value === 'string' ? value.trim() : '';
  if (!CANONICAL_IDEMPOTENCY_KEY.test(key)) {
    throw new BadRequestException('A canonical Idempotency-Key is required');
  }
  return key;
}
