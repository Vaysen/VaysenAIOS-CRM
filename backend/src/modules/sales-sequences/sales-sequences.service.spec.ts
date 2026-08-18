import { ConflictException } from '@nestjs/common';
import { SalesSequencesService } from './sales-sequences.service';

const user = {
  id: 'user-1',
  activeCompanyId: 'company-1',
  activeCompany: { id: 'company-1', role: 'company_admin' },
  companies: [{ id: 'company-1', role: 'company_admin' }],
};

function makePrisma() {
  const tx: any = {
    salesSequenceEnrollment: { create: jest.fn() },
    salesSequenceStepExecution: { create: jest.fn(), updateMany: jest.fn(), findUniqueOrThrow: jest.fn() },
    salesSequenceDraftOutbox: { create: jest.fn() },
    salesSequenceExecutionReceipt: { create: jest.fn() },
  };
  return {
    salesSequence: { create: jest.fn(), findMany: jest.fn(), findFirst: jest.fn(), updateMany: jest.fn(), findUniqueOrThrow: jest.fn() },
    lead: { findFirst: jest.fn() },
    salesSequenceEnrollment: { findMany: jest.fn() },
    salesSequenceStepExecution: { findFirst: jest.fn() },
    $transaction: jest.fn(async (callback: (client: any) => Promise<unknown>) => callback(tx)),
    tx,
  };
}

describe('SalesSequencesService', () => {
  it('creates a tenant-owned sequence with digested templates', async () => {
    const prisma = makePrisma();
    prisma.salesSequence.create.mockResolvedValue({ id: 'sequence-1' });
    const service = new SalesSequencesService(prisma as any);

    await service.create({
      name: 'Packaging follow-up',
      steps: [{ channel: 'EMAIL', delaySeconds: 0, templateSnapshot: { subject: 'Draft subject' } }],
    }, user as any);

    expect(prisma.salesSequence.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ companyId: 'company-1', ownerUserId: 'user-1' }),
    }));
    const data = prisma.salesSequence.create.mock.calls[0][0].data;
    expect(data.steps.create[0].templateDigest).toMatch(/^sha256:/);
  });

  it('enrolls a lead into a draft-only outbox and never calls external outbox', async () => {
    const prisma = makePrisma();
    prisma.salesSequence.findFirst.mockResolvedValue({
      id: 'sequence-1',
      steps: [{ id: 'step-1', channel: 'EMAIL', templateDigest: 'sha256:template', templateSnapshot: { subject: 'Draft' } }],
    });
    prisma.lead.findFirst.mockResolvedValue({ id: 'lead-1' });
    prisma.tx.salesSequenceEnrollment.create.mockResolvedValue({ id: 'enrollment-1' });
    prisma.tx.salesSequenceStepExecution.create.mockResolvedValue({ id: 'execution-1', draftDigest: 'sha256:draft' });
    prisma.tx.salesSequenceDraftOutbox.create.mockResolvedValue({ id: 'draft-outbox-1' });

    const service = new SalesSequencesService(prisma as any);
    const result: any = await service.enroll('sequence-1', { leadId: 'lead-1' }, user as any);

    expect(result.draftOutbox).toEqual({ id: 'draft-outbox-1' });
    expect(prisma.tx.salesSequenceDraftOutbox.create).toHaveBeenCalled();
    const outboxData = prisma.tx.salesSequenceDraftOutbox.create.mock.calls[0][0].data;
    expect(outboxData.status).toBeUndefined();
    expect(outboxData.channel).toBe('EMAIL');
    expect(outboxData.targetRef).toMatch(/^target:/);
    expect(prisma).not.toHaveProperty('externalActionOutbox');
    const receipt = prisma.tx.salesSequenceExecutionReceipt.create.mock.calls[0][0].data.receipt;
    expect(receipt.mode).toBe('DRAFT_ONLY');
  });

  it('maps a concurrent execution transition to a conflict and preserves no send command', async () => {
    const prisma = makePrisma();
    prisma.salesSequenceStepExecution.findFirst.mockResolvedValue({
      id: 'execution-1', companyId: 'company-1', status: 'DRAFT_PENDING', version: 1, draftOutbox: { status: 'DRAFT_ONLY' },
    });
    prisma.tx.salesSequenceStepExecution.updateMany.mockResolvedValue({ count: 0 });
    const service = new SalesSequencesService(prisma as any);

    await expect(service.transitionExecution('execution-1', 'APPROVE', user as any)).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.tx.salesSequenceExecutionReceipt.create).not.toHaveBeenCalled();
  });
});
