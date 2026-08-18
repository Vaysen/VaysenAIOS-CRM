-- Customers label-chain foundation.
--
-- Tag and LeadTag are present in schema.prisma and used by the customers
-- endpoints, but were never created by the historical migration chain.  This
-- migration is deliberately limited to those two tables and their direct
-- keys.  Existing unknown columns are retained.  Existing rows that cannot be
-- mapped to the schema contract are rejected instead of being rewritten.

DO $$
DECLARE
  row_count bigint;
  column_type text;
  is_nullable text;
  relation_kind "char";
  relation_oid oid;
  index_oid oid;
  index_is_unique boolean;
  index_columns text[];
  constraint_oid oid;
  constraint_def text;
  fk_relation oid;
  fk_delete "char";
  fk_update "char";
  fk_local_attnum smallint;
  fk_ref_attnum smallint;
BEGIN
  -- Lead is a precondition for the relation table.  Do not manufacture or
  -- alter it here: it is outside this narrowly scoped repair.
  IF to_regclass('public."Lead"') IS NULL THEN
    RAISE EXCEPTION 'lead-tag migration refused: required table public."Lead" is missing';
  END IF;

  SELECT a.attrelid, a.attnum, format_type(a.atttypid, a.atttypmod)
    INTO relation_oid, fk_local_attnum, column_type
  FROM pg_attribute a
  WHERE a.attrelid = to_regclass('public."Lead"')
    AND a.attname = 'id'
    AND a.attnum > 0
    AND NOT a.attisdropped;
  IF relation_oid IS NULL OR column_type <> 'text' THEN
    RAISE EXCEPTION 'lead-tag migration refused: public."Lead"."id" must be text';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    WHERE c.conrelid = to_regclass('public."Lead"')
      AND c.contype = 'p'
      AND c.conkey = ARRAY[fk_local_attnum]
  ) THEN
    RAISE EXCEPTION 'lead-tag migration refused: public."Lead"."id" is not the primary key';
  END IF;

  -- Create the Tag table when absent.  If a partial table already exists,
  -- the checks below add only safe definitions and preserve unknown columns.
  IF to_regclass('public."Tag"') IS NULL THEN
    CREATE TABLE "Tag" (
      "id" TEXT NOT NULL,
      "companyId" TEXT NOT NULL,
      "name" TEXT NOT NULL,
      "displayName" TEXT NOT NULL,
      "color" TEXT NOT NULL DEFAULT '#6366f1',
      "category" TEXT NOT NULL DEFAULT 'custom',
      "isSystem" BOOLEAN NOT NULL DEFAULT false,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
    );
  ELSE
    SELECT count(*) INTO row_count FROM "Tag";

    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'Tag' AND column_name = 'id') THEN
      IF row_count > 0 THEN RAISE EXCEPTION 'lead-tag migration refused: non-empty Tag is missing id'; END IF;
      ALTER TABLE "Tag" ADD COLUMN "id" TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'Tag' AND column_name = 'companyId') THEN
      IF row_count > 0 THEN RAISE EXCEPTION 'lead-tag migration refused: non-empty Tag is missing companyId'; END IF;
      ALTER TABLE "Tag" ADD COLUMN "companyId" TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'Tag' AND column_name = 'name') THEN
      IF row_count > 0 THEN RAISE EXCEPTION 'lead-tag migration refused: non-empty Tag is missing name'; END IF;
      ALTER TABLE "Tag" ADD COLUMN "name" TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'Tag' AND column_name = 'displayName') THEN
      IF row_count > 0 THEN RAISE EXCEPTION 'lead-tag migration refused: non-empty Tag is missing displayName'; END IF;
      ALTER TABLE "Tag" ADD COLUMN "displayName" TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'Tag' AND column_name = 'color') THEN
      ALTER TABLE "Tag" ADD COLUMN "color" TEXT DEFAULT '#6366f1';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'Tag' AND column_name = 'category') THEN
      ALTER TABLE "Tag" ADD COLUMN "category" TEXT DEFAULT 'custom';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'Tag' AND column_name = 'isSystem') THEN
      ALTER TABLE "Tag" ADD COLUMN "isSystem" BOOLEAN DEFAULT false;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'Tag' AND column_name = 'createdAt') THEN
      ALTER TABLE "Tag" ADD COLUMN "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP;
    END IF;

    SELECT udt_name INTO column_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'Tag' AND column_name = 'id';
    IF column_type <> 'text' THEN RAISE EXCEPTION 'lead-tag migration refused: Tag.id has incompatible type %', column_type; END IF;
    SELECT udt_name INTO column_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'Tag' AND column_name = 'companyId';
    IF column_type <> 'text' THEN RAISE EXCEPTION 'lead-tag migration refused: Tag.companyId has incompatible type %', column_type; END IF;
    SELECT udt_name INTO column_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'Tag' AND column_name = 'name';
    IF column_type <> 'text' THEN RAISE EXCEPTION 'lead-tag migration refused: Tag.name has incompatible type %', column_type; END IF;
    SELECT udt_name INTO column_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'Tag' AND column_name = 'displayName';
    IF column_type <> 'text' THEN RAISE EXCEPTION 'lead-tag migration refused: Tag.displayName has incompatible type %', column_type; END IF;
    SELECT udt_name INTO column_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'Tag' AND column_name = 'color';
    IF column_type <> 'text' THEN RAISE EXCEPTION 'lead-tag migration refused: Tag.color has incompatible type %', column_type; END IF;
    SELECT udt_name INTO column_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'Tag' AND column_name = 'category';
    IF column_type <> 'text' THEN RAISE EXCEPTION 'lead-tag migration refused: Tag.category has incompatible type %', column_type; END IF;
    SELECT udt_name INTO column_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'Tag' AND column_name = 'isSystem';
    IF column_type <> 'bool' THEN RAISE EXCEPTION 'lead-tag migration refused: Tag.isSystem has incompatible type %', column_type; END IF;
    SELECT udt_name INTO column_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'Tag' AND column_name = 'createdAt';
    IF column_type <> 'timestamp' THEN RAISE EXCEPTION 'lead-tag migration refused: Tag.createdAt has incompatible type %', column_type; END IF;

    SELECT count(*) INTO row_count FROM "Tag" WHERE "id" IS NULL OR "companyId" IS NULL OR "name" IS NULL OR "displayName" IS NULL;
    IF row_count > 0 THEN RAISE EXCEPTION 'lead-tag migration refused: Tag has NULLs in identity columns'; END IF;
    UPDATE "Tag" SET "color" = '#6366f1' WHERE "color" IS NULL;
    UPDATE "Tag" SET "category" = 'custom' WHERE "category" IS NULL;
    UPDATE "Tag" SET "isSystem" = false WHERE "isSystem" IS NULL;
    UPDATE "Tag" SET "createdAt" = CURRENT_TIMESTAMP WHERE "createdAt" IS NULL;
    ALTER TABLE "Tag" ALTER COLUMN "color" SET DEFAULT '#6366f1';
    ALTER TABLE "Tag" ALTER COLUMN "category" SET DEFAULT 'custom';
    ALTER TABLE "Tag" ALTER COLUMN "isSystem" SET DEFAULT false;
    ALTER TABLE "Tag" ALTER COLUMN "createdAt" SET DEFAULT CURRENT_TIMESTAMP;
    ALTER TABLE "Tag" ALTER COLUMN "id" SET NOT NULL;
    ALTER TABLE "Tag" ALTER COLUMN "companyId" SET NOT NULL;
    ALTER TABLE "Tag" ALTER COLUMN "name" SET NOT NULL;
    ALTER TABLE "Tag" ALTER COLUMN "displayName" SET NOT NULL;
    ALTER TABLE "Tag" ALTER COLUMN "color" SET NOT NULL;
    ALTER TABLE "Tag" ALTER COLUMN "category" SET NOT NULL;
    ALTER TABLE "Tag" ALTER COLUMN "isSystem" SET NOT NULL;
    ALTER TABLE "Tag" ALTER COLUMN "createdAt" SET NOT NULL;
  END IF;

  -- Normalize the Tag primary key.  A same-name wrong index is removed, but
  -- an object of another kind is treated as an unsafe collision.
  SELECT c.oid, c.relkind INTO relation_oid, relation_kind
  FROM pg_class c
  WHERE c.oid = to_regclass('public."Tag_pkey"');
  IF relation_oid IS NOT NULL AND relation_kind <> 'i' THEN
    RAISE EXCEPTION 'lead-tag migration refused: Tag_pkey name is occupied by a non-index object';
  END IF;
  SELECT c.oid, pg_get_constraintdef(c.oid) INTO constraint_oid, constraint_def
  FROM pg_constraint c
  WHERE c.conrelid = to_regclass('public."Tag"') AND c.conname = 'Tag_pkey';
  IF constraint_oid IS NOT NULL AND regexp_replace(lower(constraint_def), '[^a-z0-9]+', '', 'g') <> 'primarykeyid' THEN
    ALTER TABLE "Tag" DROP CONSTRAINT "Tag_pkey";
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = to_regclass('public."Tag"') AND c.conname = 'Tag_pkey' AND c.contype = 'p'
      AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = to_regclass('public."Tag"') AND attname = 'id' AND attnum > 0)]
  ) THEN
    ALTER TABLE "Tag" ADD CONSTRAINT "Tag_pkey" PRIMARY KEY ("id");
  END IF;

  -- A unique constraint is converted to the Prisma-style named unique index,
  -- so a same-name object with the wrong definition cannot be silently kept.
  SELECT c.oid, pg_get_constraintdef(c.oid) INTO constraint_oid, constraint_def
  FROM pg_constraint c
  WHERE c.conrelid = to_regclass('public."Tag"') AND c.conname = 'Tag_companyId_name_key';
  IF constraint_oid IS NOT NULL THEN
    ALTER TABLE "Tag" DROP CONSTRAINT "Tag_companyId_name_key";
  END IF;
  SELECT c.oid, c.relkind INTO relation_oid, relation_kind
  FROM pg_class c
  WHERE c.oid = to_regclass('public."Tag_companyId_name_key"');
  IF relation_oid IS NOT NULL AND relation_kind <> 'i' THEN
    RAISE EXCEPTION 'lead-tag migration refused: Tag_companyId_name_key name is occupied by a non-index object';
  END IF;
  SELECT i.indexrelid, i.indisunique, COALESCE(array_agg(a.attname ORDER BY k.ord), ARRAY[]::text[])
    INTO index_oid, index_is_unique, index_columns
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
  LEFT JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum, ord) ON true
  LEFT JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
  WHERE i.indexrelid = to_regclass('public."Tag_companyId_name_key"')
  GROUP BY i.indexrelid, i.indisunique;
  IF index_oid IS NOT NULL AND (NOT index_is_unique OR index_columns <> ARRAY['companyId', 'name']) THEN
    DROP INDEX "Tag_companyId_name_key";
    index_oid := NULL;
  END IF;
  IF index_oid IS NULL THEN
    CREATE UNIQUE INDEX "Tag_companyId_name_key" ON "Tag"("companyId", "name");
  END IF;

  SELECT c.oid, c.relkind INTO relation_oid, relation_kind
  FROM pg_class c
  WHERE c.oid = to_regclass('public."Tag_companyId_category_idx"');
  IF relation_oid IS NOT NULL AND relation_kind <> 'i' THEN
    RAISE EXCEPTION 'lead-tag migration refused: Tag_companyId_category_idx name is occupied by a non-index object';
  END IF;
  SELECT i.indexrelid, i.indisunique, COALESCE(array_agg(a.attname ORDER BY k.ord), ARRAY[]::text[])
    INTO index_oid, index_is_unique, index_columns
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
  LEFT JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum, ord) ON true
  LEFT JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
  WHERE i.indexrelid = to_regclass('public."Tag_companyId_category_idx"')
  GROUP BY i.indexrelid, i.indisunique;
  IF index_oid IS NOT NULL AND (index_is_unique OR index_columns <> ARRAY['companyId', 'category']) THEN
    DROP INDEX "Tag_companyId_category_idx";
    index_oid := NULL;
  END IF;
  IF index_oid IS NULL THEN
    CREATE INDEX "Tag_companyId_category_idx" ON "Tag"("companyId", "category");
  END IF;

  -- LeadTag follows the Prisma model exactly.  A non-empty partial table with
  -- an unmappable required column fails closed; unknown columns are retained.
  IF to_regclass('public."LeadTag"') IS NULL THEN
    CREATE TABLE "LeadTag" (
      "id" TEXT NOT NULL,
      "leadId" TEXT NOT NULL,
      "tagId" TEXT NOT NULL,
      "createdBy" TEXT NOT NULL,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "LeadTag_pkey" PRIMARY KEY ("id")
    );
  ELSE
    SELECT count(*) INTO row_count FROM "LeadTag";
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'LeadTag' AND column_name = 'id') THEN
      IF row_count > 0 THEN RAISE EXCEPTION 'lead-tag migration refused: non-empty LeadTag is missing id'; END IF;
      ALTER TABLE "LeadTag" ADD COLUMN "id" TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'LeadTag' AND column_name = 'leadId') THEN
      IF row_count > 0 THEN RAISE EXCEPTION 'lead-tag migration refused: non-empty LeadTag is missing leadId'; END IF;
      ALTER TABLE "LeadTag" ADD COLUMN "leadId" TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'LeadTag' AND column_name = 'tagId') THEN
      IF row_count > 0 THEN RAISE EXCEPTION 'lead-tag migration refused: non-empty LeadTag is missing tagId'; END IF;
      ALTER TABLE "LeadTag" ADD COLUMN "tagId" TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'LeadTag' AND column_name = 'createdBy') THEN
      IF row_count > 0 THEN RAISE EXCEPTION 'lead-tag migration refused: non-empty LeadTag is missing createdBy'; END IF;
      ALTER TABLE "LeadTag" ADD COLUMN "createdBy" TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'LeadTag' AND column_name = 'createdAt') THEN
      ALTER TABLE "LeadTag" ADD COLUMN "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP;
    END IF;

    FOREACH column_type IN ARRAY ARRAY['id', 'leadId', 'tagId', 'createdBy'] LOOP
      SELECT udt_name INTO is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'LeadTag' AND column_name = column_type;
      IF is_nullable <> 'text' THEN
        RAISE EXCEPTION 'lead-tag migration refused: LeadTag.% has incompatible type %', column_type, is_nullable;
      END IF;
    END LOOP;
    SELECT udt_name INTO column_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'LeadTag' AND column_name = 'createdAt';
    IF column_type <> 'timestamp' THEN RAISE EXCEPTION 'lead-tag migration refused: LeadTag.createdAt has incompatible type %', column_type; END IF;
    SELECT count(*) INTO row_count FROM "LeadTag" WHERE "id" IS NULL OR "leadId" IS NULL OR "tagId" IS NULL OR "createdBy" IS NULL;
    IF row_count > 0 THEN RAISE EXCEPTION 'lead-tag migration refused: LeadTag has NULLs in required columns'; END IF;
    UPDATE "LeadTag" SET "createdAt" = CURRENT_TIMESTAMP WHERE "createdAt" IS NULL;
    ALTER TABLE "LeadTag" ALTER COLUMN "createdAt" SET DEFAULT CURRENT_TIMESTAMP;
    ALTER TABLE "LeadTag" ALTER COLUMN "id" SET NOT NULL;
    ALTER TABLE "LeadTag" ALTER COLUMN "leadId" SET NOT NULL;
    ALTER TABLE "LeadTag" ALTER COLUMN "tagId" SET NOT NULL;
    ALTER TABLE "LeadTag" ALTER COLUMN "createdBy" SET NOT NULL;
    ALTER TABLE "LeadTag" ALTER COLUMN "createdAt" SET NOT NULL;
  END IF;

  -- Normalize the LeadTag primary key.
  SELECT c.oid, c.relkind INTO relation_oid, relation_kind
  FROM pg_class c
  WHERE c.oid = to_regclass('public."LeadTag_pkey"');
  IF relation_oid IS NOT NULL AND relation_kind <> 'i' THEN
    RAISE EXCEPTION 'lead-tag migration refused: LeadTag_pkey name is occupied by a non-index object';
  END IF;
  SELECT c.oid, pg_get_constraintdef(c.oid) INTO constraint_oid, constraint_def
  FROM pg_constraint c
  WHERE c.conrelid = to_regclass('public."LeadTag"') AND c.conname = 'LeadTag_pkey';
  IF constraint_oid IS NOT NULL AND regexp_replace(lower(constraint_def), '[^a-z0-9]+', '', 'g') <> 'primarykeyid' THEN
    ALTER TABLE "LeadTag" DROP CONSTRAINT "LeadTag_pkey";
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    WHERE c.conrelid = to_regclass('public."LeadTag"') AND c.conname = 'LeadTag_pkey' AND c.contype = 'p'
      AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = to_regclass('public."LeadTag"') AND attname = 'id' AND attnum > 0)]
  ) THEN
    ALTER TABLE "LeadTag" ADD CONSTRAINT "LeadTag_pkey" PRIMARY KEY ("id");
  END IF;

  -- Normalize the relation unique index and never keep a same-name wrong
  -- definition.  Duplicate (leadId, tagId) data causes a transactional failure.
  SELECT c.oid, c.relkind INTO relation_oid, relation_kind
  FROM pg_class c
  WHERE c.oid = to_regclass('public."LeadTag_leadId_tagId_key"');
  IF relation_oid IS NOT NULL AND relation_kind <> 'i' THEN
    RAISE EXCEPTION 'lead-tag migration refused: LeadTag_leadId_tagId_key name is occupied by a non-index object';
  END IF;
  SELECT c.oid INTO constraint_oid
  FROM pg_constraint c
  WHERE c.conrelid = to_regclass('public."LeadTag"') AND c.conname = 'LeadTag_leadId_tagId_key';
  IF constraint_oid IS NOT NULL THEN
    ALTER TABLE "LeadTag" DROP CONSTRAINT "LeadTag_leadId_tagId_key";
  END IF;
  SELECT i.indexrelid, i.indisunique, COALESCE(array_agg(a.attname ORDER BY k.ord), ARRAY[]::text[])
    INTO index_oid, index_is_unique, index_columns
  FROM pg_index i
  JOIN pg_class c ON c.oid = i.indexrelid
  LEFT JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum, ord) ON true
  LEFT JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
  WHERE i.indexrelid = to_regclass('public."LeadTag_leadId_tagId_key"')
  GROUP BY i.indexrelid, i.indisunique;
  IF index_oid IS NOT NULL AND (NOT index_is_unique OR index_columns <> ARRAY['leadId', 'tagId']) THEN
    DROP INDEX "LeadTag_leadId_tagId_key";
    index_oid := NULL;
  END IF;
  IF index_oid IS NULL THEN
    CREATE UNIQUE INDEX "LeadTag_leadId_tagId_key" ON "LeadTag"("leadId", "tagId");
  END IF;

  -- Same-name wrong foreign keys are replaced; orphaned data makes ADD
  -- CONSTRAINT fail and rolls the entire migration back.
  SELECT c.oid, c.confrelid, c.confdeltype, c.confupdtype,
         c.conkey[1], c.confkey[1]
    INTO constraint_oid, fk_relation, fk_delete, fk_update, fk_local_attnum, fk_ref_attnum
  FROM pg_constraint c
  WHERE c.conrelid = to_regclass('public."LeadTag"') AND c.conname = 'LeadTag_leadId_fkey';
  IF constraint_oid IS NOT NULL AND (
    fk_relation <> to_regclass('public."Lead"') OR fk_delete <> 'c' OR fk_update <> 'c'
    OR fk_local_attnum <> (SELECT attnum FROM pg_attribute WHERE attrelid = to_regclass('public."LeadTag"') AND attname = 'leadId' AND attnum > 0)
    OR fk_ref_attnum <> (SELECT attnum FROM pg_attribute WHERE attrelid = to_regclass('public."Lead"') AND attname = 'id' AND attnum > 0)
  ) THEN
    ALTER TABLE "LeadTag" DROP CONSTRAINT "LeadTag_leadId_fkey";
    constraint_oid := NULL;
  END IF;
  IF constraint_oid IS NULL AND to_regclass('public."LeadTag_leadId_fkey"') IS NOT NULL THEN
    SELECT c.relkind INTO relation_kind FROM pg_class c WHERE c.oid = to_regclass('public."LeadTag_leadId_fkey"');
    IF relation_kind <> 'i' THEN RAISE EXCEPTION 'lead-tag migration refused: LeadTag_leadId_fkey name collision'; END IF;
    DROP INDEX "LeadTag_leadId_fkey";
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public."LeadTag"') AND conname = 'LeadTag_leadId_fkey') THEN
    ALTER TABLE "LeadTag" ADD CONSTRAINT "LeadTag_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  SELECT c.oid, c.confrelid, c.confdeltype, c.confupdtype,
         c.conkey[1], c.confkey[1]
    INTO constraint_oid, fk_relation, fk_delete, fk_update, fk_local_attnum, fk_ref_attnum
  FROM pg_constraint c
  WHERE c.conrelid = to_regclass('public."LeadTag"') AND c.conname = 'LeadTag_tagId_fkey';
  IF constraint_oid IS NOT NULL AND (
    fk_relation <> to_regclass('public."Tag"') OR fk_delete <> 'c' OR fk_update <> 'c'
    OR fk_local_attnum <> (SELECT attnum FROM pg_attribute WHERE attrelid = to_regclass('public."LeadTag"') AND attname = 'tagId' AND attnum > 0)
    OR fk_ref_attnum <> (SELECT attnum FROM pg_attribute WHERE attrelid = to_regclass('public."Tag"') AND attname = 'id' AND attnum > 0)
  ) THEN
    ALTER TABLE "LeadTag" DROP CONSTRAINT "LeadTag_tagId_fkey";
    constraint_oid := NULL;
  END IF;
  IF constraint_oid IS NULL AND to_regclass('public."LeadTag_tagId_fkey"') IS NOT NULL THEN
    SELECT c.relkind INTO relation_kind FROM pg_class c WHERE c.oid = to_regclass('public."LeadTag_tagId_fkey"');
    IF relation_kind <> 'i' THEN RAISE EXCEPTION 'lead-tag migration refused: LeadTag_tagId_fkey name collision'; END IF;
    DROP INDEX "LeadTag_tagId_fkey";
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = to_regclass('public."LeadTag"') AND conname = 'LeadTag_tagId_fkey') THEN
    ALTER TABLE "LeadTag" ADD CONSTRAINT "LeadTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
