import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api', () => ({
  default: {
    post: vi.fn(),
    get: vi.fn(),
  },
}));

describe('auth store credential migration', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  it('removes a legacy renderer refresh token during module initialization', async () => {
    localStorage.setItem('refresh_token', 'legacy-plaintext-refresh');

    await import('./authStore');

    expect(localStorage.getItem('refresh_token')).toBeNull();
  });
});
