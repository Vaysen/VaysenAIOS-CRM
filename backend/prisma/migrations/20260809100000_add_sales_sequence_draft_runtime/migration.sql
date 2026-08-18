-- CRM-03: tenant-scoped sales-sequence draft runtime.
-- This migration deliberately creates a separate DRAFT_ONLY outbox. It is
-- not consumed by the existing external-send workers.

CREATE TYPE "SalesSequenceStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED');
CREATE TYPE "SalesSequenceEnrollmentStatus" AS ENUM ('ACTIVE', 'PAUSED', 'STOPPED', 'COMPLETED');
CREATE TYPE "SalesSequenceStepExecutionStatus" AS ENUM ('DRAFT_PENDING', 'APPROVED', 'CANCELLED');
CREATE TYPE "SalesSequenceReceiptKind" AS ENUM ('DRAFT_CREATED', 'DRAFT_APPROVED', 'DRAFT_CANCELLED');

CREATE TABLE "SalesSequence" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "ownerUserId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "status" "SalesSequenceStatus" NOT NULL DEFAULT 'DRAFT',
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SalesSequence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SalesSequence_version_check" CHECK ("version" > 0)
);

CREATE TABLE "SalesSequenceStep" (
  "id" TEXT NOT NULL,
  "sequenceId" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  "channel" TEXT NOT NULL,
  "delaySeconds" INTEGER NOT NULL DEFAULT 0,
  "templateDigest" TEXT NOT NULL,
  "templateSnapshot" JSONB NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SalesSequenceStep_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SalesSequenceStep_position_check" CHECK ("position" > 0),
  CONSTRAINT "SalesSequenceStep_delaySeconds_check" CHECK ("delaySeconds" >= 0),
  CONSTRAINT "SalesSequenceStep_version_check" CHECK ("version" > 0)
);

CREATE TABLE "SalesSequenceEnrollment" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "sequenceId" TEXT NOT NULL,
  "leadId" TEXT NOT NULL,
  "createdById" TEXT NOT NULL,
  "status" "SalesSequenceEnrollmentStatus" NOT NULL DEFAULT 'ACTIVE',
  "version" INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SalesSequenceEnrollment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SalesSequenceEnrollment_version_check" CHECK ("version" > 0)
);

CREATE TABLE "SalesSequenceStepExecution" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "enrollmentId" TEXT NOT NULL,
  "stepId" TEXT NOT NULL,
  "status" "SalesSequenceStepExecutionStatus" NOT NULL DEFAULT 'DRAFT_PENDING',
  "version" INTEGER NOT NULL DEFAULT 1,
  "idempotencyKey" TEXT NOT NULL,
  "draftDigest" TEXT NOT NULL,
  "draftSnapshot" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SalesSequenceStepExecution_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SalesSequenceStepExecution_version_check" CHECK ("version" > 0)
);

CREATE TABLE "SalesSequenceExecutionReceipt" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "executionId" TEXT NOT NULL,
  "kind" "SalesSequenceReceiptKind" NOT NULL,
  "operationDigest" TEXT NOT NULL,
  "receipt" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SalesSequenceExecutionReceipt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SalesSequenceDraftOutbox" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "executionId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "targetRef" TEXT NOT NULL,
  "targetDigest" TEXT NOT NULL,
  "payloadDigest" TEXT NOT NULL,
  "contentSnapshot" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'DRAFT_ONLY',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SalesSequenceDraftOutbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SalesSequenceDraftOutbox_status_check" CHECK ("status" = 'DRAFT_ONLY')
);

