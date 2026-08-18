-- Forward-compatible foundation for the quote migrations that follow.
-- Quote and QuoteLineItem were present in the Prisma schema but were absent
-- from the published migration chain before 20260711090000. Keep this
-- migration idempotent so an older database can be upgraded without data loss.

CREATE TABLE IF NOT EXISTS "Quote" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "referenceNo" TEXT NOT NULL,
  "type" TEXT NOT NULL DEFAULT 'quote',
  "status" TEXT NOT NULL DEFAULT 'draft',
  "leadId" TEXT,
  "conversationId" TEXT,
  "assignedUserId" TEXT,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "tradeTerms" TEXT,
  "paymentTerms" TEXT,
  "deliveryTime" TEXT,
  "sampleFee" DECIMAL(10,2),
  "discount" DECIMAL(10,2) NOT NULL DEFAULT 0,
  "taxRate" DECIMAL(5,2),
  "subtotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "taxAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "totalAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
  "notes" TEXT,
  "validUntil" TIMESTAMP(3),
  "sentAt" TIMESTAMP(3),
  "acceptedAt" TIMESTAMP(3),
  "aiExtracted" BOOLEAN NOT NULL DEFAULT false,
  "aiArtifactId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Quote_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "QuoteLineItem" (
  "id" TEXT NOT NULL,
  "quoteId" TEXT NOT NULL,
  "productCode" TEXT,
  "productName" TEXT NOT NULL,
  "material" TEXT,
  "size" TEXT,
  "thickness" TEXT,
  "color" TEXT,
  "printing" TEXT,
  "quantity" INTEGER NOT NULL,
  "unit" TEXT NOT NULL DEFAULT 'pcs',
  "unitPrice" DECIMAL(10,4) NOT NULL,
  "totalPrice" DECIMAL(12,2) NOT NULL,
  "productSpecId" TEXT,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "notes" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "QuoteLineItem_pkey" PRIMARY KEY ("id")
);

-- DeepResearchReport is extended by the 20260714150000 migration. Create its
-- pre-existing portion here, but deliberately leave agentRunId for that later
-- migration because AgentRun does not exist until 20260712120000.
CREATE TABLE IF NOT EXISTS "DeepResearchReport" (
  "id" TEXT NOT NULL,
  "leadId" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "type" TEXT NOT NULL DEFAULT 'full',
  "title" TEXT NOT NULL,
  "htmlContent" TEXT NOT NULL,
  "jsonData" JSONB,
  "createdBy" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DeepResearchReport_pkey" PRIMARY KEY ("id")
);

-- The WhatsApp session model and the conversation link are also referenced by
-- 20260714173000, while no published migration created them.
CREATE TABLE IF NOT EXISTS "WhatsAppSession" (
  "id" TEXT NOT NULL,
  "companyId" TEXT NOT NULL,
  "accountName" TEXT NOT NULL,
  "phoneNumber" TEXT,
  "sessionId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending_qr',
  "qrCode" TEXT,
  "qrCodeExpireAt" TIMESTAMP(3),
  "connectedAt" TIMESTAMP(3),
  "disconnectedAt" TIMESTAMP(3),
  "lastSeenAt" TIMESTAMP(3),
  "authStatePath" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WhatsAppSession_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "Conversation" ADD COLUMN IF NOT EXISTS "whatsappSessionId" TEXT;

-- Existing installations can contain only a subset of these tables' base
-- columns. Add every base column before any index or foreign key references it.
-- The backfill block below either applies a contract-approved default and then
-- restores Prisma's requiredness, or fails closed with a repair diagnostic.
ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "companyId" TEXT;
ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "referenceNo" TEXT;
ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "type" TEXT DEFAULT 'quote';
ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "status" TEXT DEFAULT 'draft';
ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "leadId" TEXT;
ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "conversationId" TEXT;
ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "assignedUserId" TEXT;
ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "currency" TEXT DEFAULT 'USD';
ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "tradeTerms" TEXT;
ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "paymentTerms" TEXT;
ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "deliveryTime" TEXT;
ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "sampleFee" DECIMAL(10,2);
ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "discount" DECIMAL(10,2) DEFAULT 0;
ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "taxRate" DECIMAL(5,2);
ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "subtotal" DECIMAL(12,2) DEFAULT 0;
ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "taxAmount" DECIMAL(12,2) DEFAULT 0;
ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "totalAmount" DECIMAL(12,2) DEFAULT 0;
ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "notes" TEXT;
ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "validUntil" TIMESTAMP(3);
ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "sentAt" TIMESTAMP(3);
ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "acceptedAt" TIMESTAMP(3);
ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "aiExtracted" BOOLEAN DEFAULT false;
ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "aiArtifactId" TEXT;
ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "Quote" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3);

