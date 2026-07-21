BEGIN;

CREATE TYPE "AssistantPermissionPreset" AS ENUM ('ADVISORY', 'EXECUTOR', 'SUPERVISOR');
CREATE TYPE "AssistantGrantStatus" AS ENUM ('ACTIVE', 'REVOKED', 'EXPIRED', 'CONSUMED');
CREATE TYPE "AssistantPolicyDecision" AS ENUM ('ALLOW', 'APPROVAL_REQUIRED', 'DENY');
CREATE TYPE "AssistantActionState" AS ENUM (
  'PLANNED',
  'POLICY_CHECKED',
  'AWAITING_APPROVAL',
  'CLAIMED',
  'EXECUTING',
  'SUCCEEDED',
  'FAILED',
  'UNKNOWN',
  'CANCELLED'
);

CREATE TABLE "AssistantPermissionProfile" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "preset" "AssistantPermissionPreset" NOT NULL DEFAULT 'ADVISORY',
  "overrides" JSONB NOT NULL,
  "thresholds" JSONB NOT NULL,
  "updatedByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AssistantPermissionProfile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AssistantTemporaryGrant" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "operatorUserId" TEXT NOT NULL,
  "createdByUserId" TEXT NOT NULL,
  "capability" TEXT NOT NULL,
  "scopeDigest" TEXT NOT NULL,
  "scope" JSONB NOT NULL,
  "status" "AssistantGrantStatus" NOT NULL DEFAULT 'ACTIVE',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "maxUses" INTEGER NOT NULL DEFAULT 1,
  "useCount" INTEGER NOT NULL DEFAULT 0,
  "revokedAt" TIMESTAMP(3),
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AssistantTemporaryGrant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AssistantBusinessAction" (
  "id" TEXT NOT NULL,
  "requestKey" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "operatorUserId" TEXT NOT NULL,
  "runId" TEXT,
  "capability" TEXT NOT NULL,
  "state" "AssistantActionState" NOT NULL DEFAULT 'PLANNED',
  "decision" "AssistantPolicyDecision",
  "contextDigest" TEXT NOT NULL,
  "payloadDigest" TEXT NOT NULL,
  "targetType" TEXT,
  "targetId" TEXT,
  "policySnapshot" JSONB,
  "result" JSONB,
  "receipt" JSONB,
  "errorCode" TEXT,
  "approvalId" TEXT,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AssistantBusinessAction_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AssistantPermissionProfile_companyId_key"
  ON "AssistantPermissionProfile"("companyId");
CREATE INDEX "AssistantPermissionProfile_preset_updatedAt_idx"
  ON "AssistantPermissionProfile"("preset", "updatedAt");
CREATE INDEX "AssistantTemporaryGrant_companyId_operatorUserId_capabili_idx"
  ON "AssistantTemporaryGrant"("companyId", "operatorUserId", "capability", "status", "expiresAt");
CREATE INDEX "AssistantTemporaryGrant_scopeDigest_status_expiresAt_idx"
  ON "AssistantTemporaryGrant"("scopeDigest", "status", "expiresAt");
CREATE UNIQUE INDEX "AssistantBusinessAction_requestKey_key"
  ON "AssistantBusinessAction"("requestKey");
CREATE UNIQUE INDEX "AssistantBusinessAction_idempotencyKey_key"
  ON "AssistantBusinessAction"("idempotencyKey");
CREATE INDEX "AssistantBusinessAction_companyId_operatorUserId_state_cre_idx"
  ON "AssistantBusinessAction"("companyId", "operatorUserId", "state", "createdAt");
CREATE INDEX "AssistantBusinessAction_companyId_capability_createdAt_idx"
  ON "AssistantBusinessAction"("companyId", "capability", "createdAt");
CREATE INDEX "AssistantBusinessAction_targetType_targetId_createdAt_idx"
  ON "AssistantBusinessAction"("targetType", "targetId", "createdAt");

ALTER TABLE "AssistantPermissionProfile"
  ADD CONSTRAINT "AssistantPermissionProfile_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "AssistantPermissionProfile_updatedByUserId_fkey"
  FOREIGN KEY ("updatedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AssistantTemporaryGrant"
  ADD CONSTRAINT "AssistantTemporaryGrant_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "AssistantTemporaryGrant_operatorUserId_fkey"
  FOREIGN KEY ("operatorUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "AssistantTemporaryGrant_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AssistantBusinessAction"
  ADD CONSTRAINT "AssistantBusinessAction_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "AssistantBusinessAction_operatorUserId_fkey"
  FOREIGN KEY ("operatorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "AssistantBusinessAction_runId_fkey"
  FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
