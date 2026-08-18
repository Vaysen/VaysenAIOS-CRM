-- CreateEnum
CREATE TYPE "SalesDeliveryRenderJobStatus" AS ENUM ('QUEUED', 'PROCESSING', 'COMPLETED', 'FAILED', 'DEAD_LETTER');

-- CreateEnum
CREATE TYPE "SalesDeliveryChannel" AS ENUM ('EMAIL', 'WHATSAPP', 'META');

-- CreateEnum
CREATE TYPE "SalesDeliveryOutboundStatus" AS ENUM ('DISPATCHING', 'SENT', 'UNKNOWN', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SalesDeliveryReceiptOutcome" AS ENUM ('SENT', 'DELIVERED', 'READ', 'FAILED', 'REJECTED', 'DEFERRED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "SalesDeliveryApprovalStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateTable
CREATE TABLE "QuoteRenderJob" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "quoteVersion" INTEGER NOT NULL DEFAULT 1,
    "quoteHash" TEXT NOT NULL,
    "status" "SalesDeliveryRenderJobStatus" NOT NULL DEFAULT 'QUEUED',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "leaseId" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "assetPath" TEXT,
    "assetUrl" TEXT,
    "mimeType" TEXT DEFAULT 'application/pdf',
    "error" TEXT,
    "nextRetryAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuoteRenderJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboundRequest" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "quoteId" TEXT NOT NULL,
    "renderJobId" TEXT,
    "channel" "SalesDeliveryChannel" NOT NULL,
    "target" TEXT NOT NULL,
    "status" "SalesDeliveryOutboundStatus" NOT NULL DEFAULT 'DISPATCHING',
    "subject" TEXT,
    "body" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 3,
    "nextRetryAt" TIMESTAMP(3),
    "providerMessageId" TEXT,
    "connectionBindingId" TEXT,
    "payloadHash" TEXT,
    "lastError" TEXT,
    "sentAt" TIMESTAMP(3),
    "succeededAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutboundRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboundProviderReceipt" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "outboundRequestId" TEXT,
    "provider" "SalesDeliveryChannel" NOT NULL,
    "receiptKey" TEXT NOT NULL,
    "outcome" "SalesDeliveryReceiptOutcome" NOT NULL DEFAULT 'UNKNOWN',
    "raw" JSONB,
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboundProviderReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeliveryConnectionBinding" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "provider" "SalesDeliveryChannel" NOT NULL,
    "connectionId" TEXT NOT NULL,
    "label" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeliveryConnectionBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecretRef" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "uri" TEXT NOT NULL,
    "description" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SecretRef_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetaTemplateSnapshot" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "metaTemplateId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'en_US',
    "body" TEXT,
    "digest" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MetaTemplateSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalesDeliveryWorkerHeartbeat" (
    "id" TEXT NOT NULL,
    "companyId" TEXT,
    "workerId" TEXT NOT NULL,
    "nodeId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'alive',
    "lastHeartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SalesDeliveryWorkerHeartbeat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboundApprovalRequest" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "outboundRequestId" TEXT,
    "quoteId" TEXT,
    "status" "SalesDeliveryApprovalStatus" NOT NULL DEFAULT 'PENDING',
    "requesterId" TEXT NOT NULL,
    "approverId" TEXT,
    "decision" TEXT,
    "reason" TEXT,
    "decidedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutboundApprovalRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "QuoteRenderJob_companyId_status_idx" ON "QuoteRenderJob"("companyId", "status");

-- CreateIndex
CREATE INDEX "QuoteRenderJob_status_leaseExpiresAt_idx" ON "QuoteRenderJob"("status", "leaseExpiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "QuoteRenderJob_quoteId_quoteVersion_key" ON "QuoteRenderJob"("quoteId", "quoteVersion");

-- CreateIndex
CREATE INDEX "OutboundRequest_companyId_status_nextRetryAt_idx" ON "OutboundRequest"("companyId", "status", "nextRetryAt");

-- CreateIndex
CREATE INDEX "OutboundRequest_companyId_quoteId_idx" ON "OutboundRequest"("companyId", "quoteId");

-- CreateIndex
CREATE INDEX "OutboundRequest_providerMessageId_idx" ON "OutboundRequest"("providerMessageId");

-- CreateIndex
CREATE INDEX "OutboundRequest_companyId_target_channel_idx" ON "OutboundRequest"("companyId", "target", "channel");

-- CreateIndex
CREATE INDEX "OutboundProviderReceipt_outboundRequestId_createdAt_idx" ON "OutboundProviderReceipt"("outboundRequestId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "OutboundProviderReceipt_provider_receiptKey_key" ON "OutboundProviderReceipt"("provider", "receiptKey");

-- CreateIndex
CREATE INDEX "DeliveryConnectionBinding_companyId_provider_active_idx" ON "DeliveryConnectionBinding"("companyId", "provider", "active");

-- CreateIndex
CREATE UNIQUE INDEX "DeliveryConnectionBinding_companyId_provider_connectionId_key" ON "DeliveryConnectionBinding"("companyId", "provider", "connectionId");

-- CreateIndex
CREATE UNIQUE INDEX "SecretRef_companyId_name_key" ON "SecretRef"("companyId", "name");

-- CreateIndex
CREATE INDEX "MetaTemplateSnapshot_companyId_isActive_idx" ON "MetaTemplateSnapshot"("companyId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "MetaTemplateSnapshot_companyId_metaTemplateId_locale_key" ON "MetaTemplateSnapshot"("companyId", "metaTemplateId", "locale");

-- CreateIndex
CREATE INDEX "SalesDeliveryWorkerHeartbeat_companyId_idx" ON "SalesDeliveryWorkerHeartbeat"("companyId");

-- CreateIndex
CREATE INDEX "SalesDeliveryWorkerHeartbeat_status_idx" ON "SalesDeliveryWorkerHeartbeat"("status");

-- CreateIndex
CREATE UNIQUE INDEX "SalesDeliveryWorkerHeartbeat_workerId_key" ON "SalesDeliveryWorkerHeartbeat"("workerId");

-- CreateIndex
CREATE INDEX "OutboundApprovalRequest_companyId_status_idx" ON "OutboundApprovalRequest"("companyId", "status");

-- CreateIndex
CREATE INDEX "OutboundApprovalRequest_outboundRequestId_idx" ON "OutboundApprovalRequest"("outboundRequestId");

-- CreateIndex
CREATE INDEX "OutboundApprovalRequest_quoteId_idx" ON "OutboundApprovalRequest"("quoteId");

-- AddForeignKey
ALTER TABLE "QuoteRenderJob" ADD CONSTRAINT "QuoteRenderJob_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteRenderJob" ADD CONSTRAINT "QuoteRenderJob_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteRenderJob" ADD CONSTRAINT "QuoteRenderJob_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundRequest" ADD CONSTRAINT "OutboundRequest_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundRequest" ADD CONSTRAINT "OutboundRequest_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundRequest" ADD CONSTRAINT "OutboundRequest_renderJobId_fkey" FOREIGN KEY ("renderJobId") REFERENCES "QuoteRenderJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundRequest" ADD CONSTRAINT "OutboundRequest_connectionBindingId_fkey" FOREIGN KEY ("connectionBindingId") REFERENCES "DeliveryConnectionBinding"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundRequest" ADD CONSTRAINT "OutboundRequest_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundProviderReceipt" ADD CONSTRAINT "OutboundProviderReceipt_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundProviderReceipt" ADD CONSTRAINT "OutboundProviderReceipt_outboundRequestId_fkey" FOREIGN KEY ("outboundRequestId") REFERENCES "OutboundRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryConnectionBinding" ADD CONSTRAINT "DeliveryConnectionBinding_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeliveryConnectionBinding" ADD CONSTRAINT "DeliveryConnectionBinding_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SecretRef" ADD CONSTRAINT "SecretRef_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SecretRef" ADD CONSTRAINT "SecretRef_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MetaTemplateSnapshot" ADD CONSTRAINT "MetaTemplateSnapshot_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalesDeliveryWorkerHeartbeat" ADD CONSTRAINT "SalesDeliveryWorkerHeartbeat_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundApprovalRequest" ADD CONSTRAINT "OutboundApprovalRequest_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundApprovalRequest" ADD CONSTRAINT "OutboundApprovalRequest_outboundRequestId_fkey" FOREIGN KEY ("outboundRequestId") REFERENCES "OutboundRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundApprovalRequest" ADD CONSTRAINT "OutboundApprovalRequest_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "Quote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundApprovalRequest" ADD CONSTRAINT "OutboundApprovalRequest_requesterId_fkey" FOREIGN KEY ("requesterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundApprovalRequest" ADD CONSTRAINT "OutboundApprovalRequest_approverId_fkey" FOREIGN KEY ("approverId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

