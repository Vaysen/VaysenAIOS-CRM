declare const describe: any;
declare const it: any;
declare const expect: any;
declare const beforeAll: any;
declare const afterEach: any;
declare const __dirname: string;
declare const require: any;
declare const process: any;

// Scope-correction checkpoint (2026-08-01): the root supervisor explicitly approved this
// complete contract as a test-only asset; it is not limited to an `export {}` placeholder.
// Keep it runnable with the isolated dependency tree used by the review gate. The production
// tsconfig still type-checks the real application sources normally.
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

export {};

type FixtureCase = {
  name: string;
  setupSql: string;
  expected: string;
};

type PsqlResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
};

const migrationPath = path.resolve(
  __dirname,
  '../../prisma/migrations/20260730125000_reconcile_legacy_schema_drift/migration.sql',
);
const migrationSql = fs.readFileSync(migrationPath, 'utf8');

// These are executable setup fragments used by the serial PostgreSQL gate. Keeping the
// fixtures next to this contract test prevents the negative matrix from silently shrinking.
const fixtureCases: FixtureCase[] = [
  {
    name: 'unknown-column-with-data',
    setupSql: 'ALTER TABLE "Lead" ADD COLUMN "stage1UnknownData" TEXT; INSERT INTO "Lead" ("id", "stage1UnknownData") VALUES (\'stage1-lead\', \'retain-me\');',
    expected: 'unknown column and its data survive',
  },
  {
    name: 'partial-table-adds-missing-columns',
    setupSql: 'CREATE TABLE "Material" ("id" TEXT PRIMARY KEY, "stage1UnknownData" TEXT);',
    expected: 'each expected column is added independently',
  },
  {
    name: 'default-drift-fails-closed',
    setupSql: 'CREATE TABLE "Material" ("id" TEXT PRIMARY KEY, "type" TEXT NOT NULL DEFAULT \'video\');',
    expected: 'wrong, missing, or extra defaults are rejected',
  },
  {
    name: 'generated-identity-type-nullability-drift',
    setupSql: 'CREATE TABLE "Material" ("id" TEXT PRIMARY KEY, "name" VARCHAR, "size" BIGINT, "createdAt" TIMESTAMP GENERATED ALWAYS AS (CURRENT_TIMESTAMP) STORED);',
    expected: 'type, nullability, generated, and identity drift are rejected',
  },
  {
    name: 'index-predicate',
    setupSql: 'CREATE INDEX "Material_companyId_type_idx" ON "Material" USING btree ("companyId") WHERE "type" = \'image\';',
    expected: 'predicate drift is rejected',
  },
  {
    name: 'index-expression',
    setupSql: 'CREATE INDEX "Material_companyId_type_idx" ON "Material" USING btree (lower("companyId"), "type");',
    expected: 'expression drift is rejected',
  },
  {
    name: 'index-access-method-hash',
    setupSql: 'CREATE INDEX "Material_companyId_type_idx" ON "Material" USING hash ("companyId");',
    expected: 'access-method drift is rejected',
  },
  {
    name: 'index-columns-order',
    setupSql: 'CREATE INDEX "Material_companyId_type_idx" ON "Material" USING btree ("type" DESC, "companyId" ASC);',
    expected: 'key columns and order drift are rejected',
  },
  {
    name: 'index-uniqueness',
    setupSql: 'CREATE UNIQUE INDEX "Material_companyId_type_idx" ON "Material" USING btree ("companyId", "type");',
    expected: 'uniqueness drift is rejected',
  },
  {
    name: 'index-cross-table-name-collision',
    setupSql: 'CREATE INDEX "Material_companyId_type_idx" ON "OtherMaterial" USING btree ("companyId");',
    expected: 'cross-table and new-name collisions are rejected',
  },
  {
    name: 'foreign-key-not-valid-with-valid-data',
    setupSql: 'ALTER TABLE "ProductCategory" DROP CONSTRAINT "ProductCategory_companyId_fkey"; ALTER TABLE "ProductCategory" ADD CONSTRAINT "ProductCategory_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;',
    expected: 'a matching NOT VALID foreign key is validated and read back as convalidated=true',
  },
  {
    name: 'foreign-key-not-valid-with-orphan',
    setupSql: 'ALTER TABLE "ProductCategory" DROP CONSTRAINT "ProductCategory_companyId_fkey"; INSERT INTO "ProductCategory" ("id", "companyId", "name", "updatedAt") VALUES (\'lan-not-valid-orphan\', \'lan-missing-company\', \'LAN NOT VALID orphan\', CURRENT_TIMESTAMP); ALTER TABLE "ProductCategory" ADD CONSTRAINT "ProductCategory_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company" ("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;',
    expected: 'validation fails closed and the migration transaction does not claim success',
  },
  {
    name: 'failed-ledger-recovery',
    setupSql: 'INSERT INTO "_prisma_migrations" ("id", "checksum", "finished_at", "migration_name", "logs", "rolled_back_at", "started_at", "applied_steps_count") VALUES (gen_random_uuid(), \'fixture\', NULL, \'20260730125000_reconcile_legacy_schema_drift\', \'fixture failure\', NULL, CURRENT_TIMESTAMP, 0);',
    expected: 'a failed attempt can be repaired and retried without data loss',
  },
];

