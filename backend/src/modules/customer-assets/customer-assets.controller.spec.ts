import { CustomerAssetsController, CustomerMergesController, IdentityCandidatesController } from './customer-assets.controller';

describe('CustomerAssetsController read authorization handoff', () => {
  it('passes the authenticated user to aggregate and contacts reads', async () => {
    const service = {
      getCustomerAsset: jest.fn().mockResolvedValue({ id: 'lead-1' }),
      listContacts: jest.fn().mockResolvedValue([]),
    };
    const controller = new CustomerAssetsController(service as any);
    const user = {
      id: 'sales-1', activeCompanyId: 'company-1',
      activeCompany: { id: 'company-1', role: 'sales_user' },
      companies: [{ id: 'company-1', role: 'sales_user' }],
    };

    await controller.get('lead-1', user as any);
    await controller.listContacts('lead-1', user as any);

    expect(service.getCustomerAsset).toHaveBeenCalledWith('company-1', 'lead-1', user);
    expect(service.listContacts).toHaveBeenCalledWith('company-1', 'lead-1', user);
  });
});

describe('IdentityCandidatesController authorization handoff', () => {
  it('passes the authenticated user to the service merge boundary', async () => {
    const service = { merge: jest.fn().mockResolvedValue({ auditId: 'audit-1', targetLeadId: 'lead-target' }) };
    const controller = new IdentityCandidatesController(service as any);
    const user = {
      id: 'sales-1',
      activeCompanyId: 'company-1',
      activeCompany: { id: 'company-1', role: 'sales_user' },
      companies: [{ id: 'company-1', role: 'sales_user' }],
    };

    await controller.merge('candidate-1', {
      targetUpdatedAt: '2026-07-29T00:00:00.000Z',
      mode: 'trusted_defaults',
      fieldChoices: [],
    }, user);

    expect(service.merge).toHaveBeenCalledWith('company-1', expect.objectContaining({
      candidateId: 'candidate-1',
      targetUpdatedAt: '2026-07-29T00:00:00.000Z',
    }), user);
  });

  it('passes the authenticated user to preview and reject boundaries', async () => {
    const service = {
      mergePreview: jest.fn().mockResolvedValue({ targetUpdatedAt: '2026-07-29T00:00:00.000Z' }),
      reject: jest.fn().mockResolvedValue(undefined),
    };
    const controller = new IdentityCandidatesController(service as any);
    const user = { id: 'sales-1', activeCompanyId: 'company-1', activeCompany: { id: 'company-1', role: 'sales_user' }, companies: [{ id: 'company-1', role: 'sales_user' }] };

    await controller.mergePreview('candidate-1', user as any);
    await controller.reject('candidate-1', { reason: 'not the same customer' }, user as any);

    expect(service.mergePreview).toHaveBeenCalledWith('company-1', 'candidate-1', user);
    expect(service.reject).toHaveBeenCalledWith('company-1', expect.objectContaining({ actorId: 'sales-1', candidateId: 'candidate-1' }), user);
  });
});

describe('CustomerMergesController authorization handoff', () => {
  it('passes the authenticated user to undo', async () => {
    const service = { undo: jest.fn().mockResolvedValue(undefined) };
    const controller = new CustomerMergesController(service as any);
    const user = { id: 'sales-1', activeCompanyId: 'company-1', activeCompany: { id: 'company-1', role: 'sales_user' }, companies: [{ id: 'company-1', role: 'sales_user' }] };

    await controller.undo('audit-1', user as any);

    expect(service.undo).toHaveBeenCalledWith('company-1', 'audit-1', user);
  });
});
