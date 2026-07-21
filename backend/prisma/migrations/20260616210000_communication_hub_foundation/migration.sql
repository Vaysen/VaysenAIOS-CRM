-- Communication Hub Foundation
-- Adds: ContactPoint, Conversation, CommunicationMessage, AiArtifact
-- Modifies: LeadActivity (adds communicationMessageId FK)

-- CreateTable
CREATE TABLE "ContactPoint" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "leadId" TEXT,
    "contactId" TEXT,
    "type" TEXT NOT NULL,
    "originalValue" TEXT NOT NULL,
    "normalizedValue" TEXT NOT NULL,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "verifiedAt" TIMESTAMP(3),
    "verifiedBy" TEXT,
    "verificationMethod" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContactPoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "leadId" TEXT,
    "contactPointId" TEXT,
    "channel" TEXT NOT NULL,
    "subject" TEXT,
    "externalThreadId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "lastMessageAt" TIMESTAMP(3),
    "lastMessagePreview" TEXT,
    "unreadCount" INTEGER NOT NULL DEFAULT 0,
    "assignedUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommunicationMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "translatedContent" TEXT,
    "contentType" TEXT NOT NULL DEFAULT 'text',
    "externalMessageId" TEXT,
    "fromAddress" TEXT,
    "toAddress" TEXT,
    "subject" TEXT,
    "attachmentsMeta" JSONB,
    "sentAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommunicationMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiArtifact" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "communicationMessageId" TEXT,
    "conversationId" TEXT,
    "leadId" TEXT,
    "artifactType" TEXT NOT NULL,
    "inputContent" TEXT NOT NULL,
    "outputContent" TEXT NOT NULL,
    "extraData" JSONB,
    "provider" TEXT,
    "model" TEXT,
    "status" TEXT NOT NULL DEFAULT 'generated',
    "acceptedBy" TEXT,
    "acceptedAt" TIMESTAMP(3),
    "modifiedOutput" TEXT,
    "rejectedBy" TEXT,
    "rejectedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiArtifact_pkey" PRIMARY KEY ("id")
);

-- AlterTable: LeadActivity gains optional link to CommunicationMessage
ALTER TABLE "LeadActivity" ADD COLUMN "communicationMessageId" TEXT;

-- CreateIndex: ContactPoint
CREATE INDEX "ContactPoint_companyId_type_idx" ON "ContactPoint"("companyId", "type");
CREATE INDEX "ContactPoint_normalizedValue_idx" ON "ContactPoint"("normalizedValue");
CREATE INDEX "ContactPoint_leadId_idx" ON "ContactPoint"("leadId");
CREATE INDEX "ContactPoint_contactId_idx" ON "ContactPoint"("contactId");
CREATE UNIQUE INDEX "ContactPoint_companyId_type_normalizedValue_key" ON "ContactPoint"("companyId", "type", "normalizedValue");

-- CreateIndex: Conversation
CREATE INDEX "Conversation_companyId_channel_status_idx" ON "Conversation"("companyId", "channel", "status");
CREATE INDEX "Conversation_companyId_leadId_idx" ON "Conversation"("companyId", "leadId");
CREATE INDEX "Conversation_companyId_lastMessageAt_idx" ON "Conversation"("companyId", "lastMessageAt" DESC);
CREATE INDEX "Conversation_externalThreadId_idx" ON "Conversation"("externalThreadId");
CREATE INDEX "Conversation_assignedUserId_idx" ON "Conversation"("assignedUserId");

-- CreateIndex: CommunicationMessage
CREATE INDEX "CommunicationMessage_conversationId_createdAt_idx" ON "CommunicationMessage"("conversationId", "createdAt");
CREATE INDEX "CommunicationMessage_externalMessageId_idx" ON "CommunicationMessage"("externalMessageId");
CREATE INDEX "CommunicationMessage_direction_idx" ON "CommunicationMessage"("direction");

-- CreateIndex: AiArtifact
CREATE INDEX "AiArtifact_companyId_artifactType_createdAt_idx" ON "AiArtifact"("companyId", "artifactType", "createdAt" DESC);
CREATE INDEX "AiArtifact_communicationMessageId_idx" ON "AiArtifact"("communicationMessageId");
CREATE INDEX "AiArtifact_conversationId_idx" ON "AiArtifact"("conversationId");
CREATE INDEX "AiArtifact_leadId_idx" ON "AiArtifact"("leadId");
CREATE INDEX "AiArtifact_status_idx" ON "AiArtifact"("status");

-- CreateIndex: LeadActivity new column
CREATE INDEX "LeadActivity_communicationMessageId_idx" ON "LeadActivity"("communicationMessageId");

-- AddForeignKey: LeadActivity → CommunicationMessage
ALTER TABLE "LeadActivity" ADD CONSTRAINT "LeadActivity_communicationMessageId_fkey" FOREIGN KEY ("communicationMessageId") REFERENCES "CommunicationMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: ContactPoint
ALTER TABLE "ContactPoint" ADD CONSTRAINT "ContactPoint_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ContactPoint" ADD CONSTRAINT "ContactPoint_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ContactPoint" ADD CONSTRAINT "ContactPoint_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: Conversation
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_contactPointId_fkey" FOREIGN KEY ("contactPointId") REFERENCES "ContactPoint"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_assignedUserId_fkey" FOREIGN KEY ("assignedUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: CommunicationMessage
ALTER TABLE "CommunicationMessage" ADD CONSTRAINT "CommunicationMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: AiArtifact
ALTER TABLE "AiArtifact" ADD CONSTRAINT "AiArtifact_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AiArtifact" ADD CONSTRAINT "AiArtifact_communicationMessageId_fkey" FOREIGN KEY ("communicationMessageId") REFERENCES "CommunicationMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AiArtifact" ADD CONSTRAINT "AiArtifact_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AiArtifact" ADD CONSTRAINT "AiArtifact_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;
