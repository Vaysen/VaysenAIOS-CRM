import { QueueOptions } from 'bullmq';

/**
 * Shared BullMQ root configuration used by every module's BullModule.forRoot().
 *
 * Isolation between the two product instances (Jingya / SurfacePolish) relies on
 * two independent dimensions:
 *   1. REDIS_DB  — Jingya uses DB 0 (default), SurfacePolish uses DB 1.
 *   2. prefix    — optional hard namespace on top of the DB. Defaults to the
 *                  BullMQ default ('bull') so that NOT setting BULLMQ_PREFIX
 *                  keeps existing queues/keys exactly as-is (zero migration).
 *
 * To enable prefix-based hard isolation, set BULLMQ_PREFIX (e.g. 'jingya' or
 * 'surfacepolish') in the instance's .env AND restart its workers only after
 * the existing 'bull:'-prefixed queues have drained — otherwise in-flight jobs
 * under the old prefix become orphaned.
 */
export function buildBullRootConfig(): QueueOptions {
  return {
    connection: {
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      db: parseInt(process.env.REDIS_DB || '0', 10),
    },
    prefix: process.env.BULLMQ_PREFIX || 'bull',
  };
}
