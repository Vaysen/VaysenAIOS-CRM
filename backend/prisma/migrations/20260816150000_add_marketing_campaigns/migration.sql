-- CreateEnum
CREATE TYPE "MarketingCampaignStatus" AS ENUM ('DRAFT', 'PLANNING', 'IN_REVIEW', 'APPROVED_PLAN', 'PAUSED', 'CANCELLED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "MarketingCampaignEventKind" AS ENUM ('CAMPAIGN_CREATED', 'CAMPAIGN_UPDATED', 'STATUS_CHANGED', 'CHANNEL_PLAN_ADDED', 'CHANNEL_PLAN_UPDATED', 'CHANNEL_PLAN_REMOVED', 'AUDIENCE_SNAPSHOTTED', 'CONTENT_VERSION_CREATED', 'CONTENT_VERSION_ACTIVATED', 'PREFLIGHT_RUN', 'PREFLIGHT_ATTEMPT', 'CAMPAIGN_APPROVED', 'CAMPAIGN_PAUSED', 'CAMPAIGN_CANCELLED', 'CAMPAIGN_ARCHIVED', 'CONSENT_UPDATED', 'SUPPRESSION_ADDED', 'SUPPRESSION_REMOVED', 'KILL_SWITCH_ACTIVATED', 'KILL_SWITCH_DEACTIVATED', 'ATTRIBUTION_RECORDED', 'DELIVERY_RUN_CREATED', 'DELIVERY_RUN_STATUS_CHANGED');

-- CreateEnum
CREATE TYPE "MarketingConsentStatus" AS ENUM ('GRANTED', 'DENIED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "MarketingSuppressionScope" AS ENUM ('LEAD', 'CONTACT_POINT');

-- CreateEnum
CREATE TYPE "MarketingKillSwitchScope" AS ENUM ('GLOBAL', 'CHANNEL_EMAIL', 'CHANNEL_WHATSAPP');

-- CreateEnum
CREATE TYPE "MarketingPreflightStatus" AS ENUM ('PENDING', 'PASSED', 'FAILED');

-- CreateEnum
CREATE TYPE "MarketingDeliveryRunStatus" AS ENUM ('PENDING', 'WAITING', 'AWAITING_APPROVAL', 'READY', 'CLAIMED', 'UNKNOWN', 'SUCCEEDED', 'FAILED', 'BLOCKED', 'DEAD_LETTER');

-- CreateTable
CREATE TABLE "MarketingCampaign" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "ownerUserId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "MarketingCampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "scheduleIntent" JSONB,
    "windowStart" TIMESTAMP(3),
    "windowEnd" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketingCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketingCampaignEvent" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "kind" "MarketingCampaignEventKind" NOT NULL,
    "payload" JSONB,
    "payloadHash" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketingCampaignEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketingChannelPlan" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "windowSeconds" INTEGER NOT NULL DEFAULT 0,
    "maxPerContact" INTEGER NOT NULL DEFAULT 1,
    "scheduleJson" JSONB,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'active',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketingChannelPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketingAudienceSnapshot" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "criteriaJson" JSONB,
    "memberCount" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketingAudienceSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketingAudienceMember" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "leadId" TEXT,
    "contactPointId" TEXT,
    "contactRef" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'eligible',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketingAudienceMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketingContentVersion" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "title" TEXT,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "channel" TEXT,
    "digest" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketingContentVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketingPreflightRun" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "status" "MarketingPreflightStatus" NOT NULL DEFAULT 'PENDING',
    "summary" JSONB,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketingPreflightRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketingPreflightAttempt" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "preflightRunId" TEXT NOT NULL,
    "gate" TEXT NOT NULL,
    "passed" BOOLEAN NOT NULL,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketingPreflightAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketingConsent" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "leadId" TEXT,
    "contactPointId" TEXT,
    "contactRef" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" "MarketingConsentStatus" NOT NULL DEFAULT 'UNKNOWN',
    "source" TEXT,
    "expiresAt" TIMESTAMP(3),
    "grantedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketingConsent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketingSuppression" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "scope" "MarketingSuppressionScope" NOT NULL,
    "leadId" TEXT,
    "contactPointId" TEXT,
    "contactRef" TEXT,
    "channel" TEXT,
    "reason" TEXT,
    "source" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "expiresAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketingSuppression_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketingKillSwitch" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "scope" "MarketingKillSwitchScope" NOT NULL,
    "channel" TEXT,
    "reason" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "activatedById" TEXT,
    "activatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deactivatedById" TEXT,
    "deactivatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketingKillSwitch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketingAttribution" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "channelPlanId" TEXT,
    "leadId" TEXT,
    "contactPointId" TEXT,
    "contactRef" TEXT,
    "channel" TEXT NOT NULL,
    "source" TEXT,
    "meta" JSONB,
    "attributedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MarketingAttribution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MarketingDeliveryRun" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "channelPlanId" TEXT,
    "audienceMemberId" TEXT,
    "leadId" TEXT,
    "contactPointId" TEXT,
    "contactRef" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" "MarketingDeliveryRunStatus" NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "scheduledFor" TIMESTAMP(3),
    "claimedAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "payloadJson" JSONB,
    "payloadHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MarketingDeliveryRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MarketingCampaign_companyId_status_createdAt_idx" ON "MarketingCampaign"("companyId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "MarketingCampaign_companyId_ownerUserId_idx" ON "MarketingCampaign"("companyId", "ownerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketingCampaign_companyId_name_key" ON "MarketingCampaign"("companyId", "name");

-- CreateIndex
CREATE INDEX "MarketingCampaignEvent_campaignId_createdAt_idx" ON "MarketingCampaignEvent"("campaignId", "createdAt");

-- CreateIndex
CREATE INDEX "MarketingCampaignEvent_companyId_createdAt_idx" ON "MarketingCampaignEvent"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "MarketingCampaignEvent_payloadHash_idx" ON "MarketingCampaignEvent"("payloadHash");

-- CreateIndex
CREATE INDEX "MarketingChannelPlan_companyId_campaignId_idx" ON "MarketingChannelPlan"("companyId", "campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketingChannelPlan_campaignId_channel_key" ON "MarketingChannelPlan"("campaignId", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "MarketingAudienceSnapshot_campaignId_key" ON "MarketingAudienceSnapshot"("campaignId");

-- CreateIndex
CREATE INDEX "MarketingAudienceSnapshot_companyId_createdAt_idx" ON "MarketingAudienceSnapshot"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "MarketingAudienceMember_companyId_channel_idx" ON "MarketingAudienceMember"("companyId", "channel");

-- CreateIndex
CREATE INDEX "MarketingAudienceMember_snapshotId_idx" ON "MarketingAudienceMember"("snapshotId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketingAudienceMember_snapshotId_contactRef_channel_key" ON "MarketingAudienceMember"("snapshotId", "contactRef", "channel");

-- CreateIndex
CREATE INDEX "MarketingContentVersion_companyId_campaignId_idx" ON "MarketingContentVersion"("companyId", "campaignId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketingContentVersion_campaignId_version_key" ON "MarketingContentVersion"("campaignId", "version");

-- CreateIndex
CREATE INDEX "MarketingPreflightRun_companyId_campaignId_createdAt_idx" ON "MarketingPreflightRun"("companyId", "campaignId", "createdAt");

-- CreateIndex
CREATE INDEX "MarketingPreflightAttempt_preflightRunId_idx" ON "MarketingPreflightAttempt"("preflightRunId");

-- CreateIndex
CREATE INDEX "MarketingPreflightAttempt_companyId_gate_idx" ON "MarketingPreflightAttempt"("companyId", "gate");

-- CreateIndex
CREATE INDEX "MarketingConsent_companyId_channel_status_idx" ON "MarketingConsent"("companyId", "channel", "status");

-- CreateIndex
CREATE INDEX "MarketingConsent_companyId_leadId_idx" ON "MarketingConsent"("companyId", "leadId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketingConsent_companyId_channel_contactRef_key" ON "MarketingConsent"("companyId", "channel", "contactRef");

-- CreateIndex
CREATE INDEX "MarketingSuppression_companyId_active_channel_idx" ON "MarketingSuppression"("companyId", "active", "channel");

-- CreateIndex
CREATE INDEX "MarketingSuppression_companyId_leadId_idx" ON "MarketingSuppression"("companyId", "leadId");

-- CreateIndex
CREATE UNIQUE INDEX "MarketingSuppression_companyId_scope_contactRef_channel_key" ON "MarketingSuppression"("companyId", "scope", "contactRef", "channel");

-- CreateIndex
CREATE INDEX "MarketingKillSwitch_companyId_active_idx" ON "MarketingKillSwitch"("companyId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "MarketingKillSwitch_companyId_scope_channel_key" ON "MarketingKillSwitch"("companyId", "scope", "channel");

-- CreateIndex
CREATE INDEX "MarketingAttribution_companyId_campaignId_attributedAt_idx" ON "MarketingAttribution"("companyId", "campaignId", "attributedAt");

-- CreateIndex
CREATE INDEX "MarketingAttribution_companyId_leadId_idx" ON "MarketingAttribution"("companyId", "leadId");

-- CreateIndex
CREATE INDEX "MarketingDeliveryRun_companyId_status_scheduledFor_idx" ON "MarketingDeliveryRun"("companyId", "status", "scheduledFor");

-- CreateIndex
CREATE INDEX "MarketingDeliveryRun_companyId_campaignId_status_idx" ON "MarketingDeliveryRun"("companyId", "campaignId", "status");

-- CreateIndex
CREATE INDEX "MarketingDeliveryRun_companyId_contactRef_channel_idx" ON "MarketingDeliveryRun"("companyId", "contactRef", "channel");

-- AddForeignKey
ALTER TABLE "MarketingCampaign" ADD CONSTRAINT "MarketingCampaign_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingCampaign" ADD CONSTRAINT "MarketingCampaign_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingCampaign" ADD CONSTRAINT "MarketingCampaign_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingCampaignEvent" ADD CONSTRAINT "MarketingCampaignEvent_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingCampaignEvent" ADD CONSTRAINT "MarketingCampaignEvent_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingCampaignEvent" ADD CONSTRAINT "MarketingCampaignEvent_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingChannelPlan" ADD CONSTRAINT "MarketingChannelPlan_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingChannelPlan" ADD CONSTRAINT "MarketingChannelPlan_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingAudienceSnapshot" ADD CONSTRAINT "MarketingAudienceSnapshot_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingAudienceSnapshot" ADD CONSTRAINT "MarketingAudienceSnapshot_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingAudienceSnapshot" ADD CONSTRAINT "MarketingAudienceSnapshot_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingAudienceMember" ADD CONSTRAINT "MarketingAudienceMember_snapshotId_fkey" FOREIGN KEY ("snapshotId") REFERENCES "MarketingAudienceSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingAudienceMember" ADD CONSTRAINT "MarketingAudienceMember_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingAudienceMember" ADD CONSTRAINT "MarketingAudienceMember_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingAudienceMember" ADD CONSTRAINT "MarketingAudienceMember_contactPointId_fkey" FOREIGN KEY ("contactPointId") REFERENCES "ContactPoint"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingContentVersion" ADD CONSTRAINT "MarketingContentVersion_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingContentVersion" ADD CONSTRAINT "MarketingContentVersion_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingContentVersion" ADD CONSTRAINT "MarketingContentVersion_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingPreflightRun" ADD CONSTRAINT "MarketingPreflightRun_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingPreflightRun" ADD CONSTRAINT "MarketingPreflightRun_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingPreflightRun" ADD CONSTRAINT "MarketingPreflightRun_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingPreflightAttempt" ADD CONSTRAINT "MarketingPreflightAttempt_preflightRunId_fkey" FOREIGN KEY ("preflightRunId") REFERENCES "MarketingPreflightRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingPreflightAttempt" ADD CONSTRAINT "MarketingPreflightAttempt_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingConsent" ADD CONSTRAINT "MarketingConsent_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingConsent" ADD CONSTRAINT "MarketingConsent_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingConsent" ADD CONSTRAINT "MarketingConsent_contactPointId_fkey" FOREIGN KEY ("contactPointId") REFERENCES "ContactPoint"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingConsent" ADD CONSTRAINT "MarketingConsent_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingSuppression" ADD CONSTRAINT "MarketingSuppression_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingSuppression" ADD CONSTRAINT "MarketingSuppression_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingSuppression" ADD CONSTRAINT "MarketingSuppression_contactPointId_fkey" FOREIGN KEY ("contactPointId") REFERENCES "ContactPoint"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingSuppression" ADD CONSTRAINT "MarketingSuppression_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingKillSwitch" ADD CONSTRAINT "MarketingKillSwitch_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingKillSwitch" ADD CONSTRAINT "MarketingKillSwitch_activatedById_fkey" FOREIGN KEY ("activatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingKillSwitch" ADD CONSTRAINT "MarketingKillSwitch_deactivatedById_fkey" FOREIGN KEY ("deactivatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingAttribution" ADD CONSTRAINT "MarketingAttribution_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingAttribution" ADD CONSTRAINT "MarketingAttribution_channelPlanId_fkey" FOREIGN KEY ("channelPlanId") REFERENCES "MarketingChannelPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingAttribution" ADD CONSTRAINT "MarketingAttribution_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingAttribution" ADD CONSTRAINT "MarketingAttribution_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingAttribution" ADD CONSTRAINT "MarketingAttribution_contactPointId_fkey" FOREIGN KEY ("contactPointId") REFERENCES "ContactPoint"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingDeliveryRun" ADD CONSTRAINT "MarketingDeliveryRun_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingDeliveryRun" ADD CONSTRAINT "MarketingDeliveryRun_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MarketingCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingDeliveryRun" ADD CONSTRAINT "MarketingDeliveryRun_channelPlanId_fkey" FOREIGN KEY ("channelPlanId") REFERENCES "MarketingChannelPlan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingDeliveryRun" ADD CONSTRAINT "MarketingDeliveryRun_audienceMemberId_fkey" FOREIGN KEY ("audienceMemberId") REFERENCES "MarketingAudienceMember"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingDeliveryRun" ADD CONSTRAINT "MarketingDeliveryRun_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MarketingDeliveryRun" ADD CONSTRAINT "MarketingDeliveryRun_contactPointId_fkey" FOREIGN KEY ("contactPointId") REFERENCES "ContactPoint"("id") ON DELETE SET NULL ON UPDATE CASCADE;

