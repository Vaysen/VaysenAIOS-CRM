ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "pinterestUrl" TEXT;
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "redditUrl" TEXT;
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "youtubeUrl" TEXT;
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "tiktokUrl" TEXT;
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "otherSocialLinks" JSONB;
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "emailVerificationStatus" TEXT NOT NULL DEFAULT 'unverified';
ALTER TABLE "Lead" ADD COLUMN IF NOT EXISTS "emailVerificationReason" TEXT;

ALTER TABLE "EmailMessage" ADD COLUMN IF NOT EXISTS "outreachRound" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "Lead_companyId_emailVerificationStatus_idx" ON "Lead"("companyId", "emailVerificationStatus");
CREATE INDEX IF NOT EXISTS "EmailMessage_leadId_outreachRound_idx" ON "EmailMessage"("leadId", "outreachRound");