CREATE UNIQUE INDEX "SalesSequence_companyId_ownerUserId_name_key" ON "SalesSequence"("companyId", "ownerUserId", "name");
CREATE INDEX "SalesSequence_companyId_status_createdAt_idx" ON "SalesSequence"("companyId", "status", "createdAt");
CREATE INDEX "SalesSequence_companyId_ownerUserId_idx" ON "SalesSequence"("companyId", "ownerUserId");
CREATE UNIQUE INDEX "SalesSequenceStep_sequenceId_position_key" ON "SalesSequenceStep"("sequenceId", "position");
CREATE INDEX "SalesSequenceStep_sequenceId_position_idx" ON "SalesSequenceStep"("sequenceId", "position");
CREATE UNIQUE INDEX "SalesSequenceEnrollment_companyId_sequenceId_leadId_key" ON "SalesSequenceEnrollment"("companyId", "sequenceId", "leadId");
CREATE INDEX "SalesSequenceEnrollment_companyId_status_createdAt_idx" ON "SalesSequenceEnrollment"("companyId", "status", "createdAt");
CREATE UNIQUE INDEX "SalesSequenceStepExecution_companyId_idempotencyKey_key" ON "SalesSequenceStepExecution"("companyId", "idempotencyKey");
CREATE UNIQUE INDEX "SalesSequenceStepExecution_enrollmentId_stepId_key" ON "SalesSequenceStepExecution"("enrollmentId", "stepId");
CREATE INDEX "SalesSequenceStepExecution_companyId_status_createdAt_idx" ON "SalesSequenceStepExecution"("companyId", "status", "createdAt");
CREATE UNIQUE INDEX "SalesSequenceExecutionReceipt_companyId_operationDigest_key" ON "SalesSequenceExecutionReceipt"("companyId", "operationDigest");
CREATE INDEX "SalesSequenceExecutionReceipt_executionId_createdAt_idx" ON "SalesSequenceExecutionReceipt"("executionId", "createdAt");
CREATE UNIQUE INDEX "SalesSequenceDraftOutbox_executionId_key" ON "SalesSequenceDraftOutbox"("executionId");
CREATE UNIQUE INDEX "SalesSequenceDraftOutbox_companyId_idempotencyKey_key" ON "SalesSequenceDraftOutbox"("companyId", "idempotencyKey");
CREATE INDEX "SalesSequenceDraftOutbox_companyId_status_createdAt_idx" ON "SalesSequenceDraftOutbox"("companyId", "status", "createdAt");

ALTER TABLE "SalesSequence" ADD CONSTRAINT "SalesSequence_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SalesSequence" ADD CONSTRAINT "SalesSequence_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SalesSequenceStep" ADD CONSTRAINT "SalesSequenceStep_sequenceId_fkey" FOREIGN KEY ("sequenceId") REFERENCES "SalesSequence"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SalesSequenceEnrollment" ADD CONSTRAINT "SalesSequenceEnrollment_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SalesSequenceEnrollment" ADD CONSTRAINT "SalesSequenceEnrollment_sequenceId_fkey" FOREIGN KEY ("sequenceId") REFERENCES "SalesSequence"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SalesSequenceEnrollment" ADD CONSTRAINT "SalesSequenceEnrollment_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SalesSequenceEnrollment" ADD CONSTRAINT "SalesSequenceEnrollment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SalesSequenceStepExecution" ADD CONSTRAINT "SalesSequenceStepExecution_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SalesSequenceStepExecution" ADD CONSTRAINT "SalesSequenceStepExecution_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "SalesSequenceEnrollment"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SalesSequenceStepExecution" ADD CONSTRAINT "SalesSequenceStepExecution_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "SalesSequenceStep"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SalesSequenceExecutionReceipt" ADD CONSTRAINT "SalesSequenceExecutionReceipt_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SalesSequenceExecutionReceipt" ADD CONSTRAINT "SalesSequenceExecutionReceipt_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "SalesSequenceStepExecution"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SalesSequenceDraftOutbox" ADD CONSTRAINT "SalesSequenceDraftOutbox_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SalesSequenceDraftOutbox" ADD CONSTRAINT "SalesSequenceDraftOutbox_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "SalesSequenceStepExecution"("id") ON DELETE CASCADE ON UPDATE CASCADE;
