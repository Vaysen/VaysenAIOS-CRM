import {
  ForbiddenException,
  HttpException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { BrevoInboundController } from './brevo-inbound.controller';

describe('BrevoInboundController public error contract', () => {
  const payload = { MessageId: '<controller-message@example.net>' };
  let service: { assertAuthorized: jest.Mock; ingest: jest.Mock };
  let controller: BrevoInboundController;

  beforeEach(() => {
    service = {
      assertAuthorized: jest.fn(),
      ingest: jest.fn(),
    };
    controller = new BrevoInboundController(service as any);
  });

  it('preserves unconfigured 503 and does not call ingest', async () => {
    const error = new ServiceUnavailableException('Brevo inbound email is not configured');
    service.assertAuthorized.mockImplementation(() => { throw error; });

    await expect(controller.inboundEmail(payload, undefined)).rejects.toBe(error);
    expect(service.ingest).not.toHaveBeenCalled();
  });

  it('preserves invalid-token 403 and does not call ingest', async () => {
    const error = new ForbiddenException('Invalid Brevo webhook token');
    service.assertAuthorized.mockImplementation(() => { throw error; });

    await expect(controller.inboundEmail(payload, 'Bearer invalid')).rejects.toBe(error);
    expect(service.ingest).not.toHaveBeenCalled();
  });

  it('returns successful service results unchanged after authorization', async () => {
    const result = {
      status: 'ok', received: 1, skipped: 0,
      results: [{ status: 'received', messageRef: 'sha256:brevo-message:abc' }],
    };
    service.ingest.mockResolvedValue(result);

    await expect(controller.inboundEmail(payload, 'Bearer valid')).resolves.toBe(result);
    expect(service.assertAuthorized).toHaveBeenCalledWith('Bearer valid');
    expect(service.ingest).toHaveBeenCalledWith(payload);
  });

  it('maps ordinary provider/Prisma failures to stable 500 without raw details', async () => {
    const raw = 'BREVO_PROVIDER_SENTINEL recipient@example.com https://provider.invalid/?token=TOKEN_SENTINEL';
    const error = Object.assign(new Error(raw), {
      response: { status: 502, body: raw },
      cause: new Error(`CAUSE_${raw}`),
    });
    service.ingest.mockRejectedValue(error);

    let caught: unknown;
    try {
      await controller.inboundEmail(payload, 'Bearer valid');
    } catch (value) {
      caught = value;
    }

    expect(caught).toBeInstanceOf(HttpException);
    const exception = caught as HttpException;
    expect(exception.getStatus()).toBe(500);
    expect(exception.getResponse()).toEqual({
      statusCode: 500,
      code: 'BREVO_INBOUND_PROCESSING_FAILED',
      message: 'Brevo inbound processing failed',
    });
    expect(JSON.stringify(exception.getResponse())).not.toContain(raw);
    expect(JSON.stringify(exception.getResponse())).not.toContain('TOKEN_SENTINEL');
  });

  it('keeps a downstream HttpException status while replacing its response body', async () => {
    const raw = 'DOWNSTREAM_HTTP_SENTINEL provider@example.com';
    service.ingest.mockRejectedValue(new HttpException({ message: raw, response: raw }, 409));

    let caught: unknown;
    try {
      await controller.inboundEmail(payload, 'Bearer valid');
    } catch (value) {
      caught = value;
    }

    expect(caught).toBeInstanceOf(HttpException);
    const exception = caught as HttpException;
    expect(exception.getStatus()).toBe(409);
    expect(exception.getResponse()).toEqual({
      statusCode: 409,
      code: 'BREVO_INBOUND_PROCESSING_FAILED',
      message: 'Brevo inbound processing failed',
    });
    expect(JSON.stringify(exception.getResponse())).not.toContain(raw);
  });
});
