CREATE TYPE "AssistantToolExecutionState" AS ENUM ('REQUESTED', 'PLANNING', 'AWAITING_CONFIRMATION', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

CREATE TABLE "AssistantToolExecution" (
    "id" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "operatorUserId" TEXT NOT NULL,
    "toolName" TEXT NOT NULL,
    "state" "AssistantToolExecutionState" NOT NULL DEFAULT 'REQUESTED',
    "inputDigest" TEXT NOT NULL,
    "parameterSummary" JSONB NOT NULL,
    "result" JSONB,
    "resultRef" JSONB,
    "errorCode" TEXT,
    "confirmationRequired" BOOLEAN NOT NULL DEFAULT false,
    "confirmedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AssistantToolExecution_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AssistantToolExecution_requestKey_key" ON "AssistantToolExecution"("requestKey");
CREATE UNIQUE INDEX "AssistantToolExecution_idempotencyKey_key" ON "AssistantToolExecution"("idempotencyKey");
CREATE INDEX "AssistantToolExecution_companyId_operatorUserId_createdAt_idx" ON "AssistantToolExecution"("companyId", "operatorUserId", "createdAt");
CREATE INDEX "AssistantToolExecution_companyId_state_createdAt_idx" ON "AssistantToolExecution"("companyId", "state", "createdAt");
CREATE INDEX "AssistantToolExecution_companyId_toolName_createdAt_idx" ON "AssistantToolExecution"("companyId", "toolName", "createdAt");

ALTER TABLE "AssistantToolExecution" ADD CONSTRAINT "AssistantToolExecution_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AssistantToolExecution" ADD CONSTRAINT "AssistantToolExecution_operatorUserId_fkey" FOREIGN KEY ("operatorUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
