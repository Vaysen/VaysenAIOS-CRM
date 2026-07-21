BEGIN;

ALTER TABLE "OpenClawSelectionToken"
  ADD COLUMN "leadId" TEXT;

UPDATE "OpenClawSelectionToken" AS token
SET "leadId" = conversation."leadId"
FROM "Conversation" AS conversation
WHERE conversation."id" = token."conversationId"
  AND conversation."companyId" = token."companyId";

-- Selection capabilities expire after two minutes. Any historical row that
-- cannot be tied back to a tenant-owned lead is safer to revoke than guess.
DELETE FROM "OpenClawSelectionToken"
WHERE "leadId" IS NULL;

ALTER TABLE "OpenClawSelectionToken"
  ALTER COLUMN "leadId" SET NOT NULL,
  ALTER COLUMN "conversationId" DROP NOT NULL;

CREATE INDEX "OpenClawSelectionToken_companyId_leadId_expiresAt_idx"
ON "OpenClawSelectionToken"("companyId", "leadId", "expiresAt");

COMMIT;
