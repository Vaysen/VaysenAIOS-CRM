import { BadRequestException } from '@nestjs/common';
import { DECORATORS } from '@nestjs/swagger/dist/constants';
import { EmailsController } from './emails.controller';

describe('EmailsController Idempotency-Key boundary', () => {
  const user = { id: 'user-1' };

  function harness() {
    const service = {
      sendSingle: jest.fn().mockResolvedValue({ success: true }),
      sendBatch: jest.fn().mockResolvedValue({ success: true }),
    };
    return {
      controller: new EmailsController(service as any),
      service,
    };
  }

  it.each([
    ['single', (controller: EmailsController, key: any) => (
      controller.sendSingle({} as any, key, user)
    )],
    ['batch', (controller: EmailsController, key: any) => (
      controller.sendBatch({} as any, key, user)
    )],
  ])('rejects a missing or non-canonical key for %s before the service', (
    _label,
    invoke,
  ) => {
    const { controller, service } = harness();

    expect(() => invoke(controller, undefined)).toThrow(BadRequestException);
    expect(() => invoke(controller, 'short')).toThrow(BadRequestException);
    expect(service.sendSingle).not.toHaveBeenCalled();
    expect(service.sendBatch).not.toHaveBeenCalled();
  });

  it('trims and forwards one canonical key for each endpoint', () => {
    const { controller, service } = harness();

    controller.sendSingle({ leadId: 'lead-1' } as any, ' single-key-0001 ', user);
    controller.sendBatch({ leadIds: ['lead-1'] } as any, ' batch-key-00001 ', user);

    expect(service.sendSingle).toHaveBeenCalledWith(
      { leadId: 'lead-1' },
      user,
      'single-key-0001',
    );
    expect(service.sendBatch).toHaveBeenCalledWith(
      { leadIds: ['lead-1'] },
      user,
      'batch-key-00001',
    );
  });

  it.each(['sendSingle', 'sendBatch'] as const)(
    'publishes the required header and stable 400/409 contract for %s',
    (methodName) => {
      const handler = EmailsController.prototype[methodName];
      const parameters = Reflect.getMetadata(
        DECORATORS.API_PARAMETERS,
        handler,
      );
      const responses = Reflect.getMetadata(
        DECORATORS.API_RESPONSE,
        handler,
      );

      expect(parameters).toEqual(expect.arrayContaining([
        expect.objectContaining({
          in: 'header',
          name: 'Idempotency-Key',
          required: true,
          schema: expect.objectContaining({
            minLength: 8,
            maxLength: 200,
          }),
        }),
      ]));
      expect(responses['400']).toMatchObject({
        description: expect.stringMatching(/missing or malformed/i),
      });
      expect(responses['409'].schema.example).toMatchObject({
        code: 'EMAIL_IDEMPOTENCY_PAYLOAD_CONFLICT',
      });
    },
  );
});
