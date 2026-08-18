import { ExternalActionStatus } from '@prisma/client';
import { OutboundController } from './outbound.controller';

describe('OutboundController management surface', () => {
  it('exposes UNKNOWN discovery and tenant-scoped by-key lookup through validated DTO shapes', async () => {
    const service = {
      listActions: jest.fn().mockResolvedValue([]),
      getActionByKey: jest.fn().mockResolvedValue({ id: 'action-1' }),
    };
    const controller = new OutboundController(service as any);
    const user = { id: 'admin-1', activeCompanyId: '11111111-1111-4111-8111-111111111111' };

    await controller.list({
      companyId: user.activeCompanyId,
      status: ExternalActionStatus.UNKNOWN,
      limit: 25,
    }, user);
    expect(service.listActions).toHaveBeenCalledWith(
      user.activeCompanyId,
      user,
      expect.objectContaining({ status: ExternalActionStatus.UNKNOWN, limit: 25 }),
    );

    await controller.getByKey(
      { idempotencyKey: 'email:test-0001' },
      { companyId: user.activeCompanyId },
      user,
    );
    expect(service.getActionByKey).toHaveBeenCalledWith(
      user.activeCompanyId,
      'email:test-0001',
      user,
    );
  });

  it('returns the service projection for every row-returning admin endpoint', async () => {
    const projection = {
      id: 'action-row-1',
      actionIdDigest: 'sha256:outbound-action:opaque',
      status: ExternalActionStatus.UNKNOWN,
    };
    const service = {
      listActions: jest.fn().mockResolvedValue({ data: [projection], hasMore: false }),
      getAction: jest.fn().mockResolvedValue(projection),
      getActionByKey: jest.fn().mockResolvedValue(projection),
      cancel: jest.fn().mockResolvedValue(projection),
      reconcileUnknown: jest.fn().mockResolvedValue(projection),
    };
    const controller = new OutboundController(service as any);
    const user = { id: 'admin-1', activeCompanyId: '11111111-1111-4111-8111-111111111111' };

    await expect(controller.list({ companyId: user.activeCompanyId }, user))
      .resolves.toEqual({ data: [projection], hasMore: false });
    await expect(controller.get(
      { id: projection.id },
      { companyId: user.activeCompanyId },
      user,
    )).resolves.toBe(projection);
    await expect(controller.getByKey(
      { idempotencyKey: 'email:test-0001' },
      { companyId: user.activeCompanyId },
      user,
    )).resolves.toBe(projection);
    await expect(controller.cancel(
      { companyId: user.activeCompanyId, idempotencyKey: 'email:test-0001' },
      user,
    )).resolves.toBe(projection);
    await expect(controller.reconcile(
      { id: projection.id },
      {
        companyId: user.activeCompanyId,
        outcome: 'FAILED',
        reason: 'Provider console confirmation',
      },
      user,
    )).resolves.toBe(projection);

    expect(service.getAction).toHaveBeenCalledWith(user.activeCompanyId, projection.id, user);
    expect(service.cancel).toHaveBeenCalledWith(
      user.activeCompanyId,
      'email:test-0001',
      user,
    );
    expect(service.reconcileUnknown).toHaveBeenCalledWith(
      user.activeCompanyId,
      projection.id,
      'FAILED',
      user,
      expect.objectContaining({ reason: 'Provider console confirmation' }),
      undefined,
    );
  });
});
