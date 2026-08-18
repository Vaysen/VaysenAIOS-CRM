-- This migration is intentionally definition-level: IF NOT EXISTS alone would
-- silently preserve a nullable or wrongly typed legacy column.
ALTER TABLE "Lead"
  ADD COLUMN IF NOT EXISTS "language" TEXT,
  ADD COLUMN IF NOT EXISTS "reviewStatus" TEXT;

DO $$
DECLARE
  language_type TEXT;
  review_type TEXT;
BEGIN
  SELECT data_type INTO language_type
  FROM information_schema.columns
  WHERE table_schema = current_schema() AND table_name = 'Lead' AND column_name = 'language';
  SELECT data_type INTO review_type
  FROM information_schema.columns
  WHERE table_schema = current_schema() AND table_name = 'Lead' AND column_name = 'reviewStatus';
  IF language_type IS DISTINCT FROM 'text' THEN
    RAISE EXCEPTION 'Lead.language must be text, found %', COALESCE(language_type, '<missing>');
  END IF;
  IF review_type IS DISTINCT FROM 'text' THEN
    RAISE EXCEPTION 'Lead.reviewStatus must be text, found %', COALESCE(review_type, '<missing>');
  END IF;
END $$;

UPDATE "Lead" SET "reviewStatus" = 'pending' WHERE "reviewStatus" IS NULL;
ALTER TABLE "Lead" ALTER COLUMN "reviewStatus" SET DEFAULT 'pending';
ALTER TABLE "Lead" ALTER COLUMN "reviewStatus" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "Lead_companyId_reviewStatus_idx"
  ON "Lead"("companyId", "reviewStatus");
