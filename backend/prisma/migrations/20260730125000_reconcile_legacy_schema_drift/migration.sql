-- Reconcile the c03 schema objects that were present in schema.prisma but
-- absent from the historical migration chain.
--
-- This is an integration-chain repair.  It does not rewrite any published
-- migration.  Existing partial objects are validated and rejected when their
-- definition is unsafe.  Existing non-empty legacy Lead.tags data is also
-- rejected: there is no approved, lossless mapping to LeadTag.createdBy.
-- PostgreSQL runs this migration transactionally through Prisma.

DO $migration$
DECLARE
  actual_values text[];
  actual_type text;
  actual_not_null boolean;
  actual_default text;
  actual_generated "char";
  actual_identity "char";
BEGIN
  IF to_regtype('public."AttrType"') IS NULL THEN
    CREATE TYPE "AttrType" AS ENUM ('TEXT', 'NUMBER', 'SELECT', 'MULTI_SELECT', 'BOOLEAN');
  ELSE
    SELECT array_agg(e.enumlabel ORDER BY e.enumsortorder)
      INTO actual_values
    FROM pg_enum e
    WHERE e.enumtypid = to_regtype('public."AttrType"');
    IF actual_values IS DISTINCT FROM ARRAY['TEXT', 'NUMBER', 'SELECT', 'MULTI_SELECT', 'BOOLEAN']::text[] THEN
      RAISE EXCEPTION 'legacy-schema reconciliation refused: AttrType enum definition mismatch';
    END IF;
  END IF;

  IF to_regclass('public."Lead"') IS NULL THEN
    RAISE EXCEPTION 'legacy-schema reconciliation refused: required Lead table is missing';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'Lead' AND column_name = 'tags'
  ) THEN
    SELECT format_type(a.atttypid, a.atttypmod),
           a.attnotnull,
           a.attgenerated,
           a.attidentity,
           pg_get_expr(d.adbin, d.adrelid)
      INTO actual_type, actual_not_null, actual_generated, actual_identity, actual_default
    FROM pg_attribute a
    LEFT JOIN pg_attrdef d
      ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = to_regclass('public."Lead"')
      AND a.attname = 'tags'
      AND a.attnum > 0
      AND NOT a.attisdropped;
    IF lower(actual_type) <> 'text[]'
       OR actual_not_null
       OR actual_generated IS DISTINCT FROM ''
       OR actual_identity IS DISTINCT FROM ''
       OR actual_default IS NOT NULL THEN
      RAISE EXCEPTION 'legacy-schema reconciliation refused: Lead.tags has type %, expected text[]', actual_type;
    END IF;
    IF EXISTS (
      SELECT 1
      FROM "Lead"
      WHERE "tags" IS NOT NULL AND cardinality("tags") > 0
    ) THEN
      RAISE EXCEPTION 'legacy-schema reconciliation refused: non-empty Lead.tags cannot be losslessly mapped to LeadTag';
    END IF;
    ALTER TABLE "Lead" DROP COLUMN "tags";
  END IF;

  IF to_regclass('public."SearchTask"') IS NULL THEN
    RAISE EXCEPTION 'legacy-schema reconciliation refused: required SearchTask table is missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'SearchTask' AND column_name = 'errorMessage'
  ) THEN
    ALTER TABLE "SearchTask" ADD COLUMN "errorMessage" TEXT;
  ELSE
    SELECT format_type(a.atttypid, a.atttypmod),
           a.attnotnull,
           a.attgenerated,
           a.attidentity,
           pg_get_expr(d.adbin, d.adrelid)
      INTO actual_type, actual_not_null, actual_generated, actual_identity, actual_default
    FROM pg_attribute a
    LEFT JOIN pg_attrdef d
      ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = to_regclass('public."SearchTask"')
      AND a.attname = 'errorMessage'
      AND a.attnum > 0
      AND NOT a.attisdropped;
    IF lower(actual_type) <> 'text'
       OR actual_not_null
       OR actual_generated IS DISTINCT FROM ''
       OR actual_identity IS DISTINCT FROM ''
       OR actual_default IS NOT NULL THEN
      RAISE EXCEPTION 'legacy-schema reconciliation refused: SearchTask.errorMessage definition mismatch';
    END IF;
  END IF;
END
$migration$;