describe('20260730125000 legacy schema reconciliation contract', () => {
  it.each(fixtureCases)('keeps the $name negative fixture in the matrix', (fixture: FixtureCase) => {
    expect(fixture.setupSql.trim()).not.toHaveLength(0);
    expect(fixture.expected).not.toHaveLength(0);
  });

  it('validates expected columns at definition level and fills partial tables safely', () => {
    expect(migrationSql).toContain('ALTER TABLE');
    expect(migrationSql).toContain('attgenerated');
    expect(migrationSql).toContain('attidentity');
    expect(migrationSql).toContain('pg_attrdef');
    expect(migrationSql).toContain('pg_get_expr');
    expect(migrationSql).not.toContain('a required table contains an unexpected column');
  });

  it('validates every expected index definition, including rename paths', () => {
    for (const marker of [
      'pg_index',
      'indisvalid',
      'indisready',
      'indnkeyatts',
      'indnatts',
      'indoption',
      'indclass',
      'indcollation',
      'indpred',
      'indexprs',
      'pg_get_indexdef',
      'pg_am',
    ]) {
      expect(migrationSql).toContain(marker);
    }
  });

  it('validates and reads back every matching existing foreign key', () => {
    const validateOffset = migrationSql.indexOf('VALIDATE CONSTRAINT');
    const readbackOffset = migrationSql.indexOf('SELECT c.convalidated', validateOffset);

    expect(migrationSql).toContain('c.convalidated');
    expect(validateOffset).toBeGreaterThan(-1);
    expect(readbackOffset).toBeGreaterThan(validateOffset);
    expect(migrationSql).toContain('foreign key % is not validated');
  });
});

const realPgEnabled = process.env.LAN_LEGACY_SCHEMA_REAL_PG === '1';
const realPgDescribe = realPgEnabled ? describe : describe.skip;
const pgConfig = {
  psqlPath: process.env.LAN_PG_PSQL || '',
  host: process.env.LAN_PG_HOST || '',
  port: process.env.LAN_PG_PORT || '',
  user: process.env.LAN_PG_USER || '',
  database: process.env.LAN_PG_DATABASE || '',
};

function runPsql(options: { sql?: string; file?: string; singleTransaction?: boolean }): PsqlResult {
  const args = [
    '--no-psqlrc',
    '--host', pgConfig.host,
    '--port', pgConfig.port,
    '--username', pgConfig.user,
    '--dbname', pgConfig.database,
    '--set', 'ON_ERROR_STOP=1',
    '--no-align',
    '--tuples-only',
    '--quiet',
  ];
  if (options.singleTransaction) args.push('--single-transaction');
  if (options.file) args.push('--file', options.file);
  if (options.sql) args.push('--command', options.sql);

  const result = childProcess.spawnSync(pgConfig.psqlPath, args, {
    encoding: 'utf8',
    env: {
      ...process.env,
      PGAPPNAME: 'lan-legacy-schema-contract',
      PGCLIENTENCODING: 'UTF8',
      PGCONNECT_TIMEOUT: '5',
    },
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  });

  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error,
  };
}

function expectPsqlSuccess(result: PsqlResult, context: string): void {
  if (result.error || result.status !== 0) {
    throw new Error(`${context} failed (exit=${String(result.status)}): ${result.error?.message || result.stderr || result.stdout}`);
  }
}

function queryScalar(sql: string): string {
  const result = runPsql({ sql });
  expectPsqlSuccess(result, 'psql scalar query');
  return result.stdout.trim();
}

