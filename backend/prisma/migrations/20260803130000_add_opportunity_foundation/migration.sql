-- CRM-02A: additive Opportunity foundation.
--
-- This artifact is intentionally unapplied. It creates no rows, changes no
-- Lead.status semantics, and keeps Quote/Order opportunityId nullable for
-- legacy clients and the later compatibility/backfill packages.

CREATE TABLE "Opportunity" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "ownerUserId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "stage" TEXT NOT NULL DEFAULT 'new',
    "amount" DECIMAL(14,2),
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "probability" INTEGER NOT NULL DEFAULT 10,
    "expectedCloseDate" TIMESTAMP(3),
    "nextStep" TEXT,
    "wonAt" TIMESTAMP(3),
    "lostAt" TIMESTAMP(3),
    "lostReason" TEXT,
    "legacySeedKey" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Opportunity_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "Opportunity_stage_check"
      CHECK ("stage" IN ('new', 'discovery', 'qualified', 'proposal', 'negotiation', 'won', 'lost')),
    CONSTRAINT "Opportunity_amount_check"
      CHECK ("amount" IS NULL OR "amount" >= 0),
    CONSTRAINT "Opportunity_currency_check"
      CHECK ("currency" ~ '^[A-Z]{3}$'),
    CONSTRAINT "Opportunity_probability_check"
      CHECK ("probability" BETWEEN 0 AND 100),
    CONSTRAINT "Opportunity_version_check"
      CHECK ("version" > 0)
);

CREATE TABLE "OpportunityStageHistory" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "fromStage" TEXT,
    "toStage" TEXT NOT NULL,
    "changedBy" TEXT,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,
    "amountSnapshot" DECIMAL(14,2),
    "probabilitySnapshot" INTEGER,
    "expectedCloseDateSnapshot" TIMESTAMP(3),
    "source" TEXT NOT NULL DEFAULT 'USER',

    CONSTRAINT "OpportunityStageHistory_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "OpportunityStageHistory_fromStage_check"
      CHECK ("fromStage" IS NULL OR "fromStage" IN ('new', 'discovery', 'qualified', 'proposal', 'negotiation', 'won', 'lost')),
    CONSTRAINT "OpportunityStageHistory_toStage_check"
      CHECK ("toStage" IN ('new', 'discovery', 'qualified', 'proposal', 'negotiation', 'won', 'lost')),
    CONSTRAINT "OpportunityStageHistory_amountSnapshot_check"
      CHECK ("amountSnapshot" IS NULL OR "amountSnapshot" >= 0),
    CONSTRAINT "OpportunityStageHistory_probabilitySnapshot_check"
      CHECK ("probabilitySnapshot" IS NULL OR "probabilitySnapshot" BETWEEN 0 AND 100),
    CONSTRAINT "OpportunityStageHistory_source_check"
      CHECK ("source" IN ('USER', 'SYSTEM', 'LEGACY_MIGRATION', 'COMPATIBILITY'))
);

CREATE TABLE "OpportunityContactRole" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "opportunityId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "roleType" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpportunityContactRole_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "OpportunityContactRole_roleType_check"
      CHECK ("roleType" IN ('decision_maker', 'buyer', 'champion', 'influencer', 'technical', 'finance', 'shipping', 'other'))
);

ALTER TABLE "Quote" ADD COLUMN "opportunityId" TEXT;
ALTER TABLE "Order" ADD COLUMN "opportunityId" TEXT;

CREATE UNIQUE INDEX "Opportunity_companyId_legacySeedKey_key"
    ON "Opportunity"("companyId", "legacySeedKey");
CREATE INDEX "Opportunity_companyId_stage_expectedCloseDate_idx"
    ON "Opportunity"("companyId", "stage", "expectedCloseDate");
CREATE INDEX "Opportunity_companyId_leadId_createdAt_idx"
    ON "Opportunity"("companyId", "leadId", "createdAt");
CREATE INDEX "Opportunity_companyId_ownerUserId_stage_idx"
    ON "Opportunity"("companyId", "ownerUserId", "stage");
CREATE INDEX "Opportunity_leadId_stage_idx"
    ON "Opportunity"("leadId", "stage");

CREATE INDEX "OpportunityStageHistory_opportunityId_changedAt_idx"
    ON "OpportunityStageHistory"("opportunityId", "changedAt");
CREATE INDEX "OpportunityStageHistory_companyId_changedAt_idx"
    ON "OpportunityStageHistory"("companyId", "changedAt");

CREATE UNIQUE INDEX "OpportunityContactRole_opportunityId_contactId_key"
    ON "OpportunityContactRole"("opportunityId", "contactId");
CREATE UNIQUE INDEX "OpportunityContactRole_one_primary_per_opportunity_key"
    ON "OpportunityContactRole"("opportunityId")
    WHERE "isPrimary" = true;
CREATE INDEX "OpportunityContactRole_companyId_contactId_idx"
    ON "OpportunityContactRole"("companyId", "contactId");
CREATE INDEX "OpportunityContactRole_companyId_opportunityId_roleType_idx"
    ON "OpportunityContactRole"("companyId", "opportunityId", "roleType");

CREATE INDEX "Quote_opportunityId_idx" ON "Quote"("opportunityId");
CREATE INDEX "Order_opportunityId_idx" ON "Order"("opportunityId");

ALTER TABLE "Opportunity"
    ADD CONSTRAINT "Opportunity_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Opportunity"
    ADD CONSTRAINT "Opportunity_leadId_fkey"
    FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Opportunity"
    ADD CONSTRAINT "Opportunity_ownerUserId_fkey"
    FOREIGN KEY ("ownerUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "OpportunityStageHistory"
    ADD CONSTRAINT "OpportunityStageHistory_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OpportunityStageHistory"
    ADD CONSTRAINT "OpportunityStageHistory_opportunityId_fkey"
    FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OpportunityStageHistory"
    ADD CONSTRAINT "OpportunityStageHistory_changedBy_fkey"
    FOREIGN KEY ("changedBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "OpportunityContactRole"
    ADD CONSTRAINT "OpportunityContactRole_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OpportunityContactRole"
    ADD CONSTRAINT "OpportunityContactRole_opportunityId_fkey"
    FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OpportunityContactRole"
    ADD CONSTRAINT "OpportunityContactRole_contactId_fkey"
    FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OpportunityContactRole"
    ADD CONSTRAINT "OpportunityContactRole_createdBy_fkey"
    FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Quote"
    ADD CONSTRAINT "Quote_opportunityId_fkey"
    FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Order"
    ADD CONSTRAINT "Order_opportunityId_fkey"
    FOREIGN KEY ("opportunityId") REFERENCES "Opportunity"("id") ON DELETE SET NULL ON UPDATE CASCADE;
