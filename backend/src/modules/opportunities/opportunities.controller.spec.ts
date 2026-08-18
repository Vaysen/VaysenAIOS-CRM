import { OpportunitiesController } from './opportunities.controller';

describe('OpportunitiesController endpoint contract', () => {
  const service = {
    findAll: jest.fn(),
    create: jest.fn(),
    findOne: jest.fn(),
    update: jest.fn(),
    remove: jest.fn(),
    transition: jest.fn(),
    getHistory: jest.fn(),
    listContactRoles: jest.fn(),
    addContactRole: jest.fn(),
    updateContactRole: jest.fn(),
    removeContactRole: jest.fn(),
  };
  const controller = new OpportunitiesController(service as any);
  const user = { id: 'owner-a', activeCompanyId: 'tenant-a' };

  beforeEach(() => jest.clearAllMocks());

  it('exposes list/create/detail/update/soft-delete CRUD without changing payloads', async () => {
    const query = { page: 1 };
    const createDto = { leadId: 'lead-a', name: 'Opportunity' };
    const updateDto = { name: 'Updated', version: 1 };
    service.findAll.mockResolvedValue({ data: [] });
    service.create.mockResolvedValue({ id: 'opportunity-a' });
    service.findOne.mockResolvedValue({ id: 'opportunity-a' });
    service.update.mockResolvedValue({ id: 'opportunity-a' });
    service.remove.mockResolvedValue({ deleted: true });

    await expect(controller.findAll(query as any, user)).resolves.toEqual({ data: [] });
    await expect(controller.create(createDto as any, user)).resolves.toEqual({ id: 'opportunity-a' });
    await expect(controller.findOne('opportunity-a', user)).resolves.toEqual({ id: 'opportunity-a' });
    await expect(controller.update('opportunity-a', updateDto as any, user)).resolves.toEqual({ id: 'opportunity-a' });
    await expect(controller.remove('opportunity-a', user)).resolves.toEqual({ deleted: true });
    expect(service.findAll).toHaveBeenCalledWith(user, query);
    expect(service.create).toHaveBeenCalledWith(createDto, user);
    expect(service.update).toHaveBeenCalledWith('opportunity-a', updateDto, user);
    expect(service.remove).toHaveBeenCalledWith('opportunity-a', user);
  });

  it('exposes stage/history/contact-role endpoints as separate service calls', async () => {
    const transitionDto = { stage: 'proposal', version: 1 };
    const addDto = { contactId: 'contact-a', roleType: 'buyer', isPrimary: true };
    const updateDto = { roleType: 'champion', isPrimary: true };
    service.transition.mockResolvedValue({ stage: 'proposal' });
    service.getHistory.mockResolvedValue({ data: [] });
    service.listContactRoles.mockResolvedValue({ data: [] });
    service.addContactRole.mockResolvedValue({ id: 'role-a' });
    service.updateContactRole.mockResolvedValue({ id: 'role-a' });
    service.removeContactRole.mockResolvedValue({ removed: true });

    await expect(controller.transition('opportunity-a', transitionDto as any, user)).resolves.toEqual({ stage: 'proposal' });
    await expect(controller.getHistory('opportunity-a', user)).resolves.toEqual({ data: [] });
    await expect(controller.listContactRoles('opportunity-a', user)).resolves.toEqual({ data: [] });
    await expect(controller.addContactRole('opportunity-a', addDto as any, user)).resolves.toEqual({ id: 'role-a' });
    await expect(controller.updateContactRole('opportunity-a', 'role-a', updateDto as any, user)).resolves.toEqual({ id: 'role-a' });
    await expect(controller.removeContactRole('opportunity-a', 'role-a', user)).resolves.toEqual({ removed: true });

    expect(service.transition).toHaveBeenCalledWith('opportunity-a', transitionDto, user);
    expect(service.getHistory).toHaveBeenCalledWith('opportunity-a', user);
    expect(service.listContactRoles).toHaveBeenCalledWith('opportunity-a', user);
    expect(service.addContactRole).toHaveBeenCalledWith('opportunity-a', addDto, user);
    expect(service.updateContactRole).toHaveBeenCalledWith('opportunity-a', 'role-a', updateDto, user);
    expect(service.removeContactRole).toHaveBeenCalledWith('opportunity-a', 'role-a', user);
  });
});
