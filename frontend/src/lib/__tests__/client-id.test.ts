import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClientUuid } from '../client-id';

describe('createClientUuid', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses native randomUUID when the secure-context API exists', () => {
    const randomUUID = vi.fn(() => '11111111-2222-4333-8444-555555555555');
    vi.stubGlobal('crypto', { randomUUID, getRandomValues: vi.fn() });

    expect(createClientUuid()).toBe('11111111-2222-4333-8444-555555555555');
    expect(randomUUID).toHaveBeenCalledTimes(1);
  });

  it('creates a valid v4 UUID from getRandomValues on an insecure LAN origin', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: (target: Uint8Array) => {
        target.set(Array.from({ length: 16 }, (_, index) => index));
        return target;
      },
    });

    expect(createClientUuid()).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f');
  });

  it('fails closed instead of using a weak idempotency key without a CSPRNG', () => {
    vi.stubGlobal('crypto', {});
    expect(() => createClientUuid()).toThrow('缺少安全随机数能力');
  });
});
