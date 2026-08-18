import { ForbiddenException } from '@nestjs/common';
import { CustomerFactsService } from './customer-facts.service';

const manager = {
  id: 'user-1',
  activeCompanyId: 'company-1',
  activeCompany: { id: 'company-1', role: 'company_admin' },
  companies: [{ id: 'company-1', role: 'company_admin' }],
};

function makePrisma() {
  const tx: any = {
    factSource: { create: jest.fn() },
    factEvidence: { create: jest.fn() },
    customerFactProposal: { create: jest.fn(), updateMany: jest.fn() },
    factCommandReceipt: { create: jest.fn() },
    customerFact: { findMany: jest.fn(), create: jest.fn(), updateMany: jest.fn() },
  };
  return {
    lead: { findFirst: jest.fn() },
    customerFact: { findMany: jest.fn() },
    customerFactProposal: { findMany: jest.fn(), findFirst: jest.fn() },
    $transaction: jest.fn(async (callback: (client: any) => Promise<unknown>) => callback(tx)),
    tx,
  };
}

describe('CustomerFactsService', () => {
  it('creates evidence before a proposal and keeps the proposal unconfirmed', async () => {
    const prisma = makePrisma();
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1' });
    prisma.tx.factSource.create.mockResolvedValue({ id: 'source-1' });
    prisma.tx.factEvidence.create.mockResolvedValue({ id: 'evidence-1' });
    prisma.tx.customerFactProposal.create.mockResolvedValue({ id: 'proposal-1', evidenceLinks: [] });
    const service = new CustomerFactsService(prisma as any);

    await service.createProposal({
      leadId: 'lead-1',
      factKey: 'identity.company_name',
      value: { schemaVersion: 1, type: 'TEXT', value: 'Example Packaging' },
      sourceTitle: 'Company website',
      sourceUri: 'https://example.com/about',
      excerpt: 'Example Packaging manufactures flexible packaging products.',
      locator: 'selector:section#about',
    }, manager as any);

    expect(prisma.tx.factSource.create.mock.invocationCallOrder[0]).toBeLessThan(prisma.tx.factEvidence.create.mock.invocationCallOrder[0]);
    expect(prisma.tx.factEvidence.create.mock.invocationCallOrder[0]).toBeLessThan(prisma.tx.customerFactProposal.create.mock.invocationCallOrder[0]);
    expect(prisma.tx.customerFactProposal.create.mock.calls[0][0].data.status).toBe('PROPOSED');
    expect(prisma.tx.customerFact.create).not.toHaveBeenCalled();
  });

  it('requires a manager for proposal acceptance', async () => {
    const prisma = makePrisma();
    const service = new CustomerFactsService(prisma as any);
    const viewer = { ...manager, activeCompany: { id: 'company-1', role: 'viewer' } };

    await expect(service.acceptProposal('proposal-1', { requestId: 'req-1', reason: 'Manual review approved' }, viewer as any)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.customerFactProposal.findFirst).not.toHaveBeenCalled();
  });

  it('accepts a proposal into a confirmed fact and preserves evidence links', async () => {
    const prisma = makePrisma();
    prisma.customerFactProposal.findFirst.mockResolvedValue({
      id: 'proposal-1', companyId: 'company-1', leadId: 'lead-1', factKey: 'identity.company_name', valueType: 'TEXT',
      valueJson: { schemaVersion: 1, type: 'TEXT', value: 'Example Packaging', normalized: 'example packaging' },
      confidenceScore: 80, generatedAt: new Date('2026-08-09T00:00:00.000Z'), version: 1,
      evidenceLinks: [{ evidenceId: 'evidence-1', relation: 'SUPPORTS' }],
    });
    prisma.tx.customerFact.findMany.mockResolvedValue([]);
    prisma.tx.customerFact.create.mockResolvedValue({ id: 'fact-1', status: 'CONFIRMED' });
    prisma.tx.customerFactProposal.updateMany.mockResolvedValue({ count: 1 });
    const service = new CustomerFactsService(prisma as any);

    const result = await service.acceptProposal('proposal-1', { requestId: 'req-1', reason: 'Manual review approved' }, manager as any);

    expect(result).toEqual({ id: 'fact-1', status: 'CONFIRMED' });
    const factData = prisma.tx.customerFact.create.mock.calls[0][0].data;
    expect(factData.confirmedById).toBe('user-1');
    expect(factData.evidenceLinks.create[0]).toEqual(expect.objectContaining({ evidenceId: 'evidence-1', proposalId: 'proposal-1', relation: 'SUPPORTS' }));
    expect(prisma.tx.factCommandReceipt.create).toHaveBeenCalled();
  });

  it('runs a tenant-bound legacy batch as a proposal-only dry-run', async () => {
    const prisma = makePrisma();
    const service = new CustomerFactsService(prisma as any);
    const user = manager;
    prisma.tx.customerFactProposal.create.mockClear();
    const result = await service.legacyDryRun({
      records: [{
        schemaVersion: 1,
        sourceKind: 'LEGACY_LEAD_SCALAR',
        legacyObjectRef: 'legacy-lead-1',
        scope: { tenantRef: 'company-1', leadRef: 'lead-1', factKey: 'company.industry' },
        factKey: 'company.industry',
        observedAt: '2026-08-03T11:00:00Z',
        valueEnvelope: { schemaVersion: 1, type: 'ENUM', value: 'packaging' },
        legacyField: 'industry',
      }],
      validationNow: '2026-08-04T12:00:00Z',
    }, user);
    expect(result.executionMode).toBe('DRY_RUN_ONLY');
    expect(result.plan.totals.proposalPlanItems).toBe(1);
    expect(result.plan.totals.inputRecords).toBe(1);
    expect(result.plan.rejectionReport).toHaveLength(0);
    expect(prisma.tx.customerFactProposal.create).not.toHaveBeenCalled();
  });

  it('rejects a legacy dry-run for another tenant before classification', async () => {
    const prisma = makePrisma();
    const service = new CustomerFactsService(prisma as any);
    await expect(service.legacyDryRun({
      records: [{ scope: { tenantRef: 'company-2' } }],
    }, manager as any)).rejects.toThrow('active company');
  });
});
