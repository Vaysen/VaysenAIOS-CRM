-- USD pricing snapshots make every issued quote reproducible.
ALTER TABLE "QuoteLineItem"
  ADD COLUMN "catalogItemId" TEXT,
  ADD COLUMN "costPriceCny" DECIMAL(10,4),
  ADD COLUMN "sourceCurrency" TEXT,
  ADD COLUMN "fxRate" DECIMAL(10,4),
  ADD COLUMN "markup" DECIMAL(8,4),
  ADD COLUMN "priceVersion" TEXT,
  ADD COLUMN "priceSource" TEXT;

CREATE INDEX "QuoteLineItem_catalogItemId_idx" ON "QuoteLineItem"("catalogItemId");

CREATE TABLE "VoiceCall" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "leadId" TEXT,
  "conversationId" TEXT,
  "provider" TEXT NOT NULL DEFAULT 'livekit',
  "externalCallId" TEXT,
  "channel" TEXT NOT NULL DEFAULT 'web_test',
  "direction" TEXT NOT NULL DEFAULT 'inbound',
  "status" TEXT NOT NULL DEFAULT 'queued',
  "locale" TEXT NOT NULL DEFAULT 'zh-CN',
  "customerNumber" TEXT,
  "assignedUserId" TEXT,
  "consentStatus" TEXT NOT NULL DEFAULT 'pending',
  "recordingEnabled" BOOLEAN NOT NULL DEFAULT false,
  "summary" TEXT,
  "handoffReason" TEXT,
  "handoffContext" JSONB,
  "startedAt" TIMESTAMP(3),
  "answeredAt" TIMESTAMP(3),
  "endedAt" TIMESTAMP(3),
  "failureCode" TEXT,
  "failureDetail" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "VoiceCall_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "VoiceCallEvent" (
  "id" TEXT NOT NULL,
  "voiceCallId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "role" TEXT,
  "content" TEXT,
  "providerEventId" TEXT,
  "metadata" JSONB,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "VoiceCallEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "VoiceCall_companyId_provider_externalCallId_key"
  ON "VoiceCall"("companyId", "provider", "externalCallId");
CREATE INDEX "VoiceCall_companyId_status_createdAt_idx"
  ON "VoiceCall"("companyId", "status", "createdAt" DESC);
CREATE INDEX "VoiceCall_leadId_idx" ON "VoiceCall"("leadId");
CREATE INDEX "VoiceCall_conversationId_idx" ON "VoiceCall"("conversationId");
CREATE UNIQUE INDEX "VoiceCallEvent_voiceCallId_providerEventId_key"
  ON "VoiceCallEvent"("voiceCallId", "providerEventId");
CREATE INDEX "VoiceCallEvent_voiceCallId_occurredAt_idx"
  ON "VoiceCallEvent"("voiceCallId", "occurredAt");
CREATE INDEX "VoiceCallEvent_eventType_idx" ON "VoiceCallEvent"("eventType");

ALTER TABLE "VoiceCall" ADD CONSTRAINT "VoiceCall_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "VoiceCall" ADD CONSTRAINT "VoiceCall_leadId_fkey"
  FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "VoiceCall" ADD CONSTRAINT "VoiceCall_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "VoiceCallEvent" ADD CONSTRAINT "VoiceCallEvent_voiceCallId_fkey"
  FOREIGN KEY ("voiceCallId") REFERENCES "VoiceCall"("id") ON DELETE CASCADE ON UPDATE CASCADE;