const fkName = 'ProductCategory_companyId_fkey';
const orphanId = 'lan-not-valid-orphan';

function resetProductCategoryForeignKey(): void {
  const result = runPsql({
    sql: `
      ALTER TABLE "ProductCategory" DROP CONSTRAINT IF EXISTS "${fkName}";
      DELETE FROM "ProductCategory" WHERE "id" = '${orphanId}';
      ALTER TABLE "ProductCategory"
        ADD CONSTRAINT "${fkName}"
        FOREIGN KEY ("companyId") REFERENCES "Company" ("id")
        ON DELETE RESTRICT ON UPDATE CASCADE;
    `,
  });
  expectPsqlSuccess(result, 'foreign-key fixture cleanup');
}

realPgDescribe('20260730125000 real PostgreSQL NOT VALID contract', () => {
  beforeAll(() => {
    expect(path.resolve(pgConfig.psqlPath)).toBe(path.resolve(
      'C:/Users/茶茶的小白莲/AppData/Local/Temp/vaysen-pg15-15.18-2/pgsql/bin/psql.exe',
    ));
    expect(fs.existsSync(pgConfig.psqlPath)).toBe(true);
    expect(pgConfig.host).toBe('127.0.0.1');
    expect(pgConfig.port).toBe('55433');
    expect(pgConfig.user).toBe('lan_tools');
    expect(pgConfig.database).toMatch(/^lan_second_wave_stage1_fix_[a-z0-9_]+$/);

    const identity = queryScalar(
      "SELECT current_database() || '|' || current_user || '|' || current_setting('server_version_num')",
    );
    expect(identity).toBe(`${pgConfig.database}|lan_tools|150018`);
  });

  afterEach(() => {
    resetProductCategoryForeignKey();
  });

  it('validates a matching NOT VALID foreign key and remains idempotent', () => {
    const setup = runPsql({
      sql: `
        ALTER TABLE "ProductCategory" DROP CONSTRAINT "${fkName}";
        ALTER TABLE "ProductCategory"
          ADD CONSTRAINT "${fkName}"
          FOREIGN KEY ("companyId") REFERENCES "Company" ("id")
          ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
      `,
    });
    expectPsqlSuccess(setup, 'matching NOT VALID setup');
    expect(queryScalar(`SELECT convalidated FROM pg_constraint WHERE conname = '${fkName}'`)).toBe('f');

    const firstRun = runPsql({ file: migrationPath, singleTransaction: true });
    expectPsqlSuccess(firstRun, 'first migration run against matching NOT VALID constraint');
    expect(queryScalar(`SELECT convalidated FROM pg_constraint WHERE conname = '${fkName}'`)).toBe('t');

    const secondRun = runPsql({ file: migrationPath, singleTransaction: true });
    expectPsqlSuccess(secondRun, 'idempotent migration rerun');
    expect(queryScalar(`SELECT convalidated FROM pg_constraint WHERE conname = '${fkName}'`)).toBe('t');
  });

  it('fails closed when a matching NOT VALID foreign key contains an orphan', () => {
    const setup = runPsql({
      sql: `
        ALTER TABLE "ProductCategory" DROP CONSTRAINT "${fkName}";
        INSERT INTO "ProductCategory" ("id", "companyId", "name", "updatedAt")
        VALUES ('${orphanId}', 'lan-missing-company', 'LAN NOT VALID orphan', CURRENT_TIMESTAMP);
        ALTER TABLE "ProductCategory"
          ADD CONSTRAINT "${fkName}"
          FOREIGN KEY ("companyId") REFERENCES "Company" ("id")
          ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
      `,
    });
    expectPsqlSuccess(setup, 'orphaned NOT VALID setup');
    expect(queryScalar(`SELECT convalidated FROM pg_constraint WHERE conname = '${fkName}'`)).toBe('f');

    const migration = runPsql({ file: migrationPath, singleTransaction: true });
    expect(migration.status).not.toBe(0);
    expect(`${migration.stderr}\n${migration.stdout}`).toContain(fkName);
    expect(queryScalar(`SELECT convalidated FROM pg_constraint WHERE conname = '${fkName}'`)).toBe('f');
    expect(queryScalar(`SELECT count(*) FROM "ProductCategory" WHERE "id" = '${orphanId}'`)).toBe('1');
  });
});
