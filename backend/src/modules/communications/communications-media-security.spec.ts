import { BadRequestException } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('../whatsapp/whatsapp.service', () => ({ WhatsAppService: class WhatsAppService {} }));

import { CommunicationsService } from './communications.service';

describe('CommunicationsService WhatsApp media isolation', () => {
  it('does not read or send an attachmentsMeta path outside uploads', async () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'vaysen-crm-media-service-'));
    const uploads = path.join(sandbox, 'uploads');
    const secret = path.join(sandbox, 'secret.txt');
    fs.mkdirSync(uploads);
    fs.writeFileSync(secret, 'must never leave the server');
    const previous = process.env.UPLOADS_DIR;
    process.env.UPLOADS_DIR = uploads;

    const prisma = {
      conversation: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'conversation-1', companyId: 'company-1', channel: 'whatsapp',
          whatsappSessionId: 'session-1', externalThreadId: '123@s.whatsapp.net',
          lead: null, contactPoint: null, unreadCount: 0,
        }),
        update: jest.fn(),
      },
      communicationMessage: { create: jest.fn() },
    } as any;
    const whatsapp = { sendMediaOnly: jest.fn(), sendTextOnly: jest.fn() } as any;
    const service = new CommunicationsService(prisma, whatsapp, {} as any);

    try {
      await expect(service.addMessage('conversation-1', {
        direction: 'outbound', content: '', contentType: 'document',
        attachmentsMeta: { path: secret, originalName: 'secret.txt' },
      }, { id: 'user-1', companies: [{ id: 'company-1' }] } as any))
        .rejects.toBeInstanceOf(BadRequestException);
      expect(whatsapp.sendMediaOnly).not.toHaveBeenCalled();
      expect(prisma.communicationMessage.create).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.UPLOADS_DIR;
      else process.env.UPLOADS_DIR = previous;
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
