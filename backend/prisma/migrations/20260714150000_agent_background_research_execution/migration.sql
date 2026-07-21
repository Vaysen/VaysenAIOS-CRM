-- PostgreSQL does not allow a newly-added enum value to be used until the
-- transaction that added it commits. Keep that DDL in its own transaction so
-- later application writes can safely use BACKGROUND_RESEARCH.
BEGIN;

ALTER TYPE "AgentRunKind" ADD VALUE IF NOT EXISTS 'BACKGROUND_RESEARCH';

COMMIT;

BEGIN;

ALTER TABLE "AgentRun"
ADD COLUMN "requestKey" TEXT,
ADD COLUMN "executionClaimId" TEXT,
ADD COLUMN "executionLeaseExpiresAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "AgentRun_requestKey_key"
ON "AgentRun"("requestKey");

ALTER TABLE "AiArtifact"
ADD COLUMN "requestKey" TEXT;

CREATE UNIQUE INDEX "AiArtifact_requestKey_key"
ON "AiArtifact"("requestKey");

-- Existing rows remain NULL so historical duplicate external IDs do not make
-- the migration destructive. New WhatsApp webhook writes use a digest scoped
-- to company + WhatsApp session + provider message id.
ALTER TABLE "CommunicationMessage"
ADD COLUMN "ingestionKey" TEXT;

CREATE UNIQUE INDEX "CommunicationMessage_ingestionKey_key"
ON "CommunicationMessage"("ingestionKey");

ALTER TABLE "Conversation"
ADD COLUMN "isGroup" BOOLEAN,
ADD COLUMN "groupStatusSource" TEXT;

UPDATE "Conversation"
SET "isGroup" = true,
    "groupStatusSource" = 'historical_external_thread_id'
WHERE "channel" = 'whatsapp' AND "externalThreadId" LIKE '%@g.us';

ALTER TABLE "DeepResearchReport"
ADD COLUMN "agentRunId" TEXT;

CREATE UNIQUE INDEX "DeepResearchReport_agentRunId_key"
ON "DeepResearchReport"("agentRunId");

ALTER TABLE "DeepResearchReport"
ADD CONSTRAINT "DeepResearchReport_agentRunId_fkey"
FOREIGN KEY ("agentRunId") REFERENCES "AgentRun"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
