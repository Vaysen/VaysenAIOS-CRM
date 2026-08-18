-- CRM-06B Package C: keep mold fee nullable so legacy quotes remain readable.
-- This artifact is intentionally not applied in this task or to any production database.
ALTER TABLE "Quote" ADD COLUMN "moldFee" DECIMAL(10,2);