CREATE TABLE IF NOT EXISTS "Material" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'image',
    "compressed" BOOLEAN NOT NULL DEFAULT false,
    "uploadedBy" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Material_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ProductCategory" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "parentId" TEXT,
    "description" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProductCategory_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "AttributeTemplate" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "AttrType" NOT NULL DEFAULT 'TEXT',
    "options" JSONB,
    "unit" TEXT,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AttributeTemplate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Product" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "categoryId" TEXT,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "productCode" TEXT,
    "material" TEXT,
    "thickness" TEXT,
    "productType" TEXT,
    "description" TEXT,
    "basePrice" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'CNY',
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "images" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "WhatsAppBroadcastTask" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "taskName" TEXT NOT NULL,
    "accountId" TEXT NOT NULL DEFAULT 'default',
    "template" TEXT NOT NULL,
    "recipients" TEXT NOT NULL,
    "recipientCount" INTEGER NOT NULL DEFAULT 0,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "scheduledAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "WhatsAppBroadcastTask_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "ProductSpec" (
    "id" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "specCode" TEXT,
    "size" TEXT NOT NULL,
    "widthCm" DOUBLE PRECISION,
    "lengthCm" DOUBLE PRECISION,
    "gussetCm" DOUBLE PRECISION,
    "thicknessCm" TEXT,
    "unitPrice" DECIMAL(10,4) NOT NULL,
    "moq" INTEGER NOT NULL DEFAULT 1,
    "packPerBundle" INTEGER,
    "bundleWeightKg" DOUBLE PRECISION,
    "cartonSize" TEXT,
    "cartonLengthCm" DOUBLE PRECISION,
    "cartonWidthCm" DOUBLE PRECISION,
    "cartonHeightCm" DOUBLE PRECISION,
    "weightPerItem" DOUBLE PRECISION,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProductSpec_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "Order" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "orderNo" TEXT NOT NULL,
    "leadId" TEXT,
    "quoteId" TEXT,
    "assignedUserId" TEXT,
    "stage" TEXT NOT NULL DEFAULT 'won',
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "totalAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "paidAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "deliveryDate" TIMESTAMP(3),
    "shippingTerms" TEXT,
    "trackingNo" TEXT,
    "notes" TEXT,
    "stageHistory" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CustomizerTemplate" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "productId" TEXT,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "modelUrl" TEXT NOT NULL,
    "modelFormat" TEXT NOT NULL DEFAULT 'glb',
    "textureSize" INTEGER NOT NULL DEFAULT 2048,
    "unfoldLayout" JSONB NOT NULL,
    "basePrice" DECIMAL(10,4) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "moq" INTEGER NOT NULL DEFAULT 10000,
    "leadTimeDays" INTEGER NOT NULL DEFAULT 20,
    "isPublished" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CustomizerTemplate_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CustomizerRegion" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "regionId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "uvX" INTEGER NOT NULL,
    "uvY" INTEGER NOT NULL,
    "uvW" INTEGER NOT NULL,
    "uvH" INTEGER NOT NULL,
    "unfoldX" DOUBLE PRECISION NOT NULL,
    "unfoldY" DOUBLE PRECISION NOT NULL,
    "unfoldW" DOUBLE PRECISION NOT NULL,
    "unfoldH" DOUBLE PRECISION NOT NULL,
    "isEditable" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "CustomizerRegion_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CustomizerMaterial" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "colorHex" TEXT NOT NULL DEFAULT '#ffffff',
    "textureUrl" TEXT,
    "priceModifier" DECIMAL(10,4) NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "CustomizerMaterial_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CustomizerLogoEffect" (
    "id" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "previewUrl" TEXT,
    "pricePerColor" DECIMAL(10,4) NOT NULL DEFAULT 0,
    "minColors" INTEGER NOT NULL DEFAULT 1,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "CustomizerLogoEffect_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CustomizerDesign" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "templateId" TEXT NOT NULL,
    "leadId" TEXT,
    "shareCode" TEXT NOT NULL,
    "customerName" TEXT,
    "customerEmail" TEXT,
    "customerPhone" TEXT,
    "config" JSONB NOT NULL,
    "thumbnailUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "submittedAt" TIMESTAMP(3),
    CONSTRAINT "CustomizerDesign_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "CustomizerInquiry" (
    "id" TEXT NOT NULL,
    "designId" TEXT NOT NULL,
    "quoteId" TEXT,
    "quantity" INTEGER NOT NULL,
    "unitPrice" DECIMAL(10,4),
    "totalPrice" DECIMAL(12,2),
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" TEXT NOT NULL DEFAULT 'new',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CustomizerInquiry_pkey" PRIMARY KEY ("id")
);

CREATE TEMP TABLE _lan_expected_columns (
  table_name text NOT NULL,
  column_name text NOT NULL,
  type_name text NOT NULL,
  not_null boolean NOT NULL
) ON COMMIT DROP;

INSERT INTO _lan_expected_columns (table_name, column_name, type_name, not_null) VALUES
  ('Material','id','text',true),
  ('Material','companyId','text',true),
  ('Material','name','text',true),
  ('Material','filename','text',true),
  ('Material','originalName','text',true),
  ('Material','mimeType','text',true),
  ('Material','size','integer',true),
  ('Material','type','text',true),
  ('Material','compressed','boolean',true),
  ('Material','uploadedBy','text',true),
  ('Material','deletedAt','timestamp(3) without time zone',false),
  ('Material','createdAt','timestamp(3) without time zone',true),
  ('ProductCategory','id','text',true),
  ('ProductCategory','companyId','text',true),
  ('ProductCategory','name','text',true),
  ('ProductCategory','code','text',false),
  ('ProductCategory','parentId','text',false),
  ('ProductCategory','description','text',false),
  ('ProductCategory','sortOrder','integer',true),
  ('ProductCategory','isActive','boolean',true),
  ('ProductCategory','createdAt','timestamp(3) without time zone',true),
  ('ProductCategory','updatedAt','timestamp(3) without time zone',true),
  ('AttributeTemplate','id','text',true),
  ('AttributeTemplate','categoryId','text',true),
  ('AttributeTemplate','name','text',true),
  ('AttributeTemplate','type','attrtype',true),
  ('AttributeTemplate','options','jsonb',false),
  ('AttributeTemplate','unit','text',false),
  ('AttributeTemplate','required','boolean',true),
  ('AttributeTemplate','sortOrder','integer',true),
  ('AttributeTemplate','createdAt','timestamp(3) without time zone',true),
  ('AttributeTemplate','updatedAt','timestamp(3) without time zone',true),
  ('Product','id','text',true),
  ('Product','companyId','text',true),
  ('Product','categoryId','text',false),
  ('Product','sku','text',true),
  ('Product','name','text',true),
  ('Product','productCode','text',false),
  ('Product','material','text',false),
  ('Product','thickness','text',false),
  ('Product','productType','text',false),
  ('Product','description','text',false),
  ('Product','basePrice','numeric(65,30)',true),
  ('Product','currency','text',true),
  ('Product','attributes','jsonb',true),
  ('Product','images','text[]',false),
  ('Product','isActive','boolean',true),
  ('Product','createdAt','timestamp(3) without time zone',true),
  ('Product','updatedAt','timestamp(3) without time zone',true),
  ('WhatsAppBroadcastTask','id','text',true),
  ('WhatsAppBroadcastTask','companyId','text',true),
  ('WhatsAppBroadcastTask','taskName','text',true),
  ('WhatsAppBroadcastTask','accountId','text',true),
  ('WhatsAppBroadcastTask','template','text',true),
  ('WhatsAppBroadcastTask','recipients','text',true),
  ('WhatsAppBroadcastTask','recipientCount','integer',true),
  ('WhatsAppBroadcastTask','sentCount','integer',true),
  ('WhatsAppBroadcastTask','failedCount','integer',true),
  ('WhatsAppBroadcastTask','status','text',true),
  ('WhatsAppBroadcastTask','scheduledAt','timestamp(3) without time zone',false),
  ('WhatsAppBroadcastTask','completedAt','timestamp(3) without time zone',false),
  ('WhatsAppBroadcastTask','createdBy','text',false),
  ('WhatsAppBroadcastTask','createdAt','timestamp(3) without time zone',true),
  ('WhatsAppBroadcastTask','updatedAt','timestamp(3) without time zone',true),
  ('ProductSpec','id','text',true),
  ('ProductSpec','productId','text',true),
  ('ProductSpec','specCode','text',false),
  ('ProductSpec','size','text',true),
  ('ProductSpec','widthCm','double precision',false),
  ('ProductSpec','lengthCm','double precision',false),
  ('ProductSpec','gussetCm','double precision',false),
  ('ProductSpec','thicknessCm','text',false),
  ('ProductSpec','unitPrice','numeric(10,4)',true),
  ('ProductSpec','moq','integer',true),
  ('ProductSpec','packPerBundle','integer',false),
  ('ProductSpec','bundleWeightKg','double precision',false),
  ('ProductSpec','cartonSize','text',false),
  ('ProductSpec','cartonLengthCm','double precision',false),
  ('ProductSpec','cartonWidthCm','double precision',false),
  ('ProductSpec','cartonHeightCm','double precision',false),
  ('ProductSpec','weightPerItem','double precision',false),
  ('ProductSpec','isActive','boolean',true),
  ('ProductSpec','createdAt','timestamp(3) without time zone',true),
  ('ProductSpec','updatedAt','timestamp(3) without time zone',true),
  ('Order','id','text',true),
  ('Order','companyId','text',true),
  ('Order','orderNo','text',true),
  ('Order','leadId','text',false),
  ('Order','quoteId','text',false),
  ('Order','assignedUserId','text',false),
  ('Order','stage','text',true),
  ('Order','currency','text',true),
  ('Order','totalAmount','numeric(12,2)',true),
  ('Order','paidAmount','numeric(12,2)',true),
  ('Order','deliveryDate','timestamp(3) without time zone',false),
  ('Order','shippingTerms','text',false),
  ('Order','trackingNo','text',false),
  ('Order','notes','text',false),
  ('Order','stageHistory','jsonb',false),
  ('Order','createdAt','timestamp(3) without time zone',true),
  ('Order','updatedAt','timestamp(3) without time zone',true),
  ('CustomizerTemplate','id','text',true),
  ('CustomizerTemplate','companyId','text',true),
  ('CustomizerTemplate','productId','text',false),
  ('CustomizerTemplate','name','text',true),
  ('CustomizerTemplate','slug','text',true),
  ('CustomizerTemplate','description','text',false),
  ('CustomizerTemplate','modelUrl','text',true),
  ('CustomizerTemplate','modelFormat','text',true),
  ('CustomizerTemplate','textureSize','integer',true),
  ('CustomizerTemplate','unfoldLayout','jsonb',true),
  ('CustomizerTemplate','basePrice','numeric(10,4)',true),
  ('CustomizerTemplate','currency','text',true),
  ('CustomizerTemplate','moq','integer',true),
  ('CustomizerTemplate','leadTimeDays','integer',true),
  ('CustomizerTemplate','isPublished','boolean',true),
  ('CustomizerTemplate','sortOrder','integer',true),
  ('CustomizerTemplate','createdAt','timestamp(3) without time zone',true),
  ('CustomizerTemplate','updatedAt','timestamp(3) without time zone',true),
  ('CustomizerRegion','id','text',true),
  ('CustomizerRegion','templateId','text',true),
  ('CustomizerRegion','regionId','text',true),
  ('CustomizerRegion','label','text',true),
  ('CustomizerRegion','uvX','integer',true),
  ('CustomizerRegion','uvY','integer',true),
  ('CustomizerRegion','uvW','integer',true),
  ('CustomizerRegion','uvH','integer',true),
  ('CustomizerRegion','unfoldX','double precision',true),
  ('CustomizerRegion','unfoldY','double precision',true),
  ('CustomizerRegion','unfoldW','double precision',true),
  ('CustomizerRegion','unfoldH','double precision',true),
  ('CustomizerRegion','isEditable','boolean',true),
  ('CustomizerRegion','sortOrder','integer',true),
  ('CustomizerMaterial','id','text',true),
  ('CustomizerMaterial','templateId','text',true),
  ('CustomizerMaterial','name','text',true),
  ('CustomizerMaterial','type','text',true),
  ('CustomizerMaterial','colorHex','text',true),
  ('CustomizerMaterial','textureUrl','text',false),
  ('CustomizerMaterial','priceModifier','numeric(10,4)',true),
  ('CustomizerMaterial','sortOrder','integer',true),
  ('CustomizerLogoEffect','id','text',true),
  ('CustomizerLogoEffect','templateId','text',true),
  ('CustomizerLogoEffect','name','text',true),
  ('CustomizerLogoEffect','label','text',true),
  ('CustomizerLogoEffect','previewUrl','text',false),
  ('CustomizerLogoEffect','pricePerColor','numeric(10,4)',true),
  ('CustomizerLogoEffect','minColors','integer',true),
  ('CustomizerLogoEffect','sortOrder','integer',true),
  ('CustomizerDesign','id','text',true),
  ('CustomizerDesign','companyId','text',true),
  ('CustomizerDesign','templateId','text',true),
  ('CustomizerDesign','leadId','text',false),
  ('CustomizerDesign','shareCode','text',true),
  ('CustomizerDesign','customerName','text',false),
  ('CustomizerDesign','customerEmail','text',false),
  ('CustomizerDesign','customerPhone','text',false),
  ('CustomizerDesign','config','jsonb',true),
  ('CustomizerDesign','thumbnailUrl','text',false),
  ('CustomizerDesign','status','text',true),
  ('CustomizerDesign','createdAt','timestamp(3) without time zone',true),
  ('CustomizerDesign','updatedAt','timestamp(3) without time zone',true),
  ('CustomizerDesign','submittedAt','timestamp(3) without time zone',false),
  ('CustomizerInquiry','id','text',true),
  ('CustomizerInquiry','designId','text',true),
  ('CustomizerInquiry','quoteId','text',false),
  ('CustomizerInquiry','quantity','integer',true),
  ('CustomizerInquiry','unitPrice','numeric(10,4)',false),
  ('CustomizerInquiry','totalPrice','numeric(12,2)',false),
  ('CustomizerInquiry','currency','text',true),
  ('CustomizerInquiry','status','text',true),
  ('CustomizerInquiry','notes','text',false),
  ('CustomizerInquiry','createdAt','timestamp(3) without time zone',true),
  ('CustomizerInquiry','updatedAt','timestamp(3) without time zone',true);

CREATE TEMP TABLE _lan_expected_defaults (
  table_name text NOT NULL,
  column_name text NOT NULL,
  default_sql text NOT NULL,
  PRIMARY KEY (table_name, column_name)
) ON COMMIT DROP;

INSERT INTO _lan_expected_defaults VALUES
  ('Material','type','''image''::text'),
  ('Material','compressed','false'),
  ('Material','createdAt','CURRENT_TIMESTAMP'),
  ('ProductCategory','sortOrder','0'),
  ('ProductCategory','isActive','true'),
  ('ProductCategory','createdAt','CURRENT_TIMESTAMP'),
  ('AttributeTemplate','type','''TEXT''::"AttrType"'),
  ('AttributeTemplate','required','false'),
  ('AttributeTemplate','sortOrder','0'),
  ('AttributeTemplate','createdAt','CURRENT_TIMESTAMP'),
  ('Product','basePrice','0'),
  ('Product','currency','''CNY''::text'),
  ('Product','attributes','''{}''::jsonb'),
  ('Product','images','ARRAY[]::text[]'),
  ('Product','isActive','true'),
  ('Product','createdAt','CURRENT_TIMESTAMP'),
  ('WhatsAppBroadcastTask','accountId','''default''::text'),
  ('WhatsAppBroadcastTask','recipientCount','0'),
  ('WhatsAppBroadcastTask','sentCount','0'),
  ('WhatsAppBroadcastTask','failedCount','0'),
  ('WhatsAppBroadcastTask','status','''pending''::text'),
  ('WhatsAppBroadcastTask','createdAt','CURRENT_TIMESTAMP'),
  ('ProductSpec','moq','1'),
  ('ProductSpec','isActive','true'),
  ('ProductSpec','createdAt','CURRENT_TIMESTAMP'),
  ('Order','stage','''won''::text'),
  ('Order','currency','''USD''::text'),
  ('Order','totalAmount','0'),
  ('Order','paidAmount','0'),
  ('Order','createdAt','CURRENT_TIMESTAMP'),
  ('CustomizerTemplate','modelFormat','''glb''::text'),
  ('CustomizerTemplate','textureSize','2048'),
  ('CustomizerTemplate','currency','''USD''::text'),
  ('CustomizerTemplate','moq','10000'),
  ('CustomizerTemplate','leadTimeDays','20'),
  ('CustomizerTemplate','isPublished','false'),
  ('CustomizerTemplate','sortOrder','0'),
  ('CustomizerTemplate','createdAt','CURRENT_TIMESTAMP'),
  ('CustomizerRegion','isEditable','true'),
  ('CustomizerRegion','sortOrder','0'),
  ('CustomizerMaterial','colorHex','''#ffffff''::text'),
  ('CustomizerMaterial','priceModifier','0'),
  ('CustomizerMaterial','sortOrder','0'),
  ('CustomizerLogoEffect','pricePerColor','0'),
  ('CustomizerLogoEffect','minColors','1'),
  ('CustomizerLogoEffect','sortOrder','0'),
  ('CustomizerDesign','status','''draft''::text'),
  ('CustomizerDesign','createdAt','CURRENT_TIMESTAMP'),
  ('CustomizerInquiry','currency','''USD''::text'),
  ('CustomizerInquiry','status','''new''::text'),
  ('CustomizerInquiry','createdAt','CURRENT_TIMESTAMP');

DO $migration$
DECLARE
  expected record;
  table_oid oid;
  primary_name text;
  primary_columns text[];
  actual_type text;
  actual_not_null boolean;
  actual_default text;
  actual_generated "char";
  actual_identity "char";
  column_type_sql text;
  column_definition_sql text;
  table_has_rows boolean;
BEGIN
  FOR expected IN
    SELECT e.*, d.default_sql
    FROM _lan_expected_columns e
    LEFT JOIN _lan_expected_defaults d
      ON d.table_name = e.table_name AND d.column_name = e.column_name
    ORDER BY e.table_name, e.column_name
  LOOP
    table_oid := to_regclass(format('public.%I', expected.table_name));
    IF table_oid IS NULL THEN
      RAISE EXCEPTION 'legacy-schema reconciliation refused: required table % is missing', expected.table_name;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_attribute a
      WHERE a.attrelid = table_oid
        AND a.attname = expected.column_name
        AND a.attnum > 0
        AND NOT a.attisdropped
    ) THEN
      IF expected.not_null AND expected.default_sql IS NULL THEN
        EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I)', 'public', expected.table_name)
          INTO table_has_rows;
        IF table_has_rows THEN
          RAISE EXCEPTION 'legacy-schema reconciliation refused: cannot add required column %.% without a safe default to a non-empty table', expected.table_name, expected.column_name;
        END IF;
      END IF;

      column_type_sql := CASE lower(expected.type_name)
        WHEN 'attrtype' THEN '"AttrType"'
        ELSE expected.type_name
      END;
      column_definition_sql := format('%I %s', expected.column_name, column_type_sql);
      IF expected.default_sql IS NOT NULL THEN
        column_definition_sql := column_definition_sql || ' DEFAULT ' || expected.default_sql;
      END IF;
      IF expected.not_null THEN
        column_definition_sql := column_definition_sql || ' NOT NULL';
      END IF;
      EXECUTE format('ALTER TABLE %I.%I ADD COLUMN %s', 'public', expected.table_name, column_definition_sql);
    END IF;

    SELECT format_type(a.atttypid, a.atttypmod),
           a.attnotnull,
           a.attgenerated,
           a.attidentity,
           pg_get_expr(d.adbin, d.adrelid)
      INTO actual_type, actual_not_null, actual_generated, actual_identity, actual_default
    FROM pg_attribute a
    LEFT JOIN pg_attrdef d
      ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = table_oid
      AND a.attname = expected.column_name
      AND a.attnum > 0
      AND NOT a.attisdropped;

    IF replace(lower(actual_type), '"', '') <> replace(lower(expected.type_name), '"', '')
       OR actual_not_null IS DISTINCT FROM expected.not_null
       OR actual_generated IS DISTINCT FROM ''
       OR actual_identity IS DISTINCT FROM '' THEN
      RAISE EXCEPTION 'legacy-schema reconciliation refused: %.% has an unsafe column definition', expected.table_name, expected.column_name;
    END IF;

    IF expected.default_sql IS NULL AND actual_default IS NOT NULL THEN
      RAISE EXCEPTION 'legacy-schema reconciliation refused: %.% has an unexpected default %', expected.table_name, expected.column_name, actual_default;
    END IF;
    IF expected.default_sql IS NOT NULL
       AND regexp_replace(trim(actual_default), '\s+', ' ', 'g')
           IS DISTINCT FROM regexp_replace(trim(expected.default_sql), '\s+', ' ', 'g') THEN
      RAISE EXCEPTION 'legacy-schema reconciliation refused: %.% default definition mismatch (actual %, expected %)', expected.table_name, expected.column_name, actual_default, expected.default_sql;
    END IF;
  END LOOP;

  FOR expected IN SELECT DISTINCT table_name FROM _lan_expected_columns LOOP
    table_oid := to_regclass(format('public.%I', expected.table_name));
    SELECT c.conname,
           ARRAY(
             SELECT a.attname
             FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
             JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
             ORDER BY k.ord
           )
      INTO primary_name, primary_columns
    FROM pg_constraint c
    WHERE c.conrelid = table_oid AND c.contype = 'p';
    IF primary_name IS DISTINCT FROM expected.table_name || '_pkey'
       OR primary_columns IS DISTINCT FROM ARRAY['id']::text[] THEN
      RAISE EXCEPTION 'legacy-schema reconciliation refused: % primary key definition mismatch', expected.table_name;
    END IF;
  END LOOP;
END
$migration$;

CREATE TEMP TABLE _lan_expected_indexes (
  index_name text NOT NULL,
  table_name text NOT NULL,
  unique_index boolean NOT NULL,
  columns text[] NOT NULL
) ON COMMIT DROP;

INSERT INTO _lan_expected_indexes VALUES
  ('Material_companyId_type_idx','Material',false,ARRAY['companyId','type']),
  ('ProductCategory_companyId_idx','ProductCategory',false,ARRAY['companyId']),
  ('ProductCategory_parentId_idx','ProductCategory',false,ARRAY['parentId']),
  ('ProductCategory_companyId_name_key','ProductCategory',true,ARRAY['companyId','name']),
  ('AttributeTemplate_categoryId_idx','AttributeTemplate',false,ARRAY['categoryId']),
  ('AttributeTemplate_categoryId_name_key','AttributeTemplate',true,ARRAY['categoryId','name']),
  ('Product_companyId_categoryId_idx','Product',false,ARRAY['companyId','categoryId']),
  ('Product_companyId_name_idx','Product',false,ARRAY['companyId','name']),
  ('Product_productCode_idx','Product',false,ARRAY['productCode']),
  ('Product_productType_idx','Product',false,ARRAY['productType']),
  ('Product_companyId_sku_key','Product',true,ARRAY['companyId','sku']),
  ('WhatsAppBroadcastTask_companyId_idx','WhatsAppBroadcastTask',false,ARRAY['companyId']),
  ('WhatsAppBroadcastTask_status_idx','WhatsAppBroadcastTask',false,ARRAY['status']),
  ('WhatsAppBroadcastTask_accountId_idx','WhatsAppBroadcastTask',false,ARRAY['accountId']),
  ('ProductSpec_productId_idx','ProductSpec',false,ARRAY['productId']),
  ('ProductSpec_specCode_idx','ProductSpec',false,ARRAY['specCode']),
  ('Order_orderNo_key','Order',true,ARRAY['orderNo']),
  ('Order_companyId_idx','Order',false,ARRAY['companyId']),
  ('Order_leadId_idx','Order',false,ARRAY['leadId']),
  ('Order_stage_idx','Order',false,ARRAY['stage']),
  ('Order_quoteId_idx','Order',false,ARRAY['quoteId']),
  ('CustomizerTemplate_slug_key','CustomizerTemplate',true,ARRAY['slug']),
  ('CustomizerTemplate_companyId_idx','CustomizerTemplate',false,ARRAY['companyId']),
  ('CustomizerTemplate_isPublished_idx','CustomizerTemplate',false,ARRAY['isPublished']),
  ('CustomizerRegion_templateId_idx','CustomizerRegion',false,ARRAY['templateId']),
  ('CustomizerMaterial_templateId_idx','CustomizerMaterial',false,ARRAY['templateId']),
  ('CustomizerLogoEffect_templateId_idx','CustomizerLogoEffect',false,ARRAY['templateId']),
  ('CustomizerDesign_shareCode_key','CustomizerDesign',true,ARRAY['shareCode']),
  ('CustomizerDesign_companyId_idx','CustomizerDesign',false,ARRAY['companyId']),
  ('CustomizerDesign_templateId_idx','CustomizerDesign',false,ARRAY['templateId']),
  ('CustomizerDesign_leadId_idx','CustomizerDesign',false,ARRAY['leadId']),
  ('CustomizerDesign_status_idx','CustomizerDesign',false,ARRAY['status']),
  ('CustomizerDesign_shareCode_idx','CustomizerDesign',false,ARRAY['shareCode']),
  ('CustomizerInquiry_designId_idx','CustomizerInquiry',false,ARRAY['designId']),
  ('CustomizerInquiry_status_idx','CustomizerInquiry',false,ARRAY['status']);

CREATE TEMP TABLE _lan_drop_indexes (
  index_name text NOT NULL,
  table_name text NOT NULL,
  unique_index boolean NOT NULL,
  columns text[] NOT NULL
) ON COMMIT DROP;

INSERT INTO _lan_drop_indexes VALUES
  ('EmailMessage_leadId_outreachRound_idx','EmailMessage',false,ARRAY['leadId','outreachRound']),
  ('Lead_companyId_emailVerificationStatus_idx','Lead',false,ARRAY['companyId','emailVerificationStatus']);

CREATE TEMP TABLE _lan_rename_indexes (
  old_name text NOT NULL,
  new_name text NOT NULL,
  table_name text NOT NULL,
  unique_index boolean NOT NULL,
  columns text[] NOT NULL
) ON COMMIT DROP;

INSERT INTO _lan_rename_indexes VALUES
  ('AssistantBusinessAction_companyId_operatorUserId_state_cre_idx','AssistantBusinessAction_companyId_operatorUserId_state_crea_idx','AssistantBusinessAction',false,ARRAY['companyId','operatorUserId','state','createdAt']),
  ('AssistantGrantConsumption_companyId_capability_scopeDigest_crea','AssistantGrantConsumption_companyId_capability_scopeDigest__idx','AssistantGrantConsumption',false,ARRAY['companyId','capability','scopeDigest','createdAt']),
  ('AssistantGrantConsumption_companyId_operatorUserId_idempotencyK','AssistantGrantConsumption_companyId_operatorUserId_idempote_key','AssistantGrantConsumption',true,ARRAY['companyId','operatorUserId','idempotencyKey']),
  ('AssistantTemporaryGrant_companyId_operatorUserId_capabili_idx','AssistantTemporaryGrant_companyId_operatorUserId_capability_idx','AssistantTemporaryGrant',false,ARRAY['companyId','operatorUserId','capability','status','expiresAt']),
  ('CommunicationMessage_sourceAccountId_imapUidValidity_imapUid_id','CommunicationMessage_sourceAccountId_imapUidValidity_imapUi_idx','CommunicationMessage',false,ARRAY['sourceAccountId','imapUidValidity','imapUid']),
  ('EmailDispatchRequest_companyId_operatorUserId_status_createdAt_','EmailDispatchRequest_companyId_operatorUserId_status_create_idx','EmailDispatchRequest',false,ARRAY['companyId','operatorUserId','status','createdAt']),
  ('ExternalActionOutbox_channel_providerScope_provider_providerRec','ExternalActionOutbox_channel_providerScope_provider_provide_key','ExternalActionOutbox',true,ARRAY['channel','providerScope','provider','providerReceiptId']),
  ('ExternalActionOutbox_status_leaseExpiresAt_leaseToken_attemptVe','ExternalActionOutbox_status_leaseExpiresAt_leaseToken_attem_idx','ExternalActionOutbox',false,ARRAY['status','leaseExpiresAt','leaseToken','attemptVersion']),
  ('ExternalSuppression_companyId_channel_targetAddressHash_isActiv','ExternalSuppression_companyId_channel_targetAddressHash_isA_idx','ExternalSuppression',false,ARRAY['companyId','channel','targetAddressHash','isActive']);

CREATE OR REPLACE FUNCTION pg_temp._lan_validate_index(
  p_index_name text,
  p_table_name text,
  p_unique boolean,
  p_columns text[]
) RETURNS void
LANGUAGE plpgsql
AS $function$
DECLARE
  index_oid oid;
  expected_table oid;
  relation_kind "char";
  actual_table oid;
  actual_unique boolean;
  actual_valid boolean;
  actual_ready boolean;
  actual_access_method text;
  actual_predicate text;
  actual_expression text;
  actual_key_count integer;
  actual_total_count integer;
  actual_columns text[];
  actual_options smallint[];
  actual_opclasses oid[];
  actual_collations oid[];
  expected_opclasses oid[];
  expected_collations oid[];
  columns_sql text;
  actual_indexdef text;
  expected_indexdef text;
  canonical_actual text;
  canonical_expected text;
BEGIN
  index_oid := to_regclass(format('public.%I', p_index_name));
  expected_table := to_regclass(format('public.%I', p_table_name));
  IF index_oid IS NULL THEN
    RAISE EXCEPTION 'legacy-schema reconciliation refused: expected index % is missing', p_index_name;
  END IF;
  IF expected_table IS NULL THEN
    RAISE EXCEPTION 'legacy-schema reconciliation refused: expected index table % is missing', p_table_name;
  END IF;

  SELECT c.relkind,
         i.indrelid,
         i.indisunique,
         i.indisvalid,
         i.indisready,
         am.amname,
         pg_get_expr(i.indpred, i.indrelid),
         pg_get_expr(i.indexprs, i.indrelid),
         i.indnkeyatts,
         i.indnatts,
         ARRAY(
           SELECT a.attname
           FROM unnest(i.indkey) WITH ORDINALITY k(attnum, ord)
           JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
           WHERE k.ord <= i.indnkeyatts
           ORDER BY k.ord
         ),
         ARRAY(
           SELECT k.option_value::smallint
           FROM unnest(i.indoption) WITH ORDINALITY k(option_value, ord)
           WHERE k.ord <= i.indnkeyatts
           ORDER BY k.ord
         ),
         ARRAY(SELECT k.opclass_oid::oid FROM unnest(i.indclass) WITH ORDINALITY k(opclass_oid, ord) ORDER BY k.ord),
         ARRAY(SELECT k.collation_oid::oid FROM unnest(i.indcollation) WITH ORDINALITY k(collation_oid, ord) ORDER BY k.ord)
    INTO relation_kind,
         actual_table,
         actual_unique,
         actual_valid,
         actual_ready,
         actual_access_method,
         actual_predicate,
         actual_expression,
         actual_key_count,
         actual_total_count,
         actual_columns,
         actual_options,
         actual_opclasses,
         actual_collations
  FROM pg_class c
  JOIN pg_index i ON i.indexrelid = c.oid
  JOIN pg_am am ON am.oid = c.relam
  WHERE c.oid = index_oid;

  IF relation_kind IS DISTINCT FROM 'i'
     OR actual_table IS DISTINCT FROM expected_table
     OR actual_access_method IS DISTINCT FROM 'btree'
     OR actual_unique IS DISTINCT FROM p_unique
     OR NOT actual_valid
     OR NOT actual_ready THEN
    RAISE EXCEPTION 'legacy-schema reconciliation refused: index % relation/access/validity definition mismatch', p_index_name;
  END IF;
  IF actual_key_count IS DISTINCT FROM cardinality(p_columns)
     OR actual_total_count IS DISTINCT FROM cardinality(p_columns) THEN
    RAISE EXCEPTION 'legacy-schema reconciliation refused: index % key/include definition mismatch', p_index_name;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_index i
    CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum, ord)
    WHERE i.indexrelid = index_oid
      AND k.ord <= i.indnkeyatts
      AND k.attnum = 0
  ) THEN
    RAISE EXCEPTION 'legacy-schema reconciliation refused: index % contains an expression key', p_index_name;
  END IF;
  IF actual_columns IS DISTINCT FROM p_columns
     OR actual_options IS DISTINCT FROM array_fill(0::smallint, ARRAY[cardinality(p_columns)]) THEN
    RAISE EXCEPTION 'legacy-schema reconciliation refused: index % key column/order/nulls definition mismatch', p_index_name;
  END IF;
  IF actual_predicate IS NOT NULL OR actual_expression IS NOT NULL THEN
    RAISE EXCEPTION 'legacy-schema reconciliation refused: index % predicate/expression definition mismatch', p_index_name;
  END IF;

  SELECT array_agg(op.oid ORDER BY k.ord),
         array_agg(a.attcollation ORDER BY k.ord)
    INTO expected_opclasses, expected_collations
  FROM unnest(p_columns) WITH ORDINALITY k(column_name, ord)
  JOIN pg_attribute a
    ON a.attrelid = expected_table AND a.attname = k.column_name
  JOIN pg_type actual_type
    ON actual_type.oid = a.atttypid
  JOIN pg_type base_type
    ON base_type.oid = CASE
      WHEN actual_type.typtype = 'd' THEN actual_type.typbasetype
      ELSE actual_type.oid
    END
  JOIN pg_opclass op
    ON op.opcmethod = (SELECT oid FROM pg_am WHERE amname = 'btree')
   AND op.opcdefault
   AND (
     op.opcintype = base_type.oid
     OR (op.opcintype = 'anyenum'::regtype AND base_type.typtype = 'e')
     OR (op.opcintype = 'anyarray'::regtype AND base_type.typelem <> 0)
     OR (op.opcintype = 'anyrange'::regtype AND base_type.typtype = 'r')
     OR (op.opcintype = 'anymultirange'::regtype AND base_type.typtype = 'm')
   );
  IF expected_opclasses IS NULL
     OR actual_opclasses IS DISTINCT FROM expected_opclasses
     OR actual_collations IS DISTINCT FROM expected_collations THEN
    RAISE EXCEPTION 'legacy-schema reconciliation refused: index % opclass/collation definition mismatch', p_index_name;
  END IF;

  SELECT string_agg(format('%I', column_name), ', ' ORDER BY ord)
    INTO columns_sql
  FROM unnest(p_columns) WITH ORDINALITY u(column_name, ord);
  actual_indexdef := regexp_replace(pg_get_indexdef(index_oid), '\s+', ' ', 'g');
  expected_indexdef := format(
    'CREATE %sINDEX %I ON public.%I USING btree (%s)',
    CASE WHEN p_unique THEN 'UNIQUE ' ELSE '' END,
    p_index_name,
    p_table_name,
    columns_sql
  );
  canonical_actual := regexp_replace(replace(lower(actual_indexdef), '"', ''), '\s+', '', 'g');
  canonical_expected := regexp_replace(replace(lower(expected_indexdef), '"', ''), '\s+', '', 'g');
  IF canonical_actual IS DISTINCT FROM canonical_expected THEN
    RAISE EXCEPTION 'legacy-schema reconciliation refused: index % normalized definition mismatch (actual %, expected %)', p_index_name, actual_indexdef, expected_indexdef;
  END IF;
END
$function$;

DO $migration$
DECLARE
  expected record;
  index_oid oid;
  relation_kind "char";
  columns_sql text;
  old_oid oid;
  new_oid oid;
BEGIN
  FOR expected IN SELECT * FROM _lan_drop_indexes LOOP
    index_oid := to_regclass(format('public.%I', expected.index_name));
    IF index_oid IS NOT NULL THEN
      PERFORM pg_temp._lan_validate_index(expected.index_name, expected.table_name, expected.unique_index, expected.columns);
      EXECUTE format('DROP INDEX %I.%I', 'public', expected.index_name);
    END IF;
  END LOOP;

  FOR expected IN SELECT * FROM _lan_expected_indexes LOOP
    index_oid := to_regclass(format('public.%I', expected.index_name));
    IF index_oid IS NULL THEN
      SELECT string_agg(format('%I', column_name), ', ')
        INTO columns_sql
      FROM unnest(expected.columns) AS u(column_name);
      EXECUTE format(
        'CREATE %sINDEX %I ON %I.%I USING btree (%s)',
        CASE WHEN expected.unique_index THEN 'UNIQUE ' ELSE '' END,
        expected.index_name,
        'public',
        expected.table_name,
        columns_sql
      );
    END IF;
    PERFORM pg_temp._lan_validate_index(expected.index_name, expected.table_name, expected.unique_index, expected.columns);
  END LOOP;

  FOR expected IN SELECT * FROM _lan_rename_indexes LOOP
    old_oid := to_regclass(format('public.%I', expected.old_name));
    new_oid := to_regclass(format('public.%I', expected.new_name));
    IF old_oid IS NOT NULL AND new_oid IS NOT NULL THEN
      PERFORM pg_temp._lan_validate_index(expected.old_name, expected.table_name, expected.unique_index, expected.columns);
      PERFORM pg_temp._lan_validate_index(expected.new_name, expected.table_name, expected.unique_index, expected.columns);
      RAISE EXCEPTION 'legacy-schema reconciliation refused: both old and new index names exist for %', expected.new_name;
    ELSIF old_oid IS NOT NULL THEN
      PERFORM pg_temp._lan_validate_index(expected.old_name, expected.table_name, expected.unique_index, expected.columns);
      EXECUTE format('ALTER INDEX %I.%I RENAME TO %I', 'public', expected.old_name, expected.new_name);
      PERFORM pg_temp._lan_validate_index(expected.new_name, expected.table_name, expected.unique_index, expected.columns);
    ELSIF new_oid IS NOT NULL THEN
      PERFORM pg_temp._lan_validate_index(expected.new_name, expected.table_name, expected.unique_index, expected.columns);
    ELSE
      SELECT string_agg(format('%I', column_name), ', ')
        INTO columns_sql
      FROM unnest(expected.columns) AS u(column_name);
      EXECUTE format(
        'CREATE %sINDEX %I ON %I.%I USING btree (%s)',
        CASE WHEN expected.unique_index THEN 'UNIQUE ' ELSE '' END,
        expected.new_name,
        'public',
        expected.table_name,
        columns_sql
      );
      PERFORM pg_temp._lan_validate_index(expected.new_name, expected.table_name, expected.unique_index, expected.columns);
    END IF;
  END LOOP;
END
$migration$;

CREATE TEMP TABLE _lan_expected_foreign_keys (
  constraint_name text NOT NULL,
  table_name text NOT NULL,
  local_columns text[] NOT NULL,
  ref_table_name text NOT NULL,
  ref_columns text[] NOT NULL,
  on_delete "char" NOT NULL,
  on_update "char" NOT NULL
) ON COMMIT DROP;

INSERT INTO _lan_expected_foreign_keys VALUES
  ('ProductCategory_companyId_fkey','ProductCategory',ARRAY['companyId'],'Company',ARRAY['id'],'r','c'),
  ('ProductCategory_parentId_fkey','ProductCategory',ARRAY['parentId'],'ProductCategory',ARRAY['id'],'n','c'),
  ('AttributeTemplate_categoryId_fkey','AttributeTemplate',ARRAY['categoryId'],'ProductCategory',ARRAY['id'],'c','c'),
  ('Product_companyId_fkey','Product',ARRAY['companyId'],'Company',ARRAY['id'],'r','c'),
  ('Product_categoryId_fkey','Product',ARRAY['categoryId'],'ProductCategory',ARRAY['id'],'n','c'),
  ('WhatsAppBroadcastTask_companyId_fkey','WhatsAppBroadcastTask',ARRAY['companyId'],'Company',ARRAY['id'],'c','c'),
  ('ProductSpec_productId_fkey','ProductSpec',ARRAY['productId'],'Product',ARRAY['id'],'c','c'),
  ('Order_companyId_fkey','Order',ARRAY['companyId'],'Company',ARRAY['id'],'c','c'),
  ('Order_leadId_fkey','Order',ARRAY['leadId'],'Lead',ARRAY['id'],'n','c'),
  ('CustomizerTemplate_companyId_fkey','CustomizerTemplate',ARRAY['companyId'],'Company',ARRAY['id'],'r','c'),
  ('CustomizerTemplate_productId_fkey','CustomizerTemplate',ARRAY['productId'],'Product',ARRAY['id'],'n','c'),
  ('CustomizerRegion_templateId_fkey','CustomizerRegion',ARRAY['templateId'],'CustomizerTemplate',ARRAY['id'],'c','c'),
  ('CustomizerMaterial_templateId_fkey','CustomizerMaterial',ARRAY['templateId'],'CustomizerTemplate',ARRAY['id'],'c','c'),
  ('CustomizerLogoEffect_templateId_fkey','CustomizerLogoEffect',ARRAY['templateId'],'CustomizerTemplate',ARRAY['id'],'c','c'),
  ('CustomizerDesign_companyId_fkey','CustomizerDesign',ARRAY['companyId'],'Company',ARRAY['id'],'r','c'),
  ('CustomizerDesign_templateId_fkey','CustomizerDesign',ARRAY['templateId'],'CustomizerTemplate',ARRAY['id'],'r','c'),
  ('CustomizerDesign_leadId_fkey','CustomizerDesign',ARRAY['leadId'],'Lead',ARRAY['id'],'n','c'),
  ('CustomizerInquiry_designId_fkey','CustomizerInquiry',ARRAY['designId'],'CustomizerDesign',ARRAY['id'],'c','c'),
  ('CustomizerInquiry_quoteId_fkey','CustomizerInquiry',ARRAY['quoteId'],'Quote',ARRAY['id'],'n','c');

DO $migration$
DECLARE
  expected record;
  fk_oid oid;
  actual_ref oid;
  actual_delete "char";
  actual_update "char";
  actual_validated boolean;
  actual_local text[];
  actual_ref_columns text[];
  local_sql text;
  ref_sql text;
  delete_sql text;
  update_sql text;
BEGIN
  FOR expected IN SELECT * FROM _lan_expected_foreign_keys LOOP
    SELECT c.oid, c.confrelid, c.confdeltype, c.confupdtype, c.convalidated,
           ARRAY(
             SELECT a.attname
             FROM unnest(c.conkey) WITH ORDINALITY k(attnum, ord)
             JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
             ORDER BY k.ord
           ),
           ARRAY(
             SELECT a.attname
             FROM unnest(c.confkey) WITH ORDINALITY k(attnum, ord)
             JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum
             ORDER BY k.ord
           )
      INTO fk_oid, actual_ref, actual_delete, actual_update, actual_validated, actual_local, actual_ref_columns
    FROM pg_constraint c
    WHERE c.conrelid = to_regclass(format('public.%I', expected.table_name))
      AND c.conname = expected.constraint_name
      AND c.contype = 'f';

    IF fk_oid IS NULL THEN
      SELECT string_agg(format('%I', column_name), ', ')
        INTO local_sql
      FROM unnest(expected.local_columns) AS u(column_name);
      SELECT string_agg(format('%I', column_name), ', ')
        INTO ref_sql
      FROM unnest(expected.ref_columns) AS u(column_name);
      delete_sql := CASE expected.on_delete WHEN 'c' THEN 'CASCADE' WHEN 'r' THEN 'RESTRICT' WHEN 'n' THEN 'SET NULL' ELSE 'NO ACTION' END;
      update_sql := CASE expected.on_update WHEN 'c' THEN 'CASCADE' WHEN 'r' THEN 'RESTRICT' WHEN 'n' THEN 'SET NULL' ELSE 'NO ACTION' END;
      EXECUTE format(
        'ALTER TABLE %I.%I ADD CONSTRAINT %I FOREIGN KEY (%s) REFERENCES %I.%I (%s) ON DELETE %s ON UPDATE %s',
        'public',
        expected.table_name,
        expected.constraint_name,
        local_sql,
        'public',
        expected.ref_table_name,
        ref_sql,
        delete_sql,
        update_sql
      );
    ELSIF actual_ref IS DISTINCT FROM to_regclass(format('public.%I', expected.ref_table_name))
       OR actual_delete IS DISTINCT FROM expected.on_delete
       OR actual_update IS DISTINCT FROM expected.on_update
       OR actual_local IS DISTINCT FROM expected.local_columns
       OR actual_ref_columns IS DISTINCT FROM expected.ref_columns THEN
      RAISE EXCEPTION 'legacy-schema reconciliation refused: foreign key % definition mismatch', expected.constraint_name;
    ELSIF actual_validated IS NOT TRUE THEN
      EXECUTE format(
        'ALTER TABLE %I.%I VALIDATE CONSTRAINT %I',
        'public',
        expected.table_name,
        expected.constraint_name
      );
    END IF;

    SELECT c.convalidated
      INTO actual_validated
    FROM pg_constraint c
    WHERE c.conrelid = to_regclass(format('public.%I', expected.table_name))
      AND c.conname = expected.constraint_name
      AND c.contype = 'f';

    IF actual_validated IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'legacy-schema reconciliation refused: foreign key % is not validated', expected.constraint_name;
    END IF;
  END LOOP;
END
$migration$;
