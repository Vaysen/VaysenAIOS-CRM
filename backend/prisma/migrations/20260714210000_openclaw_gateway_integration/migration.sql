-- PostgreSQL does not allow a newly-added enum value to be used until the
-- transaction that added it commits. Keep the enum change isolated and make
-- it safe to replay after an interrupted deployment.
BEGIN;

ALTER TYPE "AgentRunKind" ADD VALUE IF NOT EXISTS 'OPENCLAW_TOOL';

COMMIT;

-- Keep every remaining schema mutation atomic. If any table, index, or
-- foreign-key statement fails, PostgreSQL rolls the whole section back; a
-- deployment can then restore/resolve the failed Prisma migration and retry
-- without inheriting a half-created OpenClaw schema.
BEGIN;

-- Assistant history must be filtered by operator and thread in PostgreSQL,
-- instead of reading company-wide rows and filtering them in application memory.
ALTER TABLE "AiArtifact"
  ADD COLUMN "assistantOperatorUserId" TEXT,
  ADD COLUMN "assistantThreadId" TEXT,
  ADD COLUMN "actionClaimDigest" TEXT,
  ADD COLUMN "actionClaimedBy" TEXT,
  ADD COLUMN "actionClaimExpiresAt" TIMESTAMP(3);

UPDATE "AiArtifact"
SET
  "assistantOperatorUserId" = NULLIF("extraData"->>'operatorUserId', ''),
  "assistantThreadId" = NULLIF("extraData"->>'threadId', '')
WHERE "artifactType" = 'assistant_chat';

CREATE INDEX "AiArtifact_companyId_artifactType_assistantOperatorUserId_a_idx"
ON "AiArtifact"("companyId", "artifactType", "assistantOperatorUserId", "assistantThreadId", "createdAt" DESC);
CREATE INDEX "AiArtifact_status_actionClaimExpiresAt_idx"
ON "AiArtifact"("status", "actionClaimExpiresAt");

CREATE TYPE "AgentRunSource" AS ENUM ('CRM', 'WECHAT_OWNER');
CREATE TYPE "OpenClawBindingStatus" AS ENUM ('ACTIVE', 'REVOKED');
CREATE TYPE "OpenClawReceiptStatus" AS ENUM ('PROCESSING', 'COMPLETED', 'FAILED');
CREATE TYPE "OpenClawBusinessStatus" AS ENUM ('PROCESSING', 'SUCCEEDED', 'BLOCKED', 'FAILED');
CREATE TYPE "OpenClawCrmExecutionStatus" AS ENUM ('READY', 'RUNNING', 'DRAINING', 'SETTLED');

ALTER TABLE "AgentRun" ADD COLUMN "source" "AgentRunSource";

