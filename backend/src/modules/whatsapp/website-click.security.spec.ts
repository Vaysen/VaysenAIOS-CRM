import {
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { createHmac } from 'crypto';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { WhatsAppService } from './whatsapp.service';
import { WebsiteWhatsAppClickDto } from './dto/website-click.dto';

const sourceSecret = 'test-only-whatsapp-source-secret-1234567890';

function signedClick(overrides: Record<string, unknown> = {}) {
  const params: any = {
    sourceKey: 'website-main',
    timestamp: Math.floor(Date.now() / 1000),
    nonce: 'nonce_1234567890abcdef',
    whatsappNumber: '+12025550123',
    contactName: 'Buyer',
    companyName: 'Buyer Co',
    country: 'US',
    sourceUrl: 'https://site.example/contact',
    utmSource: 'campaign',
    ...overrides,
  };
  const canonical = [
    'v1',
    params.sourceKey,
    String(params.timestamp),
    params.nonce,
    params.whatsappNumber,
    params.contactName || '',
    params.companyName || '',
    params.country || '',
    params.sourceUrl || '',
    params.utmSource || '',
  ].join('\n');
  params.signature = createHmac('sha256', sourceSecret)
    .update(canonical, 'utf8')
    .digest('hex');
  return params;
}

describe('signed public WhatsApp click ingress', () => {
  let prisma: any;
  let resolver: any;
  let service: WhatsAppService;

  beforeEach(() => {
    process.env.WHATSAPP_CLICK_SOURCES = JSON.stringify([{
      sourceKey: 'website-main',
      companyId: 'tenant-bound-by-server',
      secret: sourceSecret,
      allowedOrigins: ['https://site.example'],
    }]);
    prisma = {
      company: {
        findFirst: jest.fn().mockResolvedValue({ id: 'tenant-bound-by-server' }),
      },
      publicRequestNonce: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        create: jest.fn().mockResolvedValue({ id: 'nonce-row' }),
      },
    };
    resolver = {
      resolve: jest.fn().mockResolvedValue({ action: 'unresolved' }),
    };
    service = new WhatsAppService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      resolver,
      {} as any,
      {} as any,
    );
  });

  it('rejects a forged signature before any CRM database write', async () => {
    const forged = { ...signedClick(), signature: '0'.repeat(64) };
    await expect(service.recordClick(forged, 'https://site.example'))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.company.findFirst).not.toHaveBeenCalled();
    expect(prisma.publicRequestNonce.create).not.toHaveBeenCalled();
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it('binds a verified source to its configured tenant only', async () => {
    const result = await service.recordClick(
      signedClick(),
      'https://site.example',
    );

    expect(prisma.company.findFirst).toHaveBeenCalledWith({
      where: { id: 'tenant-bound-by-server', isActive: true },
      select: { id: true },
    });
    expect(resolver.resolve).toHaveBeenCalledWith(expect.objectContaining({
      companyId: 'tenant-bound-by-server',
    }));
    expect(result).toEqual({
      accepted: true,
      matched: false,
      isNew: false,
    });
  });

  it('rejects a replayed nonce', async () => {
    prisma.publicRequestNonce.create.mockRejectedValue(
      Object.assign(new Error('unique'), { code: 'P2002' }),
    );
    await expect(service.recordClick(
      signedClick(),
      'https://site.example',
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(resolver.resolve).not.toHaveBeenCalled();
  });

  it('forbids client-supplied company selectors at the DTO boundary', async () => {
    const dto = plainToInstance(WebsiteWhatsAppClickDto, {
      ...signedClick(),
      companyId: 'attacker-tenant',
      companySlug: 'attacker',
    });
    const errors = await validate(dto, {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
    expect(errors.map((error) => error.property)).toEqual(
      expect.arrayContaining(['companyId', 'companySlug']),
    );
  });
});
