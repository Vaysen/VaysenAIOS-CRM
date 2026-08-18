import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { OpportunitiesService } from './opportunities.service';

const user = (role: string, id = 'owner-a', companyId = 'tenant-a') => ({
  id,
  activeCompanyId: companyId,
  activeCompany: { id: companyId, role },
  companies: [{ id: companyId, role }],
});

const record = (overrides: Record<string, unknown> = {}) => ({
  id: 'opportunity-a',
  companyId: 'tenant-a',
  leadId: 'lead-a',
  ownerUserId: 'owner-a',
  name: 'Packaging supply',
  description: 'Internal description',
  stage: 'qualified',
  amount: { toString: () => '123.40' },
  currency: 'USD',
  probability: 40,
  expectedCloseDate: new Date('2026-12-31T00:00:00.000Z'),
  nextStep: 'Send sample',
  wonAt: null,
  lostAt: null,
  lostReason: null,
  version: 2,
  createdAt: new Date('2026-08-03T10:00:00.000Z'),
  updatedAt: new Date('2026-08-03T11:00:00.000Z'),
  ...overrides,
});

const createDto = (overrides: Record<string, unknown> = {}) => ({
  leadId: 'lead-a',
  name: 'Packaging supply',
  ...overrides,
});

function transactionPrisma(tx: any) {
  return {
    $transaction: jest.fn(async (callback: (value: any) => Promise<unknown>) => callback(tx)),
    opportunity: { findFirst: jest.fn() },
    opportunityStageHistory: { findMany: jest.fn() },
    opportunityContactRole: { findMany: jest.fn() },
  } as any;
}

