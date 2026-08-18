import { BadRequestException } from '@nestjs/common';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('../whatsapp/whatsapp.service', () => ({ WhatsAppService: class WhatsAppService {} }));

import { CommunicationsService } from './communications.service';
import { communicationUploadScopeSegments } from './attachment-security';

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
        findFirst: jest.fn().mockResolvedValue({
          id: 'conversation-1', companyId: 'company-1', channel: 'whatsapp',
          whatsappSessionId: 'session-1', externalThreadId: '123@s.whatsapp.net',
          lead: null, contactPoint: null, unreadCount: 0,
        }),
        update: jest.fn(),
      },
      communicationMessage: { create: jest.fn() },
      userCompanyRelation: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'membership-1',
          role: { name: 'sales_user' },
        }),
      },
    } as any;
    const whatsapp = { sendMediaOnly: jest.fn(), sendTextOnly: jest.fn() } as any;
    const service = new CommunicationsService(prisma, whatsapp, {} as any);

    try {
      await expect(service.addMessage('conversation-1', {
        direction: 'outbound', content: '', contentType: 'document',
        attachmentsMeta: { path: secret, originalName: 'secret.txt' },
      }, {
        id: 'user-1',
        activeCompanyId: 'company-1',
    activeCompany: { id: 'company-1', name: 'company-1', role: 'sales_user' },
    companies: [{ id: 'company-1', name: 'company-1', role: 'sales_user' }],
      } as any))
        .rejects.toBeInstanceOf(BadRequestException);
      expect(whatsapp.sendMediaOnly).not.toHaveBeenCalled();
      expect(prisma.communicationMessage.create).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.UPLOADS_DIR;
      else process.env.UPLOADS_DIR = previous;
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });

  it('rejects an existing attachment URL from another tenant or uploader scope', async () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'vaysen-crm-media-tenant-'));
    const uploads = path.join(sandbox, 'uploads');
    const foreignScope = communicationUploadScopeSegments(
      'company-2',
      'user-2',
    );
    const foreignDirectory = path.join(
      uploads,
      'communications',
      foreignScope.tenantSegment,
      foreignScope.userSegment,
    );
    fs.mkdirSync(foreignDirectory, { recursive: true });
    const foreignFile = path.join(foreignDirectory, 'comm-foreign.pdf');
    fs.writeFileSync(foreignFile, '%PDF-1.4 foreign');
    const previous = process.env.UPLOADS_DIR;
    process.env.UPLOADS_DIR = uploads;

    const prisma = {
      conversation: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'conversation-1',
          companyId: 'company-1',
          channel: 'whatsapp',
          whatsappSessionId: 'session-1',
          externalThreadId: '123@s.whatsapp.net',
          lead: null,
          contactPoint: null,
          unreadCount: 0,
        }),
      },
      communicationMessage: { create: jest.fn() },
      userCompanyRelation: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'membership-1',
          role: { name: 'sales_user' },
        }),
      },
    } as any;
    const whatsapp = { sendMediaOnly: jest.fn(), sendTextOnly: jest.fn() } as any;
    const service = new CommunicationsService(prisma, whatsapp, {} as any);
    const foreignUrl =
      `/uploads/communications/${foreignScope.tenantSegment}/${foreignScope.userSegment}/comm-foreign.pdf`;

    try {
      await expect(service.addMessage('conversation-1', {
        direction: 'outbound',
        content: '',
        contentType: 'document',
        attachmentsMeta: {
          url: foreignUrl,
          originalName: 'foreign.pdf',
        },
      }, {
        id: 'user-1',
        activeCompanyId: 'company-1',
        activeCompany: { id: 'company-1', name: 'company-1', role: 'sales_user' },
        companies: [{ id: 'company-1', name: 'company-1', role: 'sales_user' }],
      } as any)).rejects.toBeInstanceOf(BadRequestException);
      expect(whatsapp.sendMediaOnly).not.toHaveBeenCalled();
      expect(prisma.communicationMessage.create).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.UPLOADS_DIR;
      else process.env.UPLOADS_DIR = previous;
      fs.rmSync(sandbox, { recursive: true, force: true });
    }
  });
});
