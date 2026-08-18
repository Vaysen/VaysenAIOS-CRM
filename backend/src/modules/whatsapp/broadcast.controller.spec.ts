import {
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { BroadcastController } from './broadcast.controller';

describe('BroadcastController fail-closed boundary', () => {
  const companyId = 'company-1';
  const admin = {
    id: 'admin-1',
    activeCompanyId: companyId,
    activeCompany: { id: companyId, role: 'company_admin' },
    companies: [{ id: companyId, role: 'company_admin' }],
  };

  function createHarness() {
    const prisma = {
      userCompanyRelation: {
        findFirst: jest.fn().mockResolvedValue({
          companyId,
          userId: admin.id,
          isActive: true,
          role: { name: 'company_admin' },
        }),
      },
      whatsAppBroadcastTask: {
        create: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        findFirst: jest.fn().mockResolvedValue({
          id: 'task-1',
          companyId,
          recipients: '[]',
          status: 'pending',
          recipientCount: 1,
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    return {
      prisma,
      controller: new BroadcastController(prisma as any),
    };
  }

  it('fails every legacy route closed before broadcast task data can be read or mutated', async () => {
    const { controller, prisma } = createHarness();
    const disabled = ServiceUnavailableException;

    await expect(controller.createTask({
      companyId: 'attacker-controlled-company',
      taskName: 'Blocked broadcast',
      accountId: 'account-1',
      template: 'Hello',
      recipients: [{ phone: '+12025550123', name: 'Buyer' }],
    }, admin)).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.getTasks(admin)).rejects.toBeInstanceOf(disabled);
    await expect(controller.getTaskDetail('task-1', admin)).rejects.toBeInstanceOf(disabled);
    await expect(controller.cancelTask('task-1', admin)).rejects.toBeInstanceOf(disabled);
    await expect(controller.updateProgress(
      'task-1',
      { sentCount: 1, failedCount: 0, status: 'completed' },
      admin,
    )).rejects.toBeInstanceOf(disabled);
    await expect(controller.getTemplates(admin)).rejects.toBeInstanceOf(disabled);

    expect(prisma.whatsAppBroadcastTask.create).not.toHaveBeenCalled();
    expect(prisma.whatsAppBroadcastTask.findMany).not.toHaveBeenCalled();
    expect(prisma.whatsAppBroadcastTask.count).not.toHaveBeenCalled();
    expect(prisma.whatsAppBroadcastTask.findFirst).not.toHaveBeenCalled();
    expect(prisma.whatsAppBroadcastTask.updateMany).not.toHaveBeenCalled();
  });

  it('does not fall back to companies[0] and rejects inactive or inconsistent active-company claims', async () => {
    const { controller, prisma } = createHarness();
    await expect(controller.getTasks({
      id: admin.id,
      companies: admin.companies,
    })).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.userCompanyRelation.findFirst).not.toHaveBeenCalled();

    await expect(controller.getTasks({
      ...admin,
      activeCompany: { id: 'company-2', role: 'company_admin' },
    })).rejects.toBeInstanceOf(ForbiddenException);

    prisma.userCompanyRelation.findFirst.mockResolvedValueOnce(null);
    await expect(controller.getTasks(admin)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.whatsAppBroadcastTask.findMany).not.toHaveBeenCalled();
  });

  it('keeps every retained query and cancellation write explicitly scoped to activeCompanyId', async () => {
    const { controller, prisma } = createHarness();
    jest.spyOn(controller as any, 'isOutboxBroadcastAvailable').mockReturnValue(true);

    await controller.getTasks(admin, 'pending', '1', '20');
    expect(prisma.whatsAppBroadcastTask.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { companyId, status: 'pending' },
    }));
    expect(prisma.whatsAppBroadcastTask.count).toHaveBeenCalledWith({
      where: { companyId, status: 'pending' },
    });

    await controller.getTaskDetail('task-1', admin);
    expect(prisma.whatsAppBroadcastTask.findFirst).toHaveBeenCalledWith({
      where: { id: 'task-1', companyId },
    });

    await controller.cancelTask('task-1', admin);
    expect(prisma.whatsAppBroadcastTask.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'task-1',
        companyId,
        status: { in: ['pending', 'scheduled', 'sending'] },
      },
      data: { status: 'cancelled' },
    });
    expect(prisma.whatsAppBroadcastTask.findFirst).toHaveBeenLastCalledWith({
      where: { id: 'task-1', companyId },
    });
  });
});
