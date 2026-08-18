import { CustomerAssetsService } from './customer-assets.service';
import { CustomerMergeService } from '../customer-identity/customer-merge.service';

describe('CustomerAssetsService', () => {
  const salesUser = (id = 'sales-1', companyId = 'company-1', role = 'sales_user') => ({
    id,
    activeCompanyId: companyId,
    activeCompany: { id: companyId, role },
    companies: [{ id: companyId, role }],
  });

  const aggregateLead = (ownerUserId = 'sales-1') => {
    const updatedAt = new Date('2026-07-29T00:00:00.000Z');
    return {
      id: 'lead-1', companyId: 'company-1', ownerUserId, companyName: 'Acme', country: 'CN', updatedAt,
      contacts: [{ id: 'contact-1', displayName: 'Alice', firstName: 'Alice', lastName: null, email: 'a@example.com', phone: '+8613365923697', title: null, isPrimary: true, updatedAt, contactPoints: [{ id: 'cp-1', type: 'whatsapp', originalValue: '+86 133 6592 3697', normalizedValue: '+8613365923697', isVerified: true }] }],
      contactPoints: [{ id: 'cp-1', type: 'whatsapp', originalValue: '+86 133 6592 3697', normalizedValue: '+8613365923697', isVerified: true }],
      conversations: [{ id: 'conversation-1', channel: 'whatsapp', subject: 'Alice', status: 'active', isGroup: false, contactPointId: 'cp-1', lastMessageAt: updatedAt, lastMessagePreview: 'hello', unreadCount: 0 }],
      emailMessages: [{ id: 'email-1', subject: 'RFQ', status: 'received', createdAt: updatedAt }],
      quotes: [{ id: 'quote-1', referenceNo: 'Q-1', status: 'draft', totalAmount: 10, createdAt: updatedAt }],
      orders: [{ id: 'order-1', orderNo: 'O-1', stage: 'new', totalAmount: 20, createdAt: updatedAt }],
    };
  };

  function makeService() {
    const prisma = {
      lead: { findFirst: jest.fn(), findMany: jest.fn() },
      identityMatchCandidate: { findMany: jest.fn(), findFirst: jest.fn() },
      contactPoint: { findMany: jest.fn() },
    };
    const mergeService = {
      previewAuthorized: jest.fn(),
      mergeAuthorized: jest.fn(),
      rejectAuthorized: jest.fn(),
      undoAuthorized: jest.fn(),
    };
    return { service: new CustomerAssetsService(prisma as any, mergeService as any), prisma };
  }

  it('returns one tenant-scoped aggregate with contacts and lifecycle links', async () => {
    const { service, prisma } = makeService();
    prisma.lead.findFirst.mockResolvedValue(aggregateLead());
    prisma.identityMatchCandidate.findMany.mockResolvedValue([]);

    const result = await service.getCustomerAsset('company-1', 'lead-1', salesUser());

    expect(result).toMatchObject({ id: 'lead-1', companyName: 'Acme', selectedContactId: 'contact-1' });
    expect(result.contacts[0].contactPoints[0].normalizedValue).toBe('+8613365923697');
    expect(result.conversations).toHaveLength(1);
    expect(result.emails).toHaveLength(1);
    expect(result.quotes).toHaveLength(1);
    expect(result.orders).toHaveLength(1);
    expect(prisma.lead.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'lead-1', companyId: 'company-1', deletedAt: null, ownerUserId: 'sales-1' } }));
    expect(prisma.identityMatchCandidate.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ sourceLead: { companyId: 'company-1', ownerUserId: 'sales-1', deletedAt: null } }),
    }));
  });

  it('allows an administrator to read another owner within the active company', async () => {
    const { service, prisma } = makeService();
    prisma.lead.findFirst.mockResolvedValue(aggregateLead('sales-2'));
    prisma.identityMatchCandidate.findMany.mockResolvedValue([]);

    await expect(service.getCustomerAsset('company-1', 'lead-1', salesUser('admin-1', 'company-1', 'company_admin')))
      .resolves.toMatchObject({ id: 'lead-1', contacts: [{ email: 'a@example.com', phone: '+8613365923697' }] });
    expect(prisma.lead.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'lead-1', companyId: 'company-1', deletedAt: null },
    }));
    expect(prisma.identityMatchCandidate.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.not.objectContaining({ sourceLead: expect.anything() }),
    }));
  });

  it('returns the same non-enumerating not-found result for an ordinary users other-owner lead', async () => {
    const { service, prisma } = makeService();
    prisma.lead.findFirst.mockResolvedValue(null);

    await expect(service.getCustomerAsset('company-1', 'lead-2', salesUser())).rejects.toThrow('customer asset not found');
    expect(prisma.lead.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'lead-2', companyId: 'company-1', deletedAt: null, ownerUserId: 'sales-1' },
    }));
    expect(prisma.identityMatchCandidate.findMany).not.toHaveBeenCalled();
  });

  it.each([
    ['cross-tenant', 'company-2', 'lead-cross-tenant', 'company-1'],
    ['deleted', 'company-1', 'lead-deleted', 'company-1'],
  ])('rejects %s reads before returning aggregate data', async (_label, companyId, leadId, userCompanyId) => {
    const { service, prisma } = makeService();
    prisma.lead.findFirst.mockResolvedValue(null);

    await expect(service.getCustomerAsset(companyId, leadId, salesUser('sales-1', userCompanyId))).rejects.toThrow('customer asset not found');
    if (companyId === userCompanyId) {
      expect(prisma.lead.findFirst).toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({ id: leadId, companyId, deletedAt: null }),
      }));
    } else {
      expect(prisma.lead.findFirst).not.toHaveBeenCalled();
    }
    expect(prisma.identityMatchCandidate.findMany).not.toHaveBeenCalled();
  });

  it('routes listContacts through the same user-aware aggregate boundary', async () => {
    const { service, prisma } = makeService();
    prisma.lead.findFirst.mockResolvedValue(aggregateLead());
    prisma.identityMatchCandidate.findMany.mockResolvedValue([]);
    const getSpy = jest.spyOn(service, 'getCustomerAsset');
    const user = salesUser();

    await expect(service.listContacts('company-1', 'lead-1', user)).resolves.toEqual([
      expect.objectContaining({ id: 'contact-1', email: 'a@example.com' }),
    ]);
    expect(getSpy).toHaveBeenCalledWith('company-1', 'lead-1', user);
  });

  it('only reports exact same-tenant E.164 duplicates and ignores LID-looking values', async () => {
    const { service, prisma } = makeService();
    prisma.contactPoint.findMany.mockResolvedValue([{ lead: { id: 'lead-2', companyName: 'Other', deletedAt: null }, type: 'whatsapp', normalizedValue: '+8613365923697' }]);

    const result = await service.duplicateCheck({ companyId: 'company-1', leadId: 'lead-1', phone: '+86 133 6592 3697' });
    expect(result.hits[0]).toMatchObject({ leadId: 'lead-2', matchedChannel: 'whatsapp', matchedValue: '+8613365923697' });
    expect(prisma.contactPoint.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ companyId: 'company-1' }) }));

    prisma.contactPoint.findMany.mockClear();
    await service.duplicateCheck({ companyId: 'company-1', leadId: 'lead-1', phone: '1234567890@lid' });
    expect(prisma.contactPoint.findMany).not.toHaveBeenCalled();
  });

  it('companyName duplicate check returns review-ready display fields', async () => {
    const { service, prisma } = makeService();
    prisma.lead.findMany = jest.fn().mockResolvedValue([{
      id: 'lead-2', companyName: 'Acme Packaging', leadName: null, contactName: 'Alice', country: 'CN',
    }]);

    const result = await service.duplicateCheck({
      companyId: 'company-1', leadId: 'lead-1', companyName: 'acme packaging',
    });

    expect(result.hits[0]).toMatchObject({
      leadId: 'lead-2', matchedChannel: 'companyName', displayName: 'Acme Packaging', countryIso2: 'CN',
    });
    expect(prisma.lead.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ companyId: 'company-1', companyName: { equals: 'acme packaging', mode: 'insensitive' } }),
    }));
  });

  it('routes merge through authorization so same-tenant non-owner customers are rejected', async () => {
    const prisma = {
      identityMatchCandidate: { findUnique: jest.fn().mockResolvedValue({
        id: 'candidate-1', companyId: 'company-1',
        sourceLead: { companyId: 'company-1', ownerUserId: 'sales-1' },
        targetLead: { companyId: 'company-1', ownerUserId: 'sales-2' },
      }) },
    };
    const mergeService = new CustomerMergeService(prisma as any);
    const service = new CustomerAssetsService(prisma as any, mergeService);

    await expect(service.merge('company-1', {
      companyId: 'company-1', candidateId: 'candidate-1',
      targetUpdatedAt: '2026-07-29T00:00:00.000Z', mode: 'trusted_defaults', fieldChoices: [],
    }, {
      id: 'sales-1', activeCompanyId: 'company-1', activeCompany: { id: 'company-1', role: 'sales_user' },
      companies: [{ id: 'company-1', role: 'sales_user' }],
    })).rejects.toThrow(/both customers/i);
  });

  it.each([
    ['preview', async (service: CustomerAssetsService, user: any) => service.mergePreview('company-1', 'candidate-1', user)],
    ['reject', async (service: CustomerAssetsService, user: any) => service.reject('company-1', { companyId: 'company-1', actorId: user.id, candidateId: 'candidate-1' }, user)],
  ])('routes %s through the same owner authorization boundary', async (_name, invoke) => {
    const prisma = {
      identityMatchCandidate: { findUnique: jest.fn().mockResolvedValue({
        id: 'candidate-1', companyId: 'company-1',
        sourceLead: { companyId: 'company-1', ownerUserId: 'sales-1' },
        targetLead: { companyId: 'company-1', ownerUserId: 'sales-2' },
      }) },
    };
    const service = new CustomerAssetsService(prisma as any, new CustomerMergeService(prisma as any));
    const user = {
      id: 'sales-1', activeCompanyId: 'company-1',
      activeCompany: { id: 'company-1', role: 'sales_user' },
      companies: [{ id: 'company-1', role: 'sales_user' }],
    };
    await expect(invoke(service, user)).rejects.toThrow(/both customers/i);
  });

  it('routes undo through owner authorization for the audited source and target', async () => {
    const prisma = {
      customerMergeAudit: { findUnique: jest.fn().mockResolvedValue({
        id: 'audit-1', companyId: 'company-1', sourceLeadId: 'lead-a', targetLeadId: 'lead-b',
      }) },
      lead: { findUnique: jest.fn()
        .mockResolvedValueOnce({ id: 'lead-a', companyId: 'company-1', ownerUserId: 'sales-1' })
        .mockResolvedValueOnce({ id: 'lead-b', companyId: 'company-1', ownerUserId: 'sales-2' }) },
    };
    const service = new CustomerAssetsService(prisma as any, new CustomerMergeService(prisma as any));
    const user = {
      id: 'sales-1', activeCompanyId: 'company-1',
      activeCompany: { id: 'company-1', role: 'sales_user' },
      companies: [{ id: 'company-1', role: 'sales_user' }],
    };
    await expect(service.undo('company-1', 'audit-1', user)).rejects.toThrow(/both customers/i);
  });

  it('allows an administrator through preview, reject and undo authorization', async () => {
    const candidate = {
      id: 'candidate-1', companyId: 'company-1', sourceLeadId: 'lead-a', targetLeadId: 'lead-b', status: 'pending',
      sourceLead: { id: 'lead-a', companyId: 'company-1', ownerUserId: 'sales-1', updatedAt: new Date() },
      targetLead: { id: 'lead-b', companyId: 'company-1', ownerUserId: 'sales-2', updatedAt: new Date() },
    };
    const audit = { id: 'audit-1', companyId: 'company-1', sourceLeadId: 'lead-a', targetLeadId: 'lead-b' };
    const prisma = {
      identityMatchCandidate: { findUnique: jest.fn().mockResolvedValue(candidate) },
      customerMergeAudit: { findUnique: jest.fn().mockResolvedValue(audit) },
      lead: { findUnique: jest.fn().mockResolvedValue({ companyId: 'company-1', ownerUserId: 'sales-2' }) },
    };
    const mergeService = new CustomerMergeService(prisma as any);
    jest.spyOn(mergeService, 'previewMerge').mockResolvedValue({ targetUpdatedAt: new Date().toISOString(), fieldDiffs: [], contactCount: { source: 0, target: 0 }, contactPointCount: { source: 0, target: 0 }, conversationCount: { source: 0, target: 0 } });
    jest.spyOn(mergeService, 'rejectCandidate').mockResolvedValue(undefined);
    jest.spyOn(mergeService, 'undoMerge').mockResolvedValue(undefined);
    const service = new CustomerAssetsService(prisma as any, mergeService);
    const admin = { id: 'admin-1', activeCompanyId: 'company-1', activeCompany: { id: 'company-1', role: 'company_admin' }, companies: [{ id: 'company-1', role: 'company_admin' }] };
    await expect(service.mergePreview('company-1', 'candidate-1', admin)).resolves.toHaveProperty('targetUpdatedAt');
    await expect(service.reject('company-1', { companyId: 'company-1', actorId: 'ignored', candidateId: 'candidate-1' }, admin)).resolves.toBeUndefined();
    await expect(service.undo('company-1', 'audit-1', admin)).resolves.toBeUndefined();
  });
});
