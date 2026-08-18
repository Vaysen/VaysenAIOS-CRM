import { HttpException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { CurrentUser } from '../../common/utils/data-isolation';
import {
  assertRealPgIdentity,
  assertRealPgSwitchEnabled,
  parseRealPgDatabaseUrl,
  type RealPgExpectedIdentity,
} from '../../../test/real-pg-safety';
import { OpportunitiesService } from './opportunities.service';

const OPPORTUNITIES_REAL_PG_ENV = 'LAN_OPPORTUNITIES_REAL_PG';
const realPgEnabled = process.env[OPPORTUNITIES_REAL_PG_ENV] === '1';
const realPgDescribe = realPgEnabled ? describe : describe.skip;

realPgDescribe('real PostgreSQL Opportunity transaction and isolation contract', () => {
  jest.setTimeout(120000);

  const companyId = '11111111-1111-4111-8111-111111111121';
  const otherCompanyId = '11111111-1111-4111-8111-111111111122';
  const adminUserId = '22222222-2222-4222-8222-222222222221';
  const otherUserId = '22222222-2222-4222-8222-222222222222';
  const leadId = '33333333-3333-4333-8333-333333333321';
  const otherLeadId = '33333333-3333-4333-8333-333333333322';
  const firstContactId = '44444444-4444-4444-8444-444444444421';
  const secondContactId = '44444444-4444-4444-8444-444444444422';
  const otherContactId = '44444444-4444-4444-8444-444444444423';
  const admin: CurrentUser = {
    id: adminUserId,
    activeCompanyId: companyId,
    activeCompany: { id: companyId, role: 'company_admin' },
    companies: [{ id: companyId, role: 'company_admin' }],
  };

  let prisma: PrismaService;
  let service: OpportunitiesService;
  let expectedIdentity: RealPgExpectedIdentity;
  let opportunityId: string;

  beforeAll(async () => {
    assertRealPgSwitchEnabled(OPPORTUNITIES_REAL_PG_ENV);
    expectedIdentity = parseRealPgDatabaseUrl(process.env.DATABASE_URL);
    prisma = new PrismaService();
    await prisma.$connect();

    const [identity] = await prisma.$queryRaw<Array<{
      currentDatabase: string | null;
      currentUser: string | null;
      serverAddr: string | null;
      serverPort: number | string | null;
    }>>`
      SELECT
        current_database() AS "currentDatabase",
        current_user AS "currentUser",
        inet_server_addr()::text AS "serverAddr",
        inet_server_port() AS "serverPort"
    `;
    assertRealPgIdentity(expectedIdentity, identity);

    const [pristine] = await prisma.$queryRaw<Array<{
      companyCount: bigint;
      userCount: bigint;
      roleCount: bigint;
    }>>`
      SELECT
        (SELECT count(*) FROM "Company") AS "companyCount",
        (SELECT count(*) FROM "User") AS "userCount",
        (SELECT count(*) FROM "Role") AS "roleCount"
    `;
    if (pristine.companyCount !== 0n || pristine.userCount !== 0n || pristine.roleCount !== 0n) {
      throw new Error('Opportunity real PostgreSQL database must be pristine');
    }

    const role = await prisma.role.create({
      data: { name: 'company_admin', displayName: 'Company Admin', isSystem: true },
    });
    await prisma.company.createMany({
      data: [
        { id: companyId, name: 'Synthetic Test Company', slug: 'opportunity-test-company' },
        { id: otherCompanyId, name: 'Synthetic Other Company', slug: 'opportunity-other-company' },
      ],
    });
    await prisma.user.createMany({
      data: [
        {
          id: adminUserId,
          email: 'opportunity-admin@example.test',
          passwordHash: 'test-only',
          firstName: 'Test',
          lastName: 'Admin',
        },
        {
          id: otherUserId,
          email: 'opportunity-other@example.test',
          passwordHash: 'test-only',
          firstName: 'Test',
          lastName: 'Other',
        },
      ],
    });
    await prisma.userCompanyRelation.create({
      data: { userId: adminUserId, companyId, roleId: role.id, isDefault: true },
    });
    await prisma.lead.createMany({
      data: [
        {
          id: leadId,
          companyId,
          companyName: 'Synthetic Buyer',
          contactName: 'Test Buyer',
          status: 'qualified',
          reviewStatus: 'approved',
          ownerUserId: adminUserId,
        },
        {
          id: otherLeadId,
          companyId: otherCompanyId,
          companyName: 'Synthetic Other Buyer',
          status: 'qualified',
          reviewStatus: 'approved',
          ownerUserId: otherUserId,
        },
      ],
    });
    await prisma.contact.createMany({
      data: [
        { id: firstContactId, companyId, leadId, displayName: 'First Test Contact' },
        { id: secondContactId, companyId, leadId, displayName: 'Second Test Contact' },
        { id: otherContactId, companyId: otherCompanyId, leadId: otherLeadId, displayName: 'Other Test Contact' },
      ],
    });

    service = new OpportunitiesService(prisma);
  });

  afterAll(async () => {
    try {
      if (prisma && expectedIdentity) {
        const [identity] = await prisma.$queryRaw<Array<{
          currentDatabase: string | null;
          currentUser: string | null;
          serverAddr: string | null;
          serverPort: number | string | null;
        }>>`
          SELECT
            current_database() AS "currentDatabase",
            current_user AS "currentUser",
            inet_server_addr()::text AS "serverAddr",
            inet_server_port() AS "serverPort"
        `;
        assertRealPgIdentity(expectedIdentity, identity);
        await prisma.$executeRawUnsafe('TRUNCATE TABLE "Company", "User", "Role" CASCADE');
      }
    } finally {
      await prisma?.$disconnect();
    }
  });

  it('creates an Opportunity and its initial history atomically on the real schema', async () => {
    const created = await service.create({
      leadId,
      name: 'Synthetic Opportunity',
      amount: '1234.56',
      currency: 'USD',
    }, admin);

    opportunityId = created.id;
    expect(created).toMatchObject({
      leadId,
      name: 'Synthetic Opportunity',
      stage: 'new',
      amount: '1234.56',
      currency: 'USD',
      probability: 10,
      version: 1,
    });
    expect(created.lead).toMatchObject({ id: leadId, companyName: 'Synthetic Buyer' });
    expect(created.owner).toMatchObject({ id: adminUserId, displayName: 'Test Admin' });

    const rows = await prisma.opportunityStageHistory.findMany({
      where: { opportunityId },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ fromStage: null, toStage: 'new', source: 'USER' });
  });

  it('rejects a cross-tenant Lead before creating an Opportunity', async () => {
    await expect(service.create({
      leadId: otherLeadId,
      name: 'Cross tenant should fail',
    }, admin)).rejects.toMatchObject({ status: 400 });

    expect(await prisma.opportunity.count({ where: { companyId, leadId: otherLeadId } })).toBe(0);
  });

  it('allows exactly one winner for concurrent version-CAS updates', async () => {
    const results = await Promise.allSettled([
      service.update(opportunityId, { name: 'CAS winner A', version: 1 }, admin),
      service.update(opportunityId, { name: 'CAS winner B', version: 1 }, admin),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.filter((result) => result.status === 'rejected') as PromiseRejectedResult[];

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(httpStatus(rejected[0].reason)).toBe(409);

    const stored = await prisma.opportunity.findUniqueOrThrow({ where: { id: opportunityId } });
    expect(stored.version).toBe(2);
    expect(['CAS winner A', 'CAS winner B']).toContain(stored.name);
  });

  it('keeps one primary contact under concurrent real PostgreSQL writes', async () => {
    const results = await Promise.allSettled([
      service.addContactRole(opportunityId, {
        contactId: firstContactId,
        roleType: 'decision_maker',
        isPrimary: true,
      }, admin),
      service.addContactRole(opportunityId, {
        contactId: secondContactId,
        roleType: 'buyer',
        isPrimary: true,
      }, admin),
    ]);

    for (const result of results) {
      if (result.status === 'rejected') expect(httpStatus(result.reason)).toBe(409);
    }
    expect(results.some((result) => result.status === 'fulfilled')).toBe(true);
    expect(await prisma.opportunityContactRole.count({ where: { opportunityId, isPrimary: true } })).toBe(1);
    expect(await prisma.opportunityContactRole.count({ where: { opportunityId } })).toBeGreaterThanOrEqual(1);
  });

  it('rejects a contact attached to another tenant and Lead', async () => {
    await expect(service.addContactRole(opportunityId, {
      contactId: otherContactId,
      roleType: 'buyer',
      isPrimary: false,
    }, admin)).rejects.toMatchObject({ status: 400 });
    expect(await prisma.opportunityContactRole.count({ where: { opportunityId, contactId: otherContactId } })).toBe(0);
  });

  it('rolls the stage/version update back when history persistence fails', async () => {
    const before = await prisma.opportunity.findUniqueOrThrow({ where: { id: opportunityId } });
    const historyBefore = await prisma.opportunityStageHistory.count({ where: { opportunityId } });

    await prisma.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION "crm_test_fail_opportunity_history"()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'synthetic history failure';
      END;
      $$ LANGUAGE plpgsql
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "crm_test_fail_opportunity_history_trigger"
      BEFORE INSERT ON "OpportunityStageHistory"
      FOR EACH ROW EXECUTE FUNCTION "crm_test_fail_opportunity_history"();
    `);

    try {
      await expect(service.transition(opportunityId, {
        stage: 'discovery',
        version: before.version,
      }, admin)).rejects.toMatchObject({ status: 500 });
    } finally {
      await prisma.$executeRawUnsafe(
        'DROP TRIGGER IF EXISTS "crm_test_fail_opportunity_history_trigger" ON "OpportunityStageHistory"',
      );
      await prisma.$executeRawUnsafe('DROP FUNCTION IF EXISTS "crm_test_fail_opportunity_history"()');
    }

    const after = await prisma.opportunity.findUniqueOrThrow({ where: { id: opportunityId } });
    expect(after.stage).toBe(before.stage);
    expect(after.version).toBe(before.version);
    expect(await prisma.opportunityStageHistory.count({ where: { opportunityId } })).toBe(historyBefore);
  });
});

function httpStatus(error: unknown): number | undefined {
  return error instanceof HttpException ? error.getStatus() : (error as { status?: number } | null)?.status;
}