ALTER TABLE "QuoteLineItem" ADD COLUMN IF NOT EXISTS "quoteId" TEXT;
ALTER TABLE "QuoteLineItem" ADD COLUMN IF NOT EXISTS "productCode" TEXT;
ALTER TABLE "QuoteLineItem" ADD COLUMN IF NOT EXISTS "productName" TEXT;
ALTER TABLE "QuoteLineItem" ADD COLUMN IF NOT EXISTS "material" TEXT;
ALTER TABLE "QuoteLineItem" ADD COLUMN IF NOT EXISTS "size" TEXT;
ALTER TABLE "QuoteLineItem" ADD COLUMN IF NOT EXISTS "thickness" TEXT;
ALTER TABLE "QuoteLineItem" ADD COLUMN IF NOT EXISTS "color" TEXT;
ALTER TABLE "QuoteLineItem" ADD COLUMN IF NOT EXISTS "printing" TEXT;
ALTER TABLE "QuoteLineItem" ADD COLUMN IF NOT EXISTS "quantity" INTEGER;
ALTER TABLE "QuoteLineItem" ADD COLUMN IF NOT EXISTS "unit" TEXT DEFAULT 'pcs';
ALTER TABLE "QuoteLineItem" ADD COLUMN IF NOT EXISTS "unitPrice" DECIMAL(10,4);
ALTER TABLE "QuoteLineItem" ADD COLUMN IF NOT EXISTS "totalPrice" DECIMAL(12,2);
ALTER TABLE "QuoteLineItem" ADD COLUMN IF NOT EXISTS "productSpecId" TEXT;
ALTER TABLE "QuoteLineItem" ADD COLUMN IF NOT EXISTS "sortOrder" INTEGER DEFAULT 0;
ALTER TABLE "QuoteLineItem" ADD COLUMN IF NOT EXISTS "notes" TEXT;
ALTER TABLE "QuoteLineItem" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "QuoteLineItem" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3);

ALTER TABLE "DeepResearchReport" ADD COLUMN IF NOT EXISTS "leadId" TEXT;
ALTER TABLE "DeepResearchReport" ADD COLUMN IF NOT EXISTS "companyId" TEXT;
ALTER TABLE "DeepResearchReport" ADD COLUMN IF NOT EXISTS "type" TEXT DEFAULT 'full';
ALTER TABLE "DeepResearchReport" ADD COLUMN IF NOT EXISTS "title" TEXT;
ALTER TABLE "DeepResearchReport" ADD COLUMN IF NOT EXISTS "htmlContent" TEXT;
ALTER TABLE "DeepResearchReport" ADD COLUMN IF NOT EXISTS "jsonData" JSONB;
ALTER TABLE "DeepResearchReport" ADD COLUMN IF NOT EXISTS "createdBy" TEXT;
ALTER TABLE "DeepResearchReport" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "WhatsAppSession" ADD COLUMN IF NOT EXISTS "companyId" TEXT;
ALTER TABLE "WhatsAppSession" ADD COLUMN IF NOT EXISTS "accountName" TEXT;
ALTER TABLE "WhatsAppSession" ADD COLUMN IF NOT EXISTS "phoneNumber" TEXT;
ALTER TABLE "WhatsAppSession" ADD COLUMN IF NOT EXISTS "sessionId" TEXT;
ALTER TABLE "WhatsAppSession" ADD COLUMN IF NOT EXISTS "status" TEXT DEFAULT 'pending_qr';
ALTER TABLE "WhatsAppSession" ADD COLUMN IF NOT EXISTS "qrCode" TEXT;
ALTER TABLE "WhatsAppSession" ADD COLUMN IF NOT EXISTS "qrCodeExpireAt" TIMESTAMP(3);
ALTER TABLE "WhatsAppSession" ADD COLUMN IF NOT EXISTS "connectedAt" TIMESTAMP(3);
ALTER TABLE "WhatsAppSession" ADD COLUMN IF NOT EXISTS "disconnectedAt" TIMESTAMP(3);
ALTER TABLE "WhatsAppSession" ADD COLUMN IF NOT EXISTS "lastSeenAt" TIMESTAMP(3);
ALTER TABLE "WhatsAppSession" ADD COLUMN IF NOT EXISTS "authStatePath" TEXT;
ALTER TABLE "WhatsAppSession" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "WhatsAppSession" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3);