CREATE TABLE "OpenClawOperatorBinding" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "operatorUserId" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "senderDigest" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "status" "OpenClawBindingStatus" NOT NULL DEFAULT 'ACTIVE',
  "boundAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OpenClawOperatorBinding_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OpenClawRequestNonce" (
  "id" TEXT NOT NULL,
  "nonceDigest" TEXT NOT NULL,
  "keyId" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OpenClawRequestNonce_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OpenClawCrmSession" (
  "id" TEXT NOT NULL,
  "sessionDigest" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "operatorUserId" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "executionStatus" "OpenClawCrmExecutionStatus" NOT NULL DEFAULT 'READY',
  "executionLeaseToken" TEXT,
  "executionLeaseExpiresAt" TIMESTAMP(3),
  "executionCompletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OpenClawCrmSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OpenClawToolReceipt" (
  "id" TEXT NOT NULL,
  "requestKey" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "operatorUserId" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "toolName" TEXT NOT NULL,
  "inputDigest" TEXT NOT NULL,
  "senderDigest" TEXT NOT NULL,
  "sessionDigest" TEXT NOT NULL,
  "messageDigest" TEXT NOT NULL,
  "businessInputDigest" TEXT,
  "acceptanceMarkerDigest" TEXT,
  "status" "OpenClawReceiptStatus" NOT NULL DEFAULT 'PROCESSING',
  "businessStatus" "OpenClawBusinessStatus" NOT NULL DEFAULT 'PROCESSING',
  "result" JSONB,
  "errorCode" TEXT,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OpenClawToolReceipt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OpenClawSelectionToken" (
  "id" TEXT NOT NULL,
  "tokenDigest" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "operatorUserId" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "senderDigest" TEXT NOT NULL,
  "accountDigest" TEXT NOT NULL,
  "sessionDigest" TEXT NOT NULL,
  "messageDigest" TEXT NOT NULL,
  "searchRequestKey" TEXT NOT NULL,
  "targetTool" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "OpenClawSelectionToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OpenClawOperatorBinding_channel_senderDigest_key"
ON "OpenClawOperatorBinding"("channel", "senderDigest");
CREATE INDEX "OpenClawOperatorBinding_companyId_operatorUserId_status_idx"
ON "OpenClawOperatorBinding"("companyId", "operatorUserId", "status");

CREATE UNIQUE INDEX "OpenClawRequestNonce_nonceDigest_key"
ON "OpenClawRequestNonce"("nonceDigest");
CREATE INDEX "OpenClawRequestNonce_expiresAt_idx"
ON "OpenClawRequestNonce"("expiresAt");

CREATE UNIQUE INDEX "OpenClawCrmSession_sessionDigest_key"
ON "OpenClawCrmSession"("sessionDigest");
CREATE INDEX "OpenClawCrmSession_companyId_operatorUserId_expiresAt_idx"
ON "OpenClawCrmSession"("companyId", "operatorUserId", "expiresAt");
CREATE INDEX "OpenClawCrmSession_executionStatus_executionLeaseExpiresAt_idx"
ON "OpenClawCrmSession"("executionStatus", "executionLeaseExpiresAt");

CREATE UNIQUE INDEX "OpenClawToolReceipt_requestKey_key"
ON "OpenClawToolReceipt"("requestKey");
CREATE UNIQUE INDEX "OpenClawToolReceipt_runId_key"
ON "OpenClawToolReceipt"("runId");
CREATE INDEX "OpenClawToolReceipt_companyId_operatorUserId_createdAt_idx"
ON "OpenClawToolReceipt"("companyId", "operatorUserId", "createdAt" DESC);
CREATE INDEX "OpenClawToolReceipt_companyId_operatorUserId_sessionDigest__idx"
ON "OpenClawToolReceipt"("companyId", "operatorUserId", "sessionDigest", "createdAt" DESC);
CREATE INDEX "OpenClawToolReceipt_companyId_operatorUserId_businessInputD_idx"
ON "OpenClawToolReceipt"("companyId", "operatorUserId", "businessInputDigest", "createdAt" DESC);
CREATE INDEX "OpenClawToolReceipt_acceptanceMarkerDigest_createdAt_idx"
ON "OpenClawToolReceipt"("acceptanceMarkerDigest", "createdAt" DESC);
CREATE INDEX "OpenClawToolReceipt_companyId_toolName_status_idx"
ON "OpenClawToolReceipt"("companyId", "toolName", "status");

CREATE UNIQUE INDEX "OpenClawSelectionToken_tokenDigest_key"
ON "OpenClawSelectionToken"("tokenDigest");
CREATE INDEX "OpenClawSelectionToken_companyId_operatorUserId_sessionDige_idx"
ON "OpenClawSelectionToken"("companyId", "operatorUserId", "sessionDigest", "expiresAt");
CREATE INDEX "OpenClawSelectionToken_searchRequestKey_targetTool_idx"
ON "OpenClawSelectionToken"("searchRequestKey", "targetTool");
CREATE INDEX "OpenClawSelectionToken_expiresAt_consumedAt_idx"
ON "OpenClawSelectionToken"("expiresAt", "consumedAt");

ALTER TABLE "OpenClawOperatorBinding"
  ADD CONSTRAINT "OpenClawOperatorBinding_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "OpenClawOperatorBinding_operatorUserId_fkey"
  FOREIGN KEY ("operatorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "OpenClawToolReceipt"
  ADD CONSTRAINT "OpenClawToolReceipt_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "OpenClawToolReceipt_operatorUserId_fkey"
  FOREIGN KEY ("operatorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "OpenClawToolReceipt_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OpenClawCrmSession"
  ADD CONSTRAINT "OpenClawCrmSession_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "OpenClawCrmSession_operatorUserId_fkey"
  FOREIGN KEY ("operatorUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OpenClawSelectionToken"
  ADD CONSTRAINT "OpenClawSelectionToken_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "OpenClawSelectionToken_operatorUserId_fkey"
  FOREIGN KEY ("operatorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
