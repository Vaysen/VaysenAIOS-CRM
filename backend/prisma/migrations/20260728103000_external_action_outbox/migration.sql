-- P0 outbound safety V1.
-- This migration is additive: it does not rewrite or inspect existing
-- customer data. Rollback is the reverse DROP sequence at the bottom.

CREATE TYPE "AssistantGrantConsumptionStatus" AS ENUM ('RESERVED', 'CONSUMED', 'CANCELLED');
CREATE TYPE "ExternalActionStatus" AS ENUM ('PENDING', 'EXECUTING', 'SUCCEEDED', 'FAILED', 'UNKNOWN', 'CANCELLED', 'EXPIRED');
CREATE TYPE "ExternalActionChannel" AS ENUM ('EMAIL', 'WHATSAPP');

CREATE TABLE "AssistantGrantConsumption" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "operatorUserId" TEXT NOT NULL,
    "grantId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "scopeDigest" TEXT NOT NULL,
    "status" "AssistantGrantConsumptionStatus" NOT NULL DEFAULT 'RESERVED',
    "actionId" TEXT,
    "reservedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AssistantGrantConsumption_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ExternalActionOutbox" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "operatorUserId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "channel" "ExternalActionChannel" NOT NULL,
    "actionType" TEXT NOT NULL,
    "status" "ExternalActionStatus" NOT NULL DEFAULT 'PENDING',
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "targetAddressHash" TEXT NOT NULL,
    "targetDomain" TEXT,
    "targetSnapshot" JSONB NOT NULL,
    "payloadDigest" TEXT NOT NULL,
    "contentSnapshot" JSONB NOT NULL,
    "policySnapshot" JSONB NOT NULL,
    "approvalId" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "nextAttemptAt" TIMESTAMP(3),
    "claimedAt" TIMESTAMP(3),
    "leaseExpiresAt" TIMESTAMP(3),
    "provider" TEXT,
    "providerReceiptId" TEXT,
    "providerReceipt" JSONB,
    "lastErrorCode" TEXT,
    "lastError" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ExternalActionOutbox_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ExternalSuppression" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "channel" "ExternalActionChannel" NOT NULL,
    "targetAddressHash" TEXT,
    "leadId" TEXT,
    "reason" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ExternalSuppression_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AssistantGrantConsumption_companyId_operatorUserId_idempotencyKey_key"
ON "AssistantGrantConsumption"("companyId", "operatorUserId", "idempotencyKey");
CREATE INDEX "AssistantGrantConsumption_grantId_status_createdAt_idx"
ON "AssistantGrantConsumption"("grantId", "status", "createdAt");
CREATE INDEX "AssistantGrantConsumption_companyId_capability_scopeDigest_createdAt_idx"
ON "AssistantGrantConsumption"("companyId", "capability", "scopeDigest", "createdAt");

CREATE UNIQUE INDEX "ExternalActionOutbox_companyId_idempotencyKey_key"
ON "ExternalActionOutbox"("companyId", "idempotencyKey");
CREATE UNIQUE INDEX "ExternalActionOutbox_channel_provider_providerReceiptId_key"
ON "ExternalActionOutbox"("channel", "provider", "providerReceiptId");
CREATE INDEX "ExternalActionOutbox_status_nextAttemptAt_leaseExpiresAt_idx"
ON "ExternalActionOutbox"("status", "nextAttemptAt", "leaseExpiresAt");
CREATE INDEX "ExternalActionOutbox_companyId_channel_createdAt_idx"
ON "ExternalActionOutbox"("companyId", "channel", "createdAt");
CREATE INDEX "ExternalActionOutbox_companyId_targetAddressHash_createdAt_idx"
ON "ExternalActionOutbox"("companyId", "targetAddressHash", "createdAt");
CREATE INDEX "ExternalActionOutbox_companyId_targetDomain_createdAt_idx"
ON "ExternalActionOutbox"("companyId", "targetDomain", "createdAt");
CREATE INDEX "ExternalSuppression_companyId_channel_targetAddressHash_isActive_idx"
ON "ExternalSuppression"("companyId", "channel", "targetAddressHash", "isActive");
CREATE INDEX "ExternalSuppression_companyId_channel_leadId_isActive_idx"
ON "ExternalSuppression"("companyId", "channel", "leadId", "isActive");

ALTER TABLE "AssistantGrantConsumption"
ADD CONSTRAINT "AssistantGrantConsumption_companyId_fkey"
FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AssistantGrantConsumption"
ADD CONSTRAINT "AssistantGrantConsumption_operatorUserId_fkey"
FOREIGN KEY ("operatorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AssistantGrantConsumption"
ADD CONSTRAINT "AssistantGrantConsumption_grantId_fkey"
FOREIGN KEY ("grantId") REFERENCES "AssistantTemporaryGrant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ExternalActionOutbox"
ADD CONSTRAINT "ExternalActionOutbox_companyId_fkey"
FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExternalActionOutbox"
ADD CONSTRAINT "ExternalActionOutbox_operatorUserId_fkey"
FOREIGN KEY ("operatorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ExternalSuppression"
ADD CONSTRAINT "ExternalSuppression_companyId_fkey"
FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Rollback (manual, only after confirming no audit records need retention):
-- DROP TABLE "ExternalActionOutbox";
-- DROP TABLE "AssistantGrantConsumption";
-- DROP TABLE "ExternalSuppression";
-- DROP TYPE "ExternalActionChannel";
-- DROP TYPE "ExternalActionStatus";
-- DROP TYPE "AssistantGrantConsumptionStatus";
