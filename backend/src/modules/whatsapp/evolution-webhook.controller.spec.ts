import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { EvolutionApiService } from './evolution-api.service';

// The controller boundary does not need the Baileys ESM adapter. Mock the
// injected service before loading the decorated controller so Jest stays on
// this unit's authentication/state boundary.
jest.mock('./whatsapp.service', () => ({ WhatsAppService: class WhatsAppService {} }));

import { EvolutionWebhookController } from './evolution-webhook.controller';
import { IS_PUBLIC_KEY } from '../../common/decorators/public.decorator';

const ENV_KEYS = [
  'EVOLUTION_API_ENABLED',
  'EVOLUTION_API_URL',
  'EVOLUTION_API_KEY',
  'EVOLUTION_WEBHOOK_SECRET',
  'BACKEND_URL',
] as const;
const ORIGINAL = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const VALID_SECRET = 'webhook-secret-a1b2c3d4e5f6-ghij';

function configureEnabled() {
  process.env.EVOLUTION_API_ENABLED = 'true';
  process.env.EVOLUTION_API_URL = 'http://evolution-api:8080';
  process.env.EVOLUTION_API_KEY = 'evolution-key-a1b2c3d4e5f6';
  process.env.EVOLUTION_WEBHOOK_SECRET = VALID_SECRET;
  process.env.BACKEND_URL = 'http://backend:4000';
}

describe('Evolution webhook fail-closed boundary', () => {
  const whatsapp = {
    updateQrCode: jest.fn(),
    updateConnectionStatus: jest.fn(),
    handleEvolutionMessage: jest.fn(),
    updateMessageStatus: jest.fn(),
  };
  const eventBus = {};
  let controller: EvolutionWebhookController;

  beforeEach(() => {
    jest.clearAllMocks();
    for (const key of ENV_KEYS) delete process.env[key];
    controller = new EvolutionWebhookController(
      whatsapp as any,
      eventBus as any,
      new EvolutionApiService(),
    );
  });

  afterAll(() => {
    for (const key of ENV_KEYS) {
      const value = ORIGINAL[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('rejects the endpoint while Evolution is disabled without touching state', async () => {
    await expect(controller.handleWebhook({ event: 'qrcode.updated' }, VALID_SECRET))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(whatsapp.updateQrCode).not.toHaveBeenCalled();
  });

  it('bypasses global JWT only so the dedicated webhook policy can fail closed', () => {
    expect(Reflect.getMetadata(
      IS_PUBLIC_KEY,
      EvolutionWebhookController.prototype.handleWebhook,
    )).toBe(true);
  });

  it('rejects a wrong credential before touching state', async () => {
    configureEnabled();
    await expect(controller.handleWebhook({
      event: 'qrcode.updated', instance: 'fixture', data: { qrcode: 'secret-qr' },
    }, 'wrong-secret')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(whatsapp.updateQrCode).not.toHaveBeenCalled();
  });

  it('allows an authenticated event when the optional integration is fully configured', async () => {
    configureEnabled();
    await expect(controller.handleWebhook({
      event: 'qrcode.updated', instance: 'fixture', data: { qrcode: 'qr-value' },
    }, VALID_SECRET)).resolves.toEqual({ status: 'ok' });
    expect(whatsapp.updateQrCode).toHaveBeenCalledWith('fixture', 'qr-value');
  });

  it('preserves a private LID as an external identity and never converts its prefix to a phone', async () => {
    configureEnabled();
    await controller.handleWebhook({
      event: 'messages.upsert',
      instance: 'fixture',
      data: {
        key: { id: 'm-lid', fromMe: false, remoteJid: '234977878868136@lid' },
        message: { conversation: 'privacy hello' },
        messageTimestamp: '1784016000',
        pushName: 'Private buyer',
      },
    }, VALID_SECRET);

    expect(whatsapp.handleEvolutionMessage).toHaveBeenCalledWith(expect.objectContaining({
      fromPhone: '',
      isGroup: false,
      externalId: '234977878868136@lid',
      externalIdKind: 'lid',
      phoneCandidate: null,
      transportSource: 'evolution_webhook',
    }));
  });

  it('accepts the native Evolution data.key + data.message envelope', async () => {
    configureEnabled();
    await controller.handleWebhook({
      event: 'messages.upsert',
      instance: 'fixture',
      data: {
        key: { id: 'm-phone', fromMe: false, remoteJid: '8613800138000@s.whatsapp.net' },
        message: { conversation: 'native envelope' },
        messageTimestamp: '1784016000',
        pushName: 'Buyer',
      },
    }, VALID_SECRET);

    expect(whatsapp.handleEvolutionMessage).toHaveBeenCalledWith(expect.objectContaining({
      fromPhone: '8613800138000',
      messageContent: 'native envelope',
      externalId: '8613800138000@s.whatsapp.net',
      externalIdKind: 'phone_jid',
      phoneCandidate: '8613800138000',
    }));
  });

  it('propagates processing failures so Evolution can retry the event', async () => {
    configureEnabled();
    whatsapp.handleEvolutionMessage.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(controller.handleWebhook({
      event: 'messages.upsert',
      instance: 'fixture',
      data: {
        key: { id: 'm-retry', fromMe: false, remoteJid: '8613800138000@s.whatsapp.net' },
        message: { conversation: 'retry me' },
      },
    }, VALID_SECRET)).rejects.toThrow('database unavailable');
  });
});