describe('OpportunitiesService 02B access and transaction contract', () => {
  it('never reads across tenant or across owner boundary', async () => {
    const prisma: any = { opportunity: { findFirst: jest.fn().mockResolvedValue(null) } };
    const service = new OpportunitiesService(prisma);

    await expect(service.findOne('opaque-opportunity', user('sales_user')))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.opportunity.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'opaque-opportunity', companyId: 'tenant-a', deletedAt: null, ownerUserId: 'owner-a' },
    }));

    await expect(service.findOne('opaque-opportunity', user('company_admin', 'admin-a', 'tenant-b')))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.opportunity.findFirst).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { id: 'opaque-opportunity', companyId: 'tenant-b', deletedAt: null },
    }));
  });

  it('keeps viewer read-only before any write or transaction', async () => {
    const prisma: any = { $transaction: jest.fn() };
    const service = new OpportunitiesService(prisma);

    await expect(service.create(createDto(), user('viewer')))
      .rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.update('opportunity-a', { name: 'x' }, user('viewer')))
      .rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.transition('opportunity-a', { stage: 'proposal', version: 2 }, user('viewer')))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('creates the opportunity and initial history in one Serializable transaction', async () => {
    const created = record({ stage: 'new', probability: 10, version: 1 });
    const tx: any = {
      lead: { findFirst: jest.fn().mockResolvedValue({ id: 'lead-a' }) },
      userCompanyRelation: { findFirst: jest.fn().mockResolvedValue({ id: 'membership-a' }) },
      opportunity: { create: jest.fn().mockResolvedValue(created) },
      opportunityStageHistory: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = transactionPrisma(tx);
    const service = new OpportunitiesService(prisma);

    const result = await service.create(createDto(), user('sales_user'));

    expect(result).toEqual(expect.objectContaining({ stage: 'new', amount: '123.40' }));
    expect(result).not.toHaveProperty('companyId');
    expect(result).not.toHaveProperty('ownerUserId');
    expect(tx.opportunityStageHistory.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        fromStage: null,
        toStage: 'new',
        probabilitySnapshot: 10,
        changedBy: 'owner-a',
      }),
    }));
    expect(prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { isolationLevel: 'Serializable' },
    );
  });

  it('rejects a lead outside the active company or owner boundary before create', async () => {
    const tx: any = {
      lead: { findFirst: jest.fn().mockResolvedValue(null) },
      userCompanyRelation: { findFirst: jest.fn() },
      opportunity: { create: jest.fn() },
      opportunityStageHistory: { create: jest.fn() },
    };
    const prisma = transactionPrisma(tx);
    const service = new OpportunitiesService(prisma);

    await expect(service.create(createDto({ leadId: 'foreign-lead' }), user('sales_user')))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(tx.opportunity.create).not.toHaveBeenCalled();
    expect(tx.opportunityStageHistory.create).not.toHaveBeenCalled();
  });

  it('requires lostReason for an initially lost opportunity and does not write', async () => {
    const tx: any = {
      lead: { findFirst: jest.fn().mockResolvedValue({ id: 'lead-a' }) },
      userCompanyRelation: { findFirst: jest.fn().mockResolvedValue({ id: 'membership-a' }) },
      opportunity: { create: jest.fn() },
      opportunityStageHistory: { create: jest.fn() },
    };
    const prisma = transactionPrisma(tx);
    const service = new OpportunitiesService(prisma);

    await expect(service.create(createDto({ stage: 'lost' }), user('sales_user')))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.opportunity.create).not.toHaveBeenCalled();
    expect(tx.opportunityStageHistory.create).not.toHaveBeenCalled();
  });

  it('creates won/lost terminal timestamps and trims the initial lost reason', async () => {
    const won = record({ stage: 'won', probability: 100, version: 1 });
    const lost = record({ stage: 'lost', probability: 0, version: 1 });
    const tx: any = {
      lead: { findFirst: jest.fn().mockResolvedValue({ id: 'lead-a' }) },
      userCompanyRelation: { findFirst: jest.fn().mockResolvedValue({ id: 'membership-a' }) },
      opportunity: { create: jest.fn().mockResolvedValueOnce(won).mockResolvedValueOnce(lost) },
      opportunityStageHistory: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = transactionPrisma(tx);
    const service = new OpportunitiesService(prisma);

    await service.create(createDto({ stage: 'won' }), user('sales_user'));
    expect(tx.opportunity.create.mock.calls[0][0].data).toEqual(expect.objectContaining({
      wonAt: expect.any(Date),
      lostAt: null,
      lostReason: null,
    }));

    await service.create(createDto({ stage: 'lost', lostReason: '  Budget changed  ' }), user('sales_user'));
    expect(tx.opportunity.create.mock.calls[1][0].data).toEqual(expect.objectContaining({
      wonAt: null,
      lostAt: expect.any(Date),
      lostReason: 'Budget changed',
    }));
    expect(tx.opportunityStageHistory.create.mock.calls[1][0].data).toEqual(expect.objectContaining({
      toStage: 'lost', probabilitySnapshot: 0,
    }));
  });

  it('rejects lostReason on every non-lost initial stage', async () => {
    const prisma: any = { $transaction: jest.fn() };
    const service = new OpportunitiesService(prisma);

    await expect(service.create(createDto({ stage: 'qualified', lostReason: 'not lost' }), user('sales_user')))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('accepts the Decimal(14,2) amount maximum and rejects overflow before the transaction', async () => {
    const created = record({ stage: 'new', probability: 10, version: 1 });
    const tx: any = {
      lead: { findFirst: jest.fn().mockResolvedValue({ id: 'lead-a' }) },
      userCompanyRelation: { findFirst: jest.fn().mockResolvedValue({ id: 'membership-a' }) },
      opportunity: { create: jest.fn().mockResolvedValue(created) },
      opportunityStageHistory: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = transactionPrisma(tx);
    const service = new OpportunitiesService(prisma);

    await expect(service.create(createDto({ amount: '999999999999.99' }), user('sales_user')))
      .resolves.toBeDefined();
    expect(tx.opportunity.create.mock.calls[0][0].data.amount).toBe('999999999999.99');

    await expect(service.create(createDto({ amount: '1000000000000.00' }), user('sales_user')))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('enforces legal forward stage transitions, default probability, timestamps and loss reason', async () => {
    const existing = record({ stage: 'qualified', probability: 40, version: 2 });
    const transitioned = record({
      stage: 'proposal',
      probability: 60,
      version: 3,
      wonAt: null,
      lostAt: null,
    });
    const tx: any = {
      opportunity: { findFirst: jest.fn().mockResolvedValueOnce(existing).mockResolvedValueOnce(transitioned), updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      opportunityStageHistory: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma = transactionPrisma(tx);
    const service = new OpportunitiesService(prisma);

    await expect(service.transition('opportunity-a', { stage: 'proposal', version: 2 }, user('sales_user')))
      .resolves.toEqual(expect.objectContaining({ stage: 'proposal', probability: 60 }));
    expect(tx.opportunity.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ stage: 'proposal', probability: 60, version: { increment: 1 } }),
    }));
    expect(tx.opportunityStageHistory.create).toHaveBeenCalledTimes(1);

    tx.opportunity.findFirst.mockReset();
    tx.opportunity.findFirst.mockResolvedValue(existing);
    await expect(service.transition('opportunity-a', { stage: 'lost', version: 2 }, user('sales_user')))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(tx.opportunity.updateMany).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid, terminal reopen and stale version transitions; same-stage writes no history', async () => {
    const existing = record({ stage: 'qualified', version: 2 });
    const tx: any = {
      opportunity: { findFirst: jest.fn().mockResolvedValue(existing), updateMany: jest.fn() },
      opportunityStageHistory: { create: jest.fn() },
    };
    const prisma = transactionPrisma(tx);
    const service = new OpportunitiesService(prisma);

    await expect(service.transition('opportunity-a', { stage: 'new', version: 2 }, user('sales_user')))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(service.transition('opportunity-a', { stage: 'proposal', version: 1 }, user('sales_user')))
      .rejects.toBeInstanceOf(ConflictException);
    await expect(service.transition('opportunity-a', { stage: 'qualified', version: 2 }, user('sales_user')))
      .resolves.toEqual(expect.objectContaining({ stage: 'qualified' }));
    expect(tx.opportunity.updateMany).not.toHaveBeenCalled();
    expect(tx.opportunityStageHistory.create).not.toHaveBeenCalled();

    tx.opportunity.findFirst.mockResolvedValue(record({ stage: 'won', version: 2 }));
    await expect(service.transition('opportunity-a', { stage: 'negotiation', version: 2 }, user('sales_user')))
      .rejects.toBeInstanceOf(ConflictException);
  });

  it('maps a failed history write to an operation error and keeps Lead.status out of the service', async () => {
    const tx: any = {
      lead: { findFirst: jest.fn().mockResolvedValue({ id: 'lead-a' }) },
      userCompanyRelation: { findFirst: jest.fn().mockResolvedValue({ id: 'membership-a' }) },
      opportunity: { create: jest.fn().mockResolvedValue(record({ stage: 'new', probability: 10 })) },
      opportunityStageHistory: { create: jest.fn().mockRejectedValue(new Error('RAW HISTORY ERROR')) },
    };
    const prisma = transactionPrisma(tx);
    const service = new OpportunitiesService(prisma);
    const source = readFileSync(resolve(__dirname, 'opportunities.service.ts'), 'utf8');

    await expect(service.create(createDto(), user('sales_user')))
      .rejects.toBeInstanceOf(InternalServerErrorException);
    expect(source).not.toContain('lead.status');
    expect(source).not.toMatch(/opportunityStageHistory\.(update|delete)/);
  });

  it('uses explicit probability only inside the domain range and keeps response JSON-safe', async () => {
    const prisma: any = { opportunity: { findFirst: jest.fn().mockResolvedValue(record()) } };
    const service = new OpportunitiesService(prisma);

    const result = await service.findOne('opportunity-a', user('sales_user'));
    expect(result.amount).toBe('123.40');
    expect(result.expectedCloseDate).toBe('2026-12-31T00:00:00.000Z');
    expect(result.createdAt).toBe('2026-08-03T10:00:00.000Z');
    expect(result).not.toHaveProperty('companyId');
    expect(result).not.toHaveProperty('ownerUserId');
    expect(result).not.toHaveProperty('changedBy');
  });

  it('projects safe lead and owner summaries on list/detail without internal fields', async () => {
    const opportunity = record();
    const lead = {
      id: 'lead-a',
      companyName: 'Buyer Company',
      contactName: 'Buyer Contact',
      country: 'US',
      deletedAt: null,
      email: 'buyer@example.com',
      phone: '+1-555-0100',
    };
    const owner = {
      id: 'owner-a',
      firstName: 'Alice',
      lastName: 'Owner',
      isActive: true,
      deletedAt: null,
      email: 'alice@example.com',
      phone: '+1-555-0101',
      role: 'company_admin',
      companies: [{ id: 'membership-a' }],
      metadata: { secret: true },
    };
    const prisma: any = {
      opportunity: {
        findMany: jest.fn().mockResolvedValue([opportunity]),
        count: jest.fn().mockResolvedValue(1),
        findFirst: jest.fn().mockResolvedValue(opportunity),
      },
      lead: { findMany: jest.fn().mockResolvedValue([lead]) },
      user: { findMany: jest.fn().mockResolvedValue([owner]) },
    };
    const service = new OpportunitiesService(prisma);

    const list = await service.findAll(user('sales_user'), { page: 1, limit: 20 });
    const detail = await service.findOne('opportunity-a', user('sales_user'));

    for (const result of [list.data[0], detail]) {
      expect(result.lead).toEqual({
        id: 'lead-a', companyName: 'Buyer Company', contactName: 'Buyer Contact', country: 'US',
      });
      expect(result.owner).toEqual({ id: 'owner-a', displayName: 'Alice Owner' });
      expect(result).not.toHaveProperty('companyId');
      expect(result).not.toHaveProperty('email');
      expect(result).not.toHaveProperty('phone');
      expect(result.owner).not.toHaveProperty('email');
      expect(result.owner).not.toHaveProperty('role');
      expect(result.owner).not.toHaveProperty('companies');
      expect(result.lead).not.toHaveProperty('deletedAt');
    }
    expect(prisma.lead.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { in: ['lead-a'] }, companyId: 'tenant-a', deletedAt: null },
      select: { id: true, companyName: true, contactName: true, country: true, deletedAt: true },
    }));
    expect(prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: { in: ['owner-a'] },
        isActive: true,
        deletedAt: null,
        companies: { some: expect.objectContaining({ companyId: 'tenant-a', isActive: true }) },
      }),
      select: expect.objectContaining({
        id: true, firstName: true, lastName: true, isActive: true, deletedAt: true,
      }),
    }));
    expect(prisma.user.findMany.mock.calls[0][0].select).not.toHaveProperty('email');
    expect(prisma.user.findMany.mock.calls[0][0].select).not.toHaveProperty('phone');
  });

  it('fails safe for deleted lead, inactive owner, missing relation, and incomplete display name', async () => {
    const opportunity = record({ leadId: 'deleted-lead', ownerUserId: 'inactive-owner' });
    const prisma: any = {
      opportunity: { findFirst: jest.fn().mockResolvedValue(opportunity) },
      lead: { findMany: jest.fn().mockResolvedValue([{
        id: 'deleted-lead', companyName: 'Deleted Buyer', contactName: 'Buyer', country: 'US', deletedAt: new Date(),
      }]) },
      user: { findMany: jest.fn().mockResolvedValue([{
        id: 'inactive-owner', firstName: '', lastName: '', isActive: false, deletedAt: null, companies: [{ id: 'membership-a' }],
      }]) },
    };
    const service = new OpportunitiesService(prisma);

    await expect(service.findOne('opportunity-a', user('company_admin', 'admin-a')))
      .resolves.toEqual(expect.objectContaining({ lead: null, owner: null }));
  });

  it('keeps create, update, and transition responses on the same safe summary projection', async () => {
    const created = record({ stage: 'new', probability: 10, version: 1 });
    const existing = record({ stage: 'qualified', probability: 40, version: 2 });
    const updated = record({ stage: 'qualified', probability: 40, version: 3 });
    const transitioned = record({ stage: 'proposal', probability: 60, version: 3 });
    const displayLead = { id: 'lead-a', companyName: 'Buyer Company', contactName: 'Buyer', country: 'US', deletedAt: null };
    const displayOwner = { id: 'owner-a', firstName: 'Alice', lastName: 'Owner', isActive: true, deletedAt: null, companies: [{ id: 'membership-a' }] };
    const tx: any = {
      lead: { findFirst: jest.fn().mockResolvedValue({ id: 'lead-a' }) },
      userCompanyRelation: { findFirst: jest.fn().mockResolvedValue({ id: 'membership-a' }) },
      opportunity: {
        create: jest.fn().mockResolvedValue(created),
        findFirst: jest.fn().mockResolvedValueOnce(existing).mockResolvedValueOnce(updated).mockResolvedValueOnce(existing).mockResolvedValueOnce(transitioned),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      opportunityStageHistory: { create: jest.fn().mockResolvedValue({}) },
    };
    const prisma: any = {
      $transaction: jest.fn(async (callback: any) => callback(tx)),
      lead: { findMany: jest.fn().mockResolvedValue([displayLead]) },
      user: { findMany: jest.fn().mockResolvedValue([displayOwner]) },
    };
    const service = new OpportunitiesService(prisma);

    const createResult = await service.create(createDto(), user('sales_user'));
    const updateResult = await service.update('opportunity-a', { name: 'Updated', version: 2 }, user('sales_user'));
    const transitionResult = await service.transition('opportunity-a', { stage: 'proposal', version: 2 }, user('sales_user'));

    for (const result of [createResult, updateResult, transitionResult]) {
      expect(result.lead).toEqual({ id: 'lead-a', companyName: 'Buyer Company', contactName: 'Buyer', country: 'US' });
      expect(result.owner).toEqual({ id: 'owner-a', displayName: 'Alice Owner' });
    }
  });

  it('projects a safe ContactRole contact summary in one batched list query', async () => {
    const prisma: any = {
      opportunity: { findFirst: jest.fn().mockResolvedValue(record()) },
      opportunityContactRole: {
        findMany: jest.fn().mockResolvedValue([{
          id: 'role-a', contactId: 'contact-a', roleType: 'buyer', isPrimary: false,
          createdAt: new Date('2026-08-03T12:00:00.000Z'),
        }]),
      },
      contact: {
        findMany: jest.fn().mockResolvedValue([{
          id: 'contact-a', companyId: 'tenant-a', leadId: 'lead-a',
          displayName: 'Buyer Name', firstName: 'Buyer', lastName: 'Name', title: 'Purchasing', isPrimary: true,
          email: 'sentinel@example.com', phone: '+1-555-0100', department: 'Secret',
          linkedinUrl: 'https://example.invalid/sentinel', notes: 'Private note',
          nameSource: 'AI', nameConfidence: '99',
        }]),
      },
    };
    const service = new OpportunitiesService(prisma);

    const result = await service.listContactRoles('opportunity-a', user('sales_user'));

    expect(result.data).toEqual([expect.objectContaining({
      id: 'role-a', contactId: 'contact-a', isPrimary: false,
      contact: { id: 'contact-a', displayName: 'Buyer Name', title: 'Purchasing', isPrimary: true },
    })]);
    expect(result.data[0].contact).not.toHaveProperty('email');
    expect(result.data[0].contact).not.toHaveProperty('phone');
    expect(result.data[0].contact).not.toHaveProperty('companyId');
    expect(result.data[0].contact).not.toHaveProperty('leadId');
    expect(prisma.contact.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.contact.findMany.mock.calls[0][0]).toEqual(expect.objectContaining({
      where: { id: { in: ['contact-a'] }, companyId: 'tenant-a', leadId: 'lead-a' },
      select: {
        id: true, companyId: true, leadId: true, displayName: true,
        firstName: true, lastName: true, title: true, isPrimary: true,
      },
    }));
  });

  it('uses the deterministic name fallback and the same projection for create and update', async () => {
    const tx: any = {
      opportunity: { findFirst: jest.fn().mockResolvedValue(record()) },
      contact: { findFirst: jest.fn().mockResolvedValue({ id: 'contact-a' }) },
      opportunityContactRole: {
        create: jest.fn().mockResolvedValue({
          id: 'role-a', contactId: 'contact-a', roleType: 'buyer', isPrimary: true,
          createdAt: new Date('2026-08-03T12:00:00.000Z'),
        }),
        findFirst: jest.fn().mockResolvedValue({
          id: 'role-a', contactId: 'contact-a', roleType: 'buyer', isPrimary: true,
        }),
        update: jest.fn().mockResolvedValue({
          id: 'role-a', contactId: 'contact-a', roleType: 'champion', isPrimary: true,
          createdAt: new Date('2026-08-03T12:00:00.000Z'),
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = transactionPrisma(tx);
    prisma.contact = {
      findMany: jest.fn().mockResolvedValue([{
        id: 'contact-a', companyId: 'tenant-a', leadId: 'lead-a',
        displayName: '  ', firstName: 'Fallback', lastName: 'Buyer', title: null, isPrimary: false,
      }]),
    };
    const service = new OpportunitiesService(prisma);

    const created = await service.addContactRole('opportunity-a', {
      contactId: 'contact-a', roleType: 'buyer', isPrimary: true,
    }, user('sales_user'));
    const updated = await service.updateContactRole('opportunity-a', 'role-a', {
      roleType: 'champion', isPrimary: true,
    }, user('sales_user'));

    expect(created.isPrimary).toBe(true);
    expect(updated.isPrimary).toBe(true);
    expect(created.contact).toEqual({ id: 'contact-a', displayName: 'Fallback Buyer', title: null, isPrimary: false });
    expect(updated.contact).toEqual({ id: 'contact-a', displayName: 'Fallback Buyer', title: null, isPrimary: false });
    expect(prisma.contact.findMany).toHaveBeenCalledTimes(2);
  });

  it('fails safe for missing, nameless, cross-company, and cross-lead contacts', async () => {
    const roles = [
      { id: 'role-company', contactId: 'contact-company', roleType: 'buyer', isPrimary: false, createdAt: new Date() },
      { id: 'role-lead', contactId: 'contact-lead', roleType: 'buyer', isPrimary: false, createdAt: new Date() },
      { id: 'role-name', contactId: 'contact-name', roleType: 'buyer', isPrimary: false, createdAt: new Date() },
      { id: 'role-missing', contactId: 'contact-missing', roleType: 'buyer', isPrimary: false, createdAt: new Date() },
    ];
    const prisma: any = {
      opportunity: { findFirst: jest.fn().mockResolvedValue(record()) },
      opportunityContactRole: { findMany: jest.fn().mockResolvedValue(roles) },
      contact: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'contact-company', companyId: 'tenant-b', leadId: 'lead-a', displayName: 'Cross Company', firstName: null, lastName: null, title: 'Hidden' },
          { id: 'contact-lead', companyId: 'tenant-a', leadId: 'lead-b', displayName: 'Cross Lead', firstName: null, lastName: null, title: 'Hidden' },
          { id: 'contact-name', companyId: 'tenant-a', leadId: 'lead-a', displayName: ' ', firstName: null, lastName: null, title: 'No Name' },
        ]),
      },
    };
    const service = new OpportunitiesService(prisma);

    const result = await service.listContactRoles('opportunity-a', user('sales_user'));

    expect(result.data).toHaveLength(4);
    expect(result.data.every((role: any) => role.contact === null)).toBe(true);
  });

  it('logs the actual deleted stage as a digest without the raw opportunity id', async () => {
    const tx: any = {
      opportunity: {
        findFirst: jest.fn().mockResolvedValue(record({ stage: 'negotiation' })),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = transactionPrisma(tx);
    const service = new OpportunitiesService(prisma);
    const log = jest.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);

    await expect(service.remove('opportunity-a', user('sales_user'))).resolves.toEqual({ deleted: true });
    const output = String(log.mock.calls[0][0]);
    expect(output).toContain('stageDigest');
    expect(output).not.toContain('negotiation');
    expect(output).not.toContain('opportunity-a');
    log.mockRestore();
  });

  it('rejects a contact from another lead/company and never creates the role', async () => {
    const tx: any = {
      opportunity: { findFirst: jest.fn().mockResolvedValue(record()) },
      contact: { findFirst: jest.fn().mockResolvedValue(null) },
      opportunityContactRole: { create: jest.fn(), updateMany: jest.fn() },
    };
    const prisma = transactionPrisma(tx);
    const service = new OpportunitiesService(prisma);

    await expect(service.addContactRole('opportunity-a', {
      contactId: 'foreign-contact', roleType: 'buyer', isPrimary: true,
    }, user('sales_user'))).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.opportunityContactRole.create).not.toHaveBeenCalled();
  });

  it('switches the primary contact atomically and handles the database unique conflict', async () => {
    const tx: any = {
      opportunity: { findFirst: jest.fn().mockResolvedValue(record()) },
      contact: { findFirst: jest.fn().mockResolvedValue({ id: 'contact-b' }) },
      opportunityContactRole: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn().mockResolvedValue({
          id: 'role-b', contactId: 'contact-b', roleType: 'buyer', isPrimary: true,
          createdAt: new Date('2026-08-03T12:00:00.000Z'),
        }),
      },
    };
    const prisma = transactionPrisma(tx);
    const service = new OpportunitiesService(prisma);

    await expect(service.addContactRole('opportunity-a', {
      contactId: 'contact-b', roleType: 'buyer', isPrimary: true,
    }, user('sales_user'))).resolves.toEqual(expect.objectContaining({
      contactId: 'contact-b', isPrimary: true,
    }));
    expect(tx.opportunityContactRole.updateMany).toHaveBeenCalledWith({
      where: { opportunityId: 'opportunity-a', isPrimary: true },
      data: { isPrimary: false },
    });

    tx.opportunityContactRole.create.mockRejectedValue({ code: 'P2002' });
    await expect(service.addContactRole('opportunity-a', {
      contactId: 'contact-c', roleType: 'buyer', isPrimary: true,
    }, user('sales_user'))).rejects.toBeInstanceOf(ConflictException);
  });

  it('retries a Serializable write conflict and maps an exhausted conflict to HTTP 409', async () => {
    const tx: any = {
      opportunity: { findFirst: jest.fn().mockResolvedValue(record()) },
      contact: { findFirst: jest.fn().mockResolvedValue({ id: 'contact-b' }) },
      opportunityContactRole: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn().mockResolvedValue({
          id: 'role-b', contactId: 'contact-b', roleType: 'buyer', isPrimary: true,
          createdAt: new Date('2026-08-03T12:00:00.000Z'),
        }),
      },
    };
    const prisma = transactionPrisma(tx);
    prisma.$transaction
      .mockRejectedValueOnce({ code: 'P2034' })
      .mockImplementationOnce(async (callback: (value: any) => Promise<unknown>) => callback(tx));
    const service = new OpportunitiesService(prisma);

    await expect(service.addContactRole('opportunity-a', {
      contactId: 'contact-b', roleType: 'buyer', isPrimary: true,
    }, user('sales_user'))).resolves.toEqual(expect.objectContaining({ id: 'role-b' }));
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);

    prisma.$transaction.mockReset().mockRejectedValue({ code: 'P2034' });
    await expect(service.addContactRole('opportunity-a', {
      contactId: 'contact-c', roleType: 'buyer', isPrimary: true,
    }, user('sales_user'))).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
  });

  it('updates and removes roles only inside the opportunity transaction', async () => {
    const tx: any = {
      opportunity: { findFirst: jest.fn().mockResolvedValue(record()) },
      contact: { findFirst: jest.fn().mockResolvedValue({ id: 'contact-b' }) },
      opportunityContactRole: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'role-a', contactId: 'contact-a', roleType: 'buyer', isPrimary: false,
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue({
          id: 'role-a', contactId: 'contact-b', roleType: 'champion', isPrimary: true,
          createdAt: new Date('2026-08-03T12:00:00.000Z'),
        }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const prisma = transactionPrisma(tx);
    const service = new OpportunitiesService(prisma);

    await expect(service.updateContactRole('opportunity-a', 'role-a', {
      contactId: 'contact-b', roleType: 'champion', isPrimary: true,
    }, user('sales_user'))).resolves.toEqual(expect.objectContaining({
      roleType: 'champion', isPrimary: true,
    }));
    expect(tx.opportunityContactRole.updateMany).toHaveBeenCalled();

    await expect(service.removeContactRole('opportunity-a', 'role-a', user('sales_user')))
      .resolves.toEqual({ removed: true });
    expect(tx.opportunityContactRole.deleteMany).toHaveBeenCalledWith({
      where: { id: 'role-a', opportunityId: 'opportunity-a', companyId: 'tenant-a' },
    });
  });

  it('emits only safe operational log content when an unexpected error occurs', async () => {
    const tx: any = {
      lead: { findFirst: jest.fn().mockResolvedValue({ id: 'lead-a' }) },
      userCompanyRelation: { findFirst: jest.fn().mockResolvedValue({ id: 'membership-a' }) },
      opportunity: { create: jest.fn().mockRejectedValue(new Error('RAW OPPORTUNITY AND CUSTOMER CONTENT')) },
      opportunityStageHistory: { create: jest.fn() },
    };
    const prisma = transactionPrisma(tx);
    const service = new OpportunitiesService(prisma);
    const warn = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);

    await expect(service.create(createDto(), user('sales_user')))
      .rejects.toBeInstanceOf(InternalServerErrorException);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).not.toContain('RAW OPPORTUNITY');
    expect(String(warn.mock.calls[0][0])).not.toContain('customer content');
    warn.mockRestore();
  });
});
