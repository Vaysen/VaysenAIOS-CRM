import { resolveEmailSeedPolicy } from './email-seed-policy';

describe('email seed delivery policy', () => {
  it('is disabled by default and contains no fallback recipient', () => {
    expect(resolveEmailSeedPolicy({})).toMatchObject({ enabled: false, address: null, interval: 100 });
  });

  it('does not enable from an address alone', () => {
    expect(resolveEmailSeedPolicy({ EMAIL_SEED_TEST_ADDRESS: 'owner@example.com' }).enabled).toBe(false);
  });

  it('rejects an enabled but unapproved or invalid address', () => {
    expect(resolveEmailSeedPolicy({
      EMAIL_SEED_TEST_ENABLED: 'true',
      EMAIL_SEED_TEST_ADDRESS: 'owner@example.com',
    }).enabled).toBe(false);
    expect(resolveEmailSeedPolicy({
      EMAIL_SEED_TEST_ENABLED: 'true',
      EMAIL_SEED_TEST_ADDRESS: 'not-an-email',
      EMAIL_SEED_TEST_APPROVED_ADDRESSES: 'not-an-email',
    }).enabled).toBe(false);
  });

  it('enables only an exact valid allowlisted address', () => {
    expect(resolveEmailSeedPolicy({
      EMAIL_SEED_TEST_ENABLED: 'true',
      EMAIL_SEED_TEST_ADDRESS: 'Owner@Example.com',
      EMAIL_SEED_TEST_APPROVED_ADDRESSES: 'audit@example.com, owner@example.com',
      EMAIL_SEED_TEST_INTERVAL: '25',
    })).toEqual({ enabled: true, address: 'owner@example.com', interval: 25 });
  });
});
