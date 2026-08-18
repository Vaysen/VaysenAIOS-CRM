-- Bind every durable action to the initiating actor/role and fence provider attempts.
-- Existing rows use fail-closed legacy markers and cannot be replayed until explicitly
-- reconciled or replaced by a new canonical idempotency key.

ALTER TABLE "ExternalActionOutbox"
ADD COLUMN "actorType" TEXT NOT NULL DEFAULT 'LEGACY',
ADD COLUMN "operatorRole" TEXT NOT NULL DEFAULT 'legacy',
ADD COLUMN "leaseToken" TEXT,
ADD COLUMN "attemptVersion" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX "ExternalActionOutbox_status_leaseExpiresAt_leaseToken_attemptVersion_idx"
ON "ExternalActionOutbox"("status", "leaseExpiresAt", "leaseToken", "attemptVersion");

-- New writers always provide actorType/operatorRole; remove migration-only defaults.
ALTER TABLE "ExternalActionOutbox"
ALTER COLUMN "actorType" DROP DEFAULT,
ALTER COLUMN "operatorRole" DROP DEFAULT;

-- Rollback (only after stopping outbound writers and preserving audit rows):
-- DROP INDEX "ExternalActionOutbox_status_leaseExpiresAt_leaseToken_attemptVersion_idx";
-- ALTER TABLE "ExternalActionOutbox"
--   DROP COLUMN "attemptVersion",
--   DROP COLUMN "leaseToken",
--   DROP COLUMN "operatorRole",
--   DROP COLUMN "actorType";
