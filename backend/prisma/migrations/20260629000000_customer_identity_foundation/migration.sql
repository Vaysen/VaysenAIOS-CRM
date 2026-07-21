-- TASK-102A: 统一客户身份基础迁移
-- 1. Lead.companyName 可空化 + 新增 companyNameSource/Confidence
-- 2. Contact.firstName/lastName 可空化 + 新增 displayName/nameSource/nameConfidence
-- 3. 新增 ExternalIdentity / IdentityMatchCandidate / IdentityExclusion / CustomerMergeAudit

-- AlterTable: Contact 名称可空 + 新增显示名称字段
ALTER TABLE "Contact" ADD COLUMN     "displayName" TEXT,
ADD COLUMN     "nameConfidence" TEXT,
ADD COLUMN     "nameSource" TEXT,
ALTER COLUMN "firstName" DROP NOT NULL,
ALTER COLUMN "lastName" DROP NOT NULL;

-- AlterTable: Lead 公司名称可空 + 新增来源/置信度字段
ALTER TABLE "Lead" ADD COLUMN     "companyNameConfidence" TEXT,
ADD COLUMN     "companyNameSource" TEXT,
ALTER COLUMN "companyName" DROP NOT NULL;

-- CreateTable: 外部身份 — 跨渠道归一化身份锚点
CREATE TABLE "ExternalIdentity" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "identityStatus" TEXT NOT NULL DEFAULT 'unresolved',
    "rawDisplayName" TEXT,
    "rawPhone" TEXT,
    "metadata" JSONB,
    "leadId" TEXT,
    "contactId" TEXT,
    "contactPointId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateTable: 身份匹配候选
CREATE TABLE "IdentityMatchCandidate" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "sourceLeadId" TEXT NOT NULL,
    "targetLeadId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "reasons" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdentityMatchCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable: 身份排除
CREATE TABLE "IdentityExclusion" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "leftLeadId" TEXT NOT NULL,
    "rightLeadId" TEXT NOT NULL,
    "reason" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdentityExclusion_pkey" PRIMARY KEY ("id")
);

-- CreateTable: 客户合并审计
CREATE TABLE "CustomerMergeAudit" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "sourceLeadId" TEXT NOT NULL,
    "targetLeadId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "beforeState" JSONB NOT NULL,
    "afterState" JSONB NOT NULL,
    "fieldChoices" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'completed',
    "targetVersion" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "undoneAt" TIMESTAMP(3),
    "undoneById" TEXT,

    CONSTRAINT "CustomerMergeAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: ExternalIdentity
CREATE INDEX "ExternalIdentity_companyId_identityStatus_idx" ON "ExternalIdentity"("companyId", "identityStatus");
CREATE UNIQUE INDEX "ExternalIdentity_companyId_provider_externalId_key" ON "ExternalIdentity"("companyId", "provider", "externalId");

-- CreateIndex: IdentityMatchCandidate
CREATE INDEX "IdentityMatchCandidate_companyId_status_score_idx" ON "IdentityMatchCandidate"("companyId", "status", "score");
CREATE UNIQUE INDEX "IdentityMatchCandidate_companyId_sourceLeadId_targetLeadId_key" ON "IdentityMatchCandidate"("companyId", "sourceLeadId", "targetLeadId");

-- CreateIndex: IdentityExclusion
CREATE INDEX "IdentityExclusion_companyId_idx" ON "IdentityExclusion"("companyId");
CREATE UNIQUE INDEX "IdentityExclusion_companyId_leftLeadId_rightLeadId_key" ON "IdentityExclusion"("companyId", "leftLeadId", "rightLeadId");

-- CreateIndex: CustomerMergeAudit
CREATE INDEX "CustomerMergeAudit_companyId_targetLeadId_createdAt_idx" ON "CustomerMergeAudit"("companyId", "targetLeadId", "createdAt");

-- AddForeignKey: ExternalIdentity
ALTER TABLE "ExternalIdentity" ADD CONSTRAINT "ExternalIdentity_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExternalIdentity" ADD CONSTRAINT "ExternalIdentity_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ExternalIdentity" ADD CONSTRAINT "ExternalIdentity_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ExternalIdentity" ADD CONSTRAINT "ExternalIdentity_contactPointId_fkey" FOREIGN KEY ("contactPointId") REFERENCES "ContactPoint"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey: IdentityMatchCandidate
ALTER TABLE "IdentityMatchCandidate" ADD CONSTRAINT "IdentityMatchCandidate_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IdentityMatchCandidate" ADD CONSTRAINT "IdentityMatchCandidate_sourceLeadId_fkey" FOREIGN KEY ("sourceLeadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IdentityMatchCandidate" ADD CONSTRAINT "IdentityMatchCandidate_targetLeadId_fkey" FOREIGN KEY ("targetLeadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: IdentityExclusion
ALTER TABLE "IdentityExclusion" ADD CONSTRAINT "IdentityExclusion_leftLeadId_fkey" FOREIGN KEY ("leftLeadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IdentityExclusion" ADD CONSTRAINT "IdentityExclusion_rightLeadId_fkey" FOREIGN KEY ("rightLeadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IdentityExclusion" ADD CONSTRAINT "IdentityExclusion_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: CustomerMergeAudit
ALTER TABLE "CustomerMergeAudit" ADD CONSTRAINT "CustomerMergeAudit_sourceLeadId_fkey" FOREIGN KEY ("sourceLeadId") REFERENCES "Lead"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomerMergeAudit" ADD CONSTRAINT "CustomerMergeAudit_targetLeadId_fkey" FOREIGN KEY ("targetLeadId") REFERENCES "Lead"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CustomerMergeAudit" ADD CONSTRAINT "CustomerMergeAudit_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
