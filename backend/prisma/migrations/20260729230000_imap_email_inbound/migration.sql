ALTER TABLE "EmailAccount"
  ADD COLUMN "imapHost" TEXT,
  ADD COLUMN "imapPort" INTEGER,
  ADD COLUMN "imapSecure" BOOLEAN,
  ADD COLUMN "imapUsername" TEXT,
  ADD COLUMN "imapPasswordEncrypted" TEXT,
  ADD COLUMN "inboundEnabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "inboundPollIntervalSeconds" INTEGER NOT NULL DEFAULT 300,
  ADD COLUMN "inboundLastSyncAt" TIMESTAMP(3),
  ADD COLUMN "inboundLastSyncStatus" TEXT,
  ADD COLUMN "inboundLastSyncError" TEXT,
  ADD COLUMN "inboundUidValidity" BIGINT,
  ADD COLUMN "inboundUidCursor" BIGINT;

ALTER TABLE "CommunicationMessage"
  ADD COLUMN "htmlContent" TEXT,
  ADD COLUMN "ccAddresses" JSONB,
  ADD COLUMN "rawMessageId" TEXT,
  ADD COLUMN "sourceAccountId" TEXT,
  ADD COLUMN "imapUid" BIGINT,
  ADD COLUMN "imapUidValidity" BIGINT;

CREATE TABLE "EmailInboundReview" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "communicationMessageId" TEXT NOT NULL,
  "fromEmail" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "candidateLeadIds" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "resolvedLeadId" TEXT,
  "resolvedById" TEXT,
  "resolvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EmailInboundReview_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "EmailInboundReview_communicationMessageId_key" ON "EmailInboundReview"("communicationMessageId");
CREATE INDEX "EmailInboundReview_companyId_status_createdAt_idx" ON "EmailInboundReview"("companyId", "status", "createdAt");
CREATE INDEX "CommunicationMessage_sourceAccountId_imapUidValidity_imapUid_idx" ON "CommunicationMessage"("sourceAccountId", "imapUidValidity", "imapUid");
ALTER TABLE "EmailInboundReview" ADD CONSTRAINT "EmailInboundReview_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EmailInboundReview" ADD CONSTRAINT "EmailInboundReview_communicationMessageId_fkey" FOREIGN KEY ("communicationMessageId") REFERENCES "CommunicationMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EmailInboundReview" ADD CONSTRAINT "EmailInboundReview_resolvedLeadId_fkey" FOREIGN KEY ("resolvedLeadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "EmailInboundReview" ADD CONSTRAINT "EmailInboundReview_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
