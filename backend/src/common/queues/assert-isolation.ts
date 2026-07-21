/**
 * Runtime isolation guard for the two product instances that share one
 * Postgres database (via schema) and one Redis server (via DB number):
 *
 *   Jingya       -> Postgres schema "public"        + Redis DB 0
 *   SurfacePolish -> Postgres schema "surfacepolish" + Redis DB 1
 *
 * The only thing keeping the two instances from stealing each other's queue
 * jobs is that each worker is started with the right REDIS_DB. There is no
 * code-level guarantee: if a SurfacePolish worker is launched without
 * REDIS_DB=1 it silently falls back to DB 0 and starts consuming Jingya's
 * jobs.
 *
 * This guard makes that misconfiguration fail loudly at startup instead of
 * corrupting the other instance's queue. It derives the expected Redis DB
 * from the Postgres schema in DATABASE_URL and refuses to boot on mismatch.
 */

function schemaFromDatabaseUrl(url: string | undefined): string | null {
  if (!url) return null;
  const match = url.match(/[?&]schema=([^&]+)/);
  return match ? decodeURIComponent(match[1]) : 'public';
}

// Known schema -> Redis DB pairings. Extend here when adding instances.
const SCHEMA_REDIS_DB: Record<string, number> = {
  public: 0,
  surfacepolish: 1,
};

/**
 * Validates that REDIS_DB matches the Postgres schema. Throws (and the caller
 * should let the process exit non-zero) on mismatch.
 *
 * Opt out for ad-hoc/maintenance runs with ISOLATION_GUARD=off.
 */
export function assertRuntimeIsolation(loggerName = 'IsolationGuard'): void {
  if ((process.env.ISOLATION_GUARD || '').toLowerCase() === 'off') return;

  const schema = schemaFromDatabaseUrl(process.env.DATABASE_URL);
  if (!schema) {
    // No DATABASE_URL at all is a separate failure the app will surface; don't
    // block here.
    return;
  }

  const expectedDb = SCHEMA_REDIS_DB[schema];
  if (expectedDb === undefined) {
    // Unknown schema (e.g. a new instance not yet listed). Warn but allow.
    // eslint-disable-next-line no-console
    console.warn(
      `[${loggerName}] Unknown Postgres schema "${schema}" — skipping Redis DB isolation check. ` +
        `Add it to SCHEMA_REDIS_DB to enable the guard.`,
    );
    return;
  }

  const actualDb = parseInt(process.env.REDIS_DB || '0', 10);
  if (actualDb !== expectedDb) {
    const msg =
      `[${loggerName}] ISOLATION MISMATCH: Postgres schema "${schema}" expects ` +
      `REDIS_DB=${expectedDb} but REDIS_DB=${actualDb}. Refusing to start to avoid ` +
      `consuming another instance's queue jobs. Fix REDIS_DB in this worker's env ` +
      `(or set ISOLATION_GUARD=off to override).`;
    throw new Error(msg);
  }

  // eslint-disable-next-line no-console
  console.log(
    `[${loggerName}] isolation OK: schema="${schema}" <-> REDIS_DB=${actualDb}` +
      (process.env.BULLMQ_PREFIX ? ` prefix="${process.env.BULLMQ_PREFIX}"` : ''),
  );
}
