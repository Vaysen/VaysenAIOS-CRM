const EMAIL_ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type EmailSeedPolicy = {
  enabled: boolean;
  address: string | null;
  interval: number;
  reason?: string;
};

/**
 * Seed delivery is opt-in and requires two independent declarations:
 * the feature flag and an exact address entry in the approval allowlist.
 * This prevents a stale/default mailbox from silently receiving every batch.
 */
export function resolveEmailSeedPolicy(
  env: Record<string, string | undefined> = process.env,
): EmailSeedPolicy {
  const rawInterval = Number(env.EMAIL_SEED_TEST_INTERVAL || 100);
  const interval = Number.isFinite(rawInterval) && rawInterval >= 1
    ? Math.floor(rawInterval)
    : 100;
  const explicitlyEnabled = env.EMAIL_SEED_TEST_ENABLED?.trim().toLowerCase() === 'true';
  const address = env.EMAIL_SEED_TEST_ADDRESS?.trim().toLowerCase() || '';
  const approved = new Set(
    (env.EMAIL_SEED_TEST_APPROVED_ADDRESSES || '')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean),
  );

  if (!explicitlyEnabled) {
    return { enabled: false, address: null, interval, reason: 'EMAIL_SEED_TEST_ENABLED is not explicitly true' };
  }
  if (!EMAIL_ADDRESS.test(address)) {
    return { enabled: false, address: null, interval, reason: 'EMAIL_SEED_TEST_ADDRESS is missing or invalid' };
  }
  if (!approved.has(address)) {
    return { enabled: false, address: null, interval, reason: 'Seed address is not present in EMAIL_SEED_TEST_APPROVED_ADDRESSES' };
  }

  return { enabled: true, address, interval };
}
