ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "reviewStatus" TEXT NOT NULL DEFAULT 'pending';
CREATE INDEX IF NOT EXISTS "Lead_companyId_reviewStatus_idx" ON "Lead"("companyId", "reviewStatus");
