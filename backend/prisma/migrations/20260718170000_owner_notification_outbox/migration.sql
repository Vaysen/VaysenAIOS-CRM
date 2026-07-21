BEGIN;

CREATE TYPE "OwnerNotificationStatus" AS ENUM (
  'PENDING',
  'SENDING',
  'SENT',
  'FAILED'
);

CREATE TABLE "OwnerNotificationOutbox" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "eventKey" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "destination" TEXT NOT NULL DEFAULT 'OWNER_WECHAT',
  "sourceType" TEXT NOT NULL,
  "sourceId" TEXT,
  "conversationId" TEXT,
  "leadId" TEXT,
  "subject" TEXT,
  "preview" TEXT NOT NULL,
  "status" "OwnerNotificationStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 5,
  "nextAttemptAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "claimedAt" TIMESTAMP(3),
  "sentAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "provider" TEXT,
  "providerReceiptId" TEXT,
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OwnerNotificationOutbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OwnerNotificationOutbox_eventKey_key"
  ON "OwnerNotificationOutbox"("eventKey");
CREATE INDEX "OwnerNotificationOutbox_status_nextAttemptAt_idx"
  ON "OwnerNotificationOutbox"("status", "nextAttemptAt");
CREATE INDEX "OwnerNotificationOutbox_status_expiresAt_idx"
  ON "OwnerNotificationOutbox"("status", "expiresAt");
CREATE INDEX "OwnerNotificationOutbox_companyId_status_createdAt_idx"
  ON "OwnerNotificationOutbox"("companyId", "status", "createdAt");

ALTER TABLE "OwnerNotificationOutbox"
  ADD CONSTRAINT "OwnerNotificationOutbox_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