-- Safe backfills for required Prisma columns. Business identity, relation and
-- money fields are not invented: existing rows with those fields missing fail
-- closed and identify the exact repair needed before retrying deploy.
DO $$
BEGIN
  UPDATE "Quote" SET "type" = 'quote' WHERE "type" IS NULL;
  UPDATE "Quote" SET "status" = 'draft' WHERE "status" IS NULL;
  UPDATE "Quote" SET "currency" = 'USD' WHERE "currency" IS NULL;
  UPDATE "Quote" SET "discount" = 0 WHERE "discount" IS NULL;
  UPDATE "Quote" SET "subtotal" = 0 WHERE "subtotal" IS NULL;
  UPDATE "Quote" SET "taxAmount" = 0 WHERE "taxAmount" IS NULL;
  UPDATE "Quote" SET "totalAmount" = 0 WHERE "totalAmount" IS NULL;
  UPDATE "Quote" SET "aiExtracted" = false WHERE "aiExtracted" IS NULL;
  UPDATE "Quote" SET "createdAt" = CURRENT_TIMESTAMP WHERE "createdAt" IS NULL;
  UPDATE "Quote" SET "updatedAt" = CURRENT_TIMESTAMP WHERE "updatedAt" IS NULL;

  IF EXISTS (SELECT 1 FROM "Quote" WHERE "id" IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '23502', MESSAGE = 'Quote.id contains NULL values',
      DETAIL = 'Repair the primary identifier values without deleting rows, then rerun prisma migrate deploy.';
  END IF;
  IF EXISTS (SELECT 1 FROM "Quote" WHERE "companyId" IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '23502', MESSAGE = 'Quote.companyId is missing for existing rows',
      DETAIL = 'Assign each quote to its verified Company.id; the migration will not guess tenant ownership.';
  END IF;
  IF EXISTS (SELECT 1 FROM "Quote" WHERE "referenceNo" IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '23502', MESSAGE = 'Quote.referenceNo is missing for existing rows',
      DETAIL = 'Assign stable business reference numbers and verify uniqueness; the migration will not invent them.';
  END IF;
  ALTER TABLE "Quote" ALTER COLUMN "id" SET NOT NULL;
  ALTER TABLE "Quote" ALTER COLUMN "companyId" SET NOT NULL;
  ALTER TABLE "Quote" ALTER COLUMN "referenceNo" SET NOT NULL;
  ALTER TABLE "Quote" ALTER COLUMN "type" SET DEFAULT 'quote', ALTER COLUMN "type" SET NOT NULL;
  ALTER TABLE "Quote" ALTER COLUMN "status" SET DEFAULT 'draft', ALTER COLUMN "status" SET NOT NULL;
  ALTER TABLE "Quote" ALTER COLUMN "currency" SET DEFAULT 'USD', ALTER COLUMN "currency" SET NOT NULL;
  ALTER TABLE "Quote" ALTER COLUMN "discount" SET DEFAULT 0, ALTER COLUMN "discount" SET NOT NULL;
  ALTER TABLE "Quote" ALTER COLUMN "subtotal" SET DEFAULT 0, ALTER COLUMN "subtotal" SET NOT NULL;
  ALTER TABLE "Quote" ALTER COLUMN "taxAmount" SET DEFAULT 0, ALTER COLUMN "taxAmount" SET NOT NULL;
  ALTER TABLE "Quote" ALTER COLUMN "totalAmount" SET DEFAULT 0, ALTER COLUMN "totalAmount" SET NOT NULL;
  ALTER TABLE "Quote" ALTER COLUMN "aiExtracted" SET DEFAULT false, ALTER COLUMN "aiExtracted" SET NOT NULL;
  ALTER TABLE "Quote" ALTER COLUMN "createdAt" SET DEFAULT CURRENT_TIMESTAMP, ALTER COLUMN "createdAt" SET NOT NULL;
  ALTER TABLE "Quote" ALTER COLUMN "updatedAt" SET NOT NULL;

  UPDATE "QuoteLineItem" SET "unit" = 'pcs' WHERE "unit" IS NULL;
  UPDATE "QuoteLineItem" SET "sortOrder" = 0 WHERE "sortOrder" IS NULL;
  UPDATE "QuoteLineItem" SET "createdAt" = CURRENT_TIMESTAMP WHERE "createdAt" IS NULL;
  UPDATE "QuoteLineItem" SET "updatedAt" = CURRENT_TIMESTAMP WHERE "updatedAt" IS NULL;
  IF EXISTS (SELECT 1 FROM "QuoteLineItem" WHERE "id" IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '23502', MESSAGE = 'QuoteLineItem.id contains NULL values',
      DETAIL = 'Repair the primary identifier values without deleting rows, then rerun prisma migrate deploy.';
  END IF;
  IF EXISTS (SELECT 1 FROM "QuoteLineItem" WHERE "quoteId" IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '23502', MESSAGE = 'QuoteLineItem.quoteId is missing for existing rows',
      DETAIL = 'Assign each line item to its verified Quote.id; the migration will not guess relationships.';
  END IF;
  IF EXISTS (SELECT 1 FROM "QuoteLineItem" WHERE "productName" IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '23502', MESSAGE = 'QuoteLineItem.productName is missing for existing rows',
      DETAIL = 'Restore the product name from an authoritative record; the migration will not invent product data.';
  END IF;
  IF EXISTS (SELECT 1 FROM "QuoteLineItem" WHERE "quantity" IS NULL OR "unitPrice" IS NULL OR "totalPrice" IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '23502', MESSAGE = 'QuoteLineItem quantity or price is missing for existing rows',
      DETAIL = 'Restore quantity, unitPrice, and totalPrice from an authoritative quote source before retrying.';
  END IF;
  ALTER TABLE "QuoteLineItem" ALTER COLUMN "id" SET NOT NULL;
  ALTER TABLE "QuoteLineItem" ALTER COLUMN "quoteId" SET NOT NULL;
  ALTER TABLE "QuoteLineItem" ALTER COLUMN "productName" SET NOT NULL;
  ALTER TABLE "QuoteLineItem" ALTER COLUMN "quantity" SET NOT NULL;
  ALTER TABLE "QuoteLineItem" ALTER COLUMN "unit" SET DEFAULT 'pcs', ALTER COLUMN "unit" SET NOT NULL;
  ALTER TABLE "QuoteLineItem" ALTER COLUMN "unitPrice" SET NOT NULL;
  ALTER TABLE "QuoteLineItem" ALTER COLUMN "totalPrice" SET NOT NULL;
  ALTER TABLE "QuoteLineItem" ALTER COLUMN "sortOrder" SET DEFAULT 0, ALTER COLUMN "sortOrder" SET NOT NULL;
  ALTER TABLE "QuoteLineItem" ALTER COLUMN "createdAt" SET DEFAULT CURRENT_TIMESTAMP, ALTER COLUMN "createdAt" SET NOT NULL;
  ALTER TABLE "QuoteLineItem" ALTER COLUMN "updatedAt" SET NOT NULL;

  UPDATE "DeepResearchReport" SET "type" = 'full' WHERE "type" IS NULL;
  UPDATE "DeepResearchReport" SET "createdAt" = CURRENT_TIMESTAMP WHERE "createdAt" IS NULL;
  IF EXISTS (SELECT 1 FROM "DeepResearchReport" WHERE "id" IS NULL OR "leadId" IS NULL OR "companyId" IS NULL OR "title" IS NULL OR "htmlContent" IS NULL OR "createdBy" IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '23502', MESSAGE = 'DeepResearchReport has missing required legacy values',
      DETAIL = 'Restore id, leadId, companyId, title, htmlContent, and createdBy from an authoritative report backup.';
  END IF;
  ALTER TABLE "DeepResearchReport" ALTER COLUMN "id" SET NOT NULL;
  ALTER TABLE "DeepResearchReport" ALTER COLUMN "leadId" SET NOT NULL;
  ALTER TABLE "DeepResearchReport" ALTER COLUMN "companyId" SET NOT NULL;
  ALTER TABLE "DeepResearchReport" ALTER COLUMN "type" SET DEFAULT 'full', ALTER COLUMN "type" SET NOT NULL;
  ALTER TABLE "DeepResearchReport" ALTER COLUMN "title" SET NOT NULL;
  ALTER TABLE "DeepResearchReport" ALTER COLUMN "htmlContent" SET NOT NULL;
  ALTER TABLE "DeepResearchReport" ALTER COLUMN "createdBy" SET NOT NULL;
  ALTER TABLE "DeepResearchReport" ALTER COLUMN "createdAt" SET DEFAULT CURRENT_TIMESTAMP, ALTER COLUMN "createdAt" SET NOT NULL;

  UPDATE "WhatsAppSession" SET "status" = 'pending_qr' WHERE "status" IS NULL;
  UPDATE "WhatsAppSession" SET "createdAt" = CURRENT_TIMESTAMP WHERE "createdAt" IS NULL;
  -- Prisma's @updatedAt field has no database default. For legacy rows whose
  -- column was absent, preserve the creation time when available and use one
  -- migration-clock value only when it is not; existing timestamps stay intact.
  UPDATE "WhatsAppSession"
  SET "updatedAt" = COALESCE("createdAt", CURRENT_TIMESTAMP)
  WHERE "updatedAt" IS NULL;
  IF EXISTS (SELECT 1 FROM "WhatsAppSession" WHERE "id" IS NULL OR "companyId" IS NULL OR "accountName" IS NULL OR "sessionId" IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '23502', MESSAGE = 'WhatsAppSession has missing required legacy values',
      DETAIL = 'Restore id, companyId, accountName, and sessionId from the authoritative WhatsApp account record.';
  END IF;
  ALTER TABLE "WhatsAppSession" ALTER COLUMN "id" SET NOT NULL;
  ALTER TABLE "WhatsAppSession" ALTER COLUMN "companyId" SET NOT NULL;
  ALTER TABLE "WhatsAppSession" ALTER COLUMN "accountName" SET NOT NULL;
  ALTER TABLE "WhatsAppSession" ALTER COLUMN "sessionId" SET NOT NULL;
  ALTER TABLE "WhatsAppSession" ALTER COLUMN "status" SET DEFAULT 'pending_qr', ALTER COLUMN "status" SET NOT NULL;
  ALTER TABLE "WhatsAppSession" ALTER COLUMN "createdAt" SET DEFAULT CURRENT_TIMESTAMP, ALTER COLUMN "createdAt" SET NOT NULL;
  ALTER TABLE "WhatsAppSession" ALTER COLUMN "updatedAt" SET NOT NULL;
END $$;

-- Exact catalog-level FK enforcement. A same-named constraint on another
-- relation is not treated as a match; a wrong same-named constraint on the
-- target relation is replaced only after its actual definition is inspected.
CREATE OR REPLACE FUNCTION pg_temp.lan_ensure_fk(
  p_table regclass, p_name text, p_columns text[], p_ref_table regclass,
  p_ref_columns text[], p_delete_action "char", p_update_action "char"
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  expected_columns smallint[];
  expected_ref_columns smallint[];
  current_constraint record;
  schema_name text;
BEGIN
  SELECT n.nspname INTO schema_name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.oid = p_table;
  SELECT array_agg(a.attnum::smallint ORDER BY u.ord) INTO expected_columns
  FROM unnest(p_columns) WITH ORDINALITY u(column_name, ord)
  JOIN pg_attribute a ON a.attrelid = p_table AND a.attname = u.column_name AND a.attnum > 0;
  SELECT array_agg(a.attnum::smallint ORDER BY u.ord) INTO expected_ref_columns
  FROM unnest(p_ref_columns) WITH ORDINALITY u(column_name, ord)
  JOIN pg_attribute a ON a.attrelid = p_ref_table AND a.attname = u.column_name AND a.attnum > 0;
  IF expected_columns IS NULL OR expected_ref_columns IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '42703', MESSAGE = format('Cannot validate FK %I: column catalog lookup failed', p_name),
      DETAIL = 'Verify the target and referenced columns before retrying the migration.';
  END IF;
  SELECT con.oid, con.conrelid, con.conkey, con.confrelid, con.confkey, con.confdeltype, con.confupdtype
    INTO current_constraint
  FROM pg_constraint con
  WHERE con.conrelid = p_table AND con.conname = p_name AND con.contype = 'f';
  IF current_constraint.oid IS NOT NULL
     AND current_constraint.conkey = expected_columns
     AND current_constraint.confrelid = p_ref_table
     AND current_constraint.confkey = expected_ref_columns
     AND current_constraint.confdeltype = p_delete_action
     AND current_constraint.confupdtype = p_update_action THEN
    RETURN;
  END IF;
  IF current_constraint.oid IS NOT NULL THEN
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', p_table, p_name);
  END IF;
  EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY (%s) REFERENCES %s (%s) ON DELETE %s ON UPDATE %s',
    p_table, p_name, (SELECT string_agg(format('%I', x), ', ') FROM unnest(p_columns) x),
    p_ref_table, (SELECT string_agg(format('%I', x), ', ') FROM unnest(p_ref_columns) x),
    CASE p_delete_action WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'r' THEN 'RESTRICT' ELSE 'NO ACTION' END,
    CASE p_update_action WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'r' THEN 'RESTRICT' ELSE 'NO ACTION' END);
END $$;

SELECT pg_temp.lan_ensure_fk('public."Quote"'::regclass, 'Quote_companyId_fkey', ARRAY['companyId'], 'public."Company"'::regclass, ARRAY['id'], 'c', 'c');
SELECT pg_temp.lan_ensure_fk('public."Quote"'::regclass, 'Quote_leadId_fkey', ARRAY['leadId'], 'public."Lead"'::regclass, ARRAY['id'], 'n', 'c');
SELECT pg_temp.lan_ensure_fk('public."QuoteLineItem"'::regclass, 'QuoteLineItem_quoteId_fkey', ARRAY['quoteId'], 'public."Quote"'::regclass, ARRAY['id'], 'c', 'c');
SELECT pg_temp.lan_ensure_fk('public."DeepResearchReport"'::regclass, 'DeepResearchReport_leadId_fkey', ARRAY['leadId'], 'public."Lead"'::regclass, ARRAY['id'], 'c', 'c');
SELECT pg_temp.lan_ensure_fk('public."WhatsAppSession"'::regclass, 'WhatsAppSession_companyId_fkey', ARRAY['companyId'], 'public."Company"'::regclass, ARRAY['id'], 'c', 'c');

-- Exact catalog-level index enforcement. Same-named indexes on another table
-- fail closed; same-named wrong indexes on the target table are rebuilt.
CREATE OR REPLACE FUNCTION pg_temp.lan_ensure_index(
  p_table regclass, p_name text, p_unique boolean, p_columns text[], p_desc boolean[] DEFAULT '{}'
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  expected_columns smallint[];
  expected_options smallint[];
  current_index record;
  relation_schema oid;
  column_sql text;
BEGIN
  SELECT c.relnamespace INTO relation_schema FROM pg_class c WHERE c.oid = p_table;
  SELECT array_agg(a.attnum::smallint ORDER BY u.ord) INTO expected_columns
  FROM unnest(p_columns) WITH ORDINALITY u(column_name, ord)
  JOIN pg_attribute a ON a.attrelid = p_table AND a.attname = u.column_name AND a.attnum > 0;
  SELECT array_agg(CASE WHEN COALESCE(p_desc[u.ord], false) THEN 1 ELSE 0 END::smallint ORDER BY u.ord)
    INTO expected_options FROM unnest(p_columns) WITH ORDINALITY u(column_name, ord);
  IF expected_columns IS NULL OR cardinality(expected_columns) <> cardinality(p_columns) THEN
    RAISE EXCEPTION USING ERRCODE = '42703', MESSAGE = format('Cannot validate index %I: column catalog lookup failed', p_name),
      DETAIL = 'Verify the target columns before retrying the migration.';
  END IF;
  SELECT c.oid, i.indrelid, i.indisunique, i.indpred, i.indexprs, i.indnkeyatts, i.indnatts,
         i.indkey::smallint[] AS indkey, i.indoption::smallint[] AS indoption, c.relkind
    INTO current_index
  FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
  WHERE c.relnamespace = relation_schema AND c.relname = p_name;
  IF current_index.oid IS NOT NULL AND current_index.indrelid <> p_table THEN
    RAISE EXCEPTION USING ERRCODE = '42710', MESSAGE = format('Index name %I is owned by another table', p_name),
      DETAIL = 'Rename the unrelated index outside this migration; no unknown object is dropped automatically.';
  END IF;
  IF current_index.oid IS NOT NULL
     AND current_index.indisunique = p_unique
     AND current_index.indpred IS NULL AND current_index.indexprs IS NULL
     AND current_index.indnkeyatts = cardinality(expected_columns)
     AND current_index.indnatts = cardinality(expected_columns)
     AND current_index.indkey = expected_columns
     AND current_index.indoption = expected_options
     AND current_index.relkind = 'i' THEN
    RETURN;
  END IF;
  IF current_index.oid IS NOT NULL THEN
    EXECUTE format('DROP INDEX %I.%I', (SELECT n.nspname FROM pg_namespace n WHERE n.oid = relation_schema), p_name);
  END IF;
  SELECT string_agg(format('%I%s', p_columns[u.ord], CASE WHEN COALESCE(p_desc[u.ord], false) THEN ' DESC' ELSE '' END), ', ' ORDER BY u.ord)
    INTO column_sql FROM generate_subscripts(p_columns, 1) u(ord);
  EXECUTE format('CREATE %s INDEX %I ON %s (%s)', CASE WHEN p_unique THEN 'UNIQUE' ELSE '' END, p_name, p_table, column_sql);
END $$;

SELECT pg_temp.lan_ensure_index('public."Quote"'::regclass, 'Quote_referenceNo_key', true, ARRAY['referenceNo']);
SELECT pg_temp.lan_ensure_index('public."Quote"'::regclass, 'Quote_referenceNo_idx', false, ARRAY['referenceNo']);
SELECT pg_temp.lan_ensure_index('public."Quote"'::regclass, 'Quote_companyId_idx', false, ARRAY['companyId']);
SELECT pg_temp.lan_ensure_index('public."Quote"'::regclass, 'Quote_leadId_idx', false, ARRAY['leadId']);
SELECT pg_temp.lan_ensure_index('public."Quote"'::regclass, 'Quote_status_idx', false, ARRAY['status']);
SELECT pg_temp.lan_ensure_index('public."Quote"'::regclass, 'Quote_type_idx', false, ARRAY['type']);
SELECT pg_temp.lan_ensure_index('public."QuoteLineItem"'::regclass, 'QuoteLineItem_quoteId_idx', false, ARRAY['quoteId']);
SELECT pg_temp.lan_ensure_index('public."QuoteLineItem"'::regclass, 'QuoteLineItem_productCode_idx', false, ARRAY['productCode']);
SELECT pg_temp.lan_ensure_index('public."DeepResearchReport"'::regclass, 'DeepResearchReport_leadId_createdAt_idx', false, ARRAY['leadId','createdAt'], ARRAY[false,true]);
SELECT pg_temp.lan_ensure_index('public."DeepResearchReport"'::regclass, 'DeepResearchReport_companyId_idx', false, ARRAY['companyId']);
SELECT pg_temp.lan_ensure_index('public."WhatsAppSession"'::regclass, 'WhatsAppSession_sessionId_key', true, ARRAY['sessionId']);
SELECT pg_temp.lan_ensure_index('public."WhatsAppSession"'::regclass, 'WhatsAppSession_companyId_idx', false, ARRAY['companyId']);
SELECT pg_temp.lan_ensure_index('public."WhatsAppSession"'::regclass, 'WhatsAppSession_status_idx', false, ARRAY['status']);
SELECT pg_temp.lan_ensure_index('public."WhatsAppSession"'::regclass, 'WhatsAppSession_sessionId_idx', false, ARRAY['sessionId']);
SELECT pg_temp.lan_ensure_index('public."Conversation"'::regclass, 'Conversation_whatsappSessionId_idx', false, ARRAY['whatsappSessionId']);
