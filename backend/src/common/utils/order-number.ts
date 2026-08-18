import { randomBytes } from 'crypto';

const ORDER_NUMBER_RETRY_LIMIT = 3;

export function generateOrderNumber(now = new Date()): string {
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  const suffix = randomBytes(16).toString('hex').toUpperCase();
  return `ORD-${date}-${suffix}`;
}

export function isOrderNumberUniqueConflict(error: unknown): boolean {
  const candidate = error as {
    code?: string;
    meta?: { target?: string | string[] };
  };
  if (candidate?.code !== 'P2002') return false;
  const target = candidate.meta?.target;
  return Array.isArray(target)
    ? target.includes('orderNo')
    : typeof target === 'string' && target.includes('orderNo');
}

export { ORDER_NUMBER_RETRY_LIMIT };
