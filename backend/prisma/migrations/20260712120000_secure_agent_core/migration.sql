CREATE TYPE "AgentRunKind" AS ENUM ('READ_LEAD_SUMMARY', 'DRAFT_FOLLOW_UP');
CREATE TYPE "AgentRunStatus" AS ENUM ('PENDING', 'RUNNING', 'AWAITING_APPROVAL', 'COMPLETED', 'FAILED', 'CANCELLED');
CREATE TYPE "AgentTaskStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');
CREATE TYPE "AgentAuthorizationStatus" AS ENUM ('PENDING', 'CONFIRMED', 'CONSUMED', 'EXPIRED', 'REJECTED');

CREATE TABLE "AgentRun" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "operatorUserId" TEXT NOT NULL,
  "kind" "AgentRunKind" NOT NULL,
  "status" "AgentRunStatus" NOT NULL DEFAULT 'PENDING',
  "inputDigest" TEXT NOT NULL,
  "subjectType" TEXT,
  "subjectId" TEXT,
  "result" JSONB,
  "errorCode" TEXT,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AgentTask" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "toolName" TEXT NOT NULL,
  "status" "AgentTaskStatus" NOT NULL DEFAULT 'PENDING',
  "inputDigest" TEXT NOT NULL,
  "result" JSONB,
  "errorCode" TEXT,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AgentTask_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AgentAuthorization" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "actionType" TEXT NOT NULL,
  "authorizationHash" TEXT NOT NULL,
  "status" "AgentAuthorizationStatus" NOT NULL DEFAULT 'PENDING',
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "confirmedByUserId" TEXT,
  "confirmedAt" TIMESTAMP(3),
  "consumedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AgentAuthorization_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AgentAuditLog" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "runId" TEXT NOT NULL,
  "actorUserId" TEXT,
  "eventType" TEXT NOT NULL,
  "inputDigest" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgentAuditLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AgentRun_companyId_operatorUserId_createdAt_idx" ON "AgentRun"("companyId", "operatorUserId", "createdAt");
CREATE INDEX "AgentRun_companyId_status_createdAt_idx" ON "AgentRun"("companyId", "status", "createdAt");
CREATE INDEX "AgentTask_companyId_runId_createdAt_idx" ON "AgentTask"("companyId", "runId", "createdAt");
CREATE INDEX "AgentTask_companyId_status_createdAt_idx" ON "AgentTask"("companyId", "status", "createdAt");
CREATE INDEX "AgentAuthorization_companyId_runId_status_idx" ON "AgentAuthorization"("companyId", "runId", "status");
CREATE INDEX "AgentAuthorization_status_expiresAt_idx" ON "AgentAuthorization"("status", "expiresAt");
CREATE INDEX "AgentAuditLog_companyId_runId_createdAt_idx" ON "AgentAuditLog"("companyId", "runId", "createdAt");
CREATE INDEX "AgentAuditLog_companyId_eventType_createdAt_idx" ON "AgentAuditLog"("companyId", "eventType", "createdAt");

ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_operatorUserId_fkey" FOREIGN KEY ("operatorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AgentTask" ADD CONSTRAINT "AgentTask_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentTask" ADD CONSTRAINT "AgentTask_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentAuthorization" ADD CONSTRAINT "AgentAuthorization_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentAuthorization" ADD CONSTRAINT "AgentAuthorization_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentAuthorization" ADD CONSTRAINT "AgentAuthorization_confirmedByUserId_fkey" FOREIGN KEY ("confirmedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AgentAuditLog" ADD CONSTRAINT "AgentAuditLog_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentAuditLog" ADD CONSTRAINT "AgentAuditLog_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentAuditLog" ADD CONSTRAINT "AgentAuditLog_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
