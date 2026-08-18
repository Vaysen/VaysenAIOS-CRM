import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { createServer, type Server } from 'http';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CommunicationsController } from './communications.controller';
import { CommunicationsService } from './communications.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RealtimeEventBus } from '../../common/realtime/realtime-event-bus';
import { CustomerMergeService } from '../customer-identity/customer-merge.service';
import { WhatsAppService } from '../whatsapp/whatsapp.service';
import { WhatsAppAdapter } from '../whatsapp/whatsapp-adapter';
import { EvolutionApiService } from '../whatsapp/evolution-api.service';
import { OwnerNotificationService } from '../owner-notifications/owner-notification.service';
import { IdentityResolutionService } from '../customer-identity/identity-resolution.service';
import { OutboundComplianceService } from '../outbound/outbound-compliance.service';
import { AssistantPermissionService } from '../agent/assistant-permission.service';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  assertRealPgEnabled,
  assertRealPgIdentity,
  parseRealPgDatabaseUrl,
  type RealPgExpectedIdentity,
} from '../../../test/real-pg-safety';

const realPgEnabled = process.env.LAN_COMMUNICATIONS_REAL_PG === '1';
const realPgDescribe = realPgEnabled ? describe : describe.skip;

realPgDescribe('real PostgreSQL Communications -> WhatsAppService -> Evolution stub', () => {
  jest.setTimeout(120000);
  const companyId = '11111111-1111-4111-8111-111111111111';
  const userId = '22222222-2222-4222-8222-222222222222';
  const leadId = '33333333-3333-4333-8333-333333333333';
  const conversationId = '44444444-4444-4444-8444-444444444444';
  const sessionId = '55555555-5555-4555-8555-555555555555';
  const contactPointId = '66666666-6666-4666-8666-666666666666';
  const user = { id: userId, activeCompanyId: companyId, activeCompany: { id: companyId, role: 'company_admin' }, companies: [{ id: companyId, role: 'company_admin' }] };
  let prisma: PrismaService;
  let app: INestApplication;
  let stub: Server;
  let stubPort: number;
  let providerMode: 'success' | 'rejected' | 'unknown' = 'success';
  let providerCalls = 0;
  let expectedPgIdentity: RealPgExpectedIdentity;
  let mediaFixturePath: string | undefined;
  const touchedEnvKeys = [
    'NODE_ENV',
    'EVOLUTION_API_ENABLED',
    'EVOLUTION_API_LOCAL_STUB',
    'EVOLUTION_API_KEY',
    'EVOLUTION_WEBHOOK_SECRET',
    'BACKEND_URL',
    'EVOLUTION_API_URL',
  ] as const;
  const originalEnv = new Map<string, string | undefined>();

  beforeAll(async () => {
    assertRealPgEnabled();
    expectedPgIdentity = parseRealPgDatabaseUrl(process.env.DATABASE_URL);
    for (const key of touchedEnvKeys) originalEnv.set(key, process.env[key]);

    process.env.NODE_ENV = 'test';
    process.env.EVOLUTION_API_ENABLED = 'true';
    process.env.EVOLUTION_API_LOCAL_STUB = 'true';
    process.env.EVOLUTION_API_KEY = 'lan-pg-stub-key-123456';
    process.env.EVOLUTION_WEBHOOK_SECRET = 'lan-pg-stub-webhook-secret-123456789';
    process.env.BACKEND_URL = 'http://127.0.0.1:3001';
    stub = createServer((req, res) => {
      providerCalls += 1;
      if (providerMode === 'unknown') { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{}'); return; }
      if (providerMode === 'rejected') { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ code: 'INVALID_NUMBER' })); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ key: { id: req.url?.includes('sendDocument') ? 'evo-pdf-real-1' : 'evo-text-real-1' }, status: 'accepted', timestamp: new Date().toISOString() }));
    });
    await new Promise<void>(resolve => stub.listen(0, '127.0.0.1', resolve));
    stubPort = (stub.address() as any).port;
    process.env.EVOLUTION_API_URL = `http://127.0.0.1:${stubPort}`;

    prisma = new PrismaService();
    await prisma.$connect();
    const identityRows = await prisma.$queryRaw<Array<{
      currentDatabase: string | null;
      currentUser: string | null;
      serverAddr: string | null;
      serverPort: number | string | null;
    }>>`
      SELECT
        current_database() AS "currentDatabase",
        current_user AS "currentUser",
        inet_server_addr()::text AS "serverAddr",
        inet_server_port() AS "serverPort"
    `;
    assertRealPgIdentity(expectedPgIdentity, identityRows[0]);
    await prisma.$executeRawUnsafe('TRUNCATE TABLE "Company", "User", "Role" CASCADE');
    const role = await prisma.role.upsert({ where: { name: 'company_admin' }, update: {}, create: { name: 'company_admin', displayName: 'Company Admin', isSystem: true } });
    await prisma.company.create({ data: { id: companyId, name: 'LAN Test Company', slug: 'lan-test-company' } });
    await prisma.user.create({ data: { id: userId, email: 'lan-pg@example.test', passwordHash: 'test', firstName: 'LAN', lastName: 'PG' } });
    await prisma.userCompanyRelation.create({ data: { userId, companyId, roleId: role.id, isDefault: true } });
    await prisma.lead.create({ data: { id: leadId, companyId, companyName: 'Target Company', contactName: 'Buyer', whatsapp: '+15550001111', contactPhone: '+15550001111', status: 'qualified', reviewStatus: 'approved', ownerUserId: userId } });
    await prisma.contactPoint.create({ data: { id: contactPointId, companyId, leadId, type: 'whatsapp', originalValue: '+15550001111', normalizedValue: '+15550001111', isVerified: true, verificationMethod: 'admin_verified' } });
    await prisma.whatsAppSession.create({ data: { id: sessionId, companyId, accountName: 'LAN Evolution', sessionId: 'lan-instance', status: 'connected', authStatePath: 'evolution-api:lan-instance' } });
    await prisma.conversation.create({ data: { id: conversationId, companyId, leadId, contactPointId, channel: 'whatsapp', isGroup: false, externalThreadId: '+15550001111', threadKey: `whatsapp:${sessionId}:+15550001111`, whatsappSessionId: sessionId, status: 'active' } });
    await prisma.externalIdentity.create({ data: { companyId, provider: 'whatsapp', externalId: '+15550001111', identityStatus: 'resolved', leadId, contactPointId } });

    const eventBus = new RealtimeEventBus();
    const adapter = { isConnected: jest.fn().mockReturnValue(false), sendTextMessage: jest.fn(), sendMediaMessage: jest.fn() } as unknown as WhatsAppAdapter;
    const evolution = new EvolutionApiService();
    const permissions = new AssistantPermissionService(prisma);
    const outbound = new OutboundComplianceService(prisma, permissions);
    const whatsapp = new WhatsAppService(prisma, adapter, evolution, eventBus, {} as IdentityResolutionService, {} as OwnerNotificationService, outbound);
    const communications = new CommunicationsService(prisma, whatsapp, eventBus);
    const module = await Test.createTestingModule({
      controllers: [CommunicationsController],
      providers: [{ provide: CommunicationsService, useValue: communications }, { provide: RealtimeEventBus, useValue: eventBus }, { provide: CustomerMergeService, useValue: {} }],
    }).overrideGuard(JwtAuthGuard).useValue({ canActivate: () => true }).compile();
    app = module.createNestApplication();
    app.use((req: any, _res: any, next: () => void) => { req.user = user; next(); });
    await app.init();
  });

  afterAll(async () => {
    try {
      if (prisma && expectedPgIdentity) {
        const identityRows = await prisma.$queryRaw<Array<{
          currentDatabase: string | null;
          currentUser: string | null;
          serverAddr: string | null;
          serverPort: number | string | null;
        }>>`
          SELECT
            current_database() AS "currentDatabase",
            current_user AS "currentUser",
            inet_server_addr()::text AS "serverAddr",
            inet_server_port() AS "serverPort"
        `;
        assertRealPgIdentity(expectedPgIdentity, identityRows[0]);
        await prisma.$executeRawUnsafe('TRUNCATE TABLE "Company", "User", "Role" CASCADE');
      }
    } finally {
      await app?.close();
      await prisma?.$disconnect();
      await new Promise<void>(resolve => {
        if (!stub || !stub.listening) return resolve();
        stub.close(() => resolve());
      });
      if (mediaFixturePath) fs.rmSync(mediaFixturePath, { force: true });
      for (const key of touchedEnvKeys) {
        const value = originalEnv.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it('uses the real tenant marker, Outbox reservation, receipt persistence, and idempotency', async () => {
    providerMode = 'success';
    const response = await request(app.getHttpServer()).post(`/communications/conversations/${conversationId}/messages`).set('idempotency-key', 'lan-real-text-1').send({ direction: 'outbound', content: 'hello real evolution', contentType: 'text' }).expect(201);
    expect(response.body.externalMessageId).toBe('evo-text-real-1');
    const rows = await prisma.externalActionOutbox.findMany({ where: { companyId, idempotencyKey: 'lan-real-text-1' } });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('SUCCEEDED');
    expect(rows[0].providerReceiptId).toBe('evo-text-real-1');
    expect(rows[0].attemptCount).toBe(1);
    expect((await prisma.communicationMessage.findFirst({ where: { externalMessageId: 'evo-text-real-1' } }))?.deliveryStatus).toBe('sent');
    await request(app.getHttpServer()).post(`/communications/conversations/${conversationId}/messages`).set('idempotency-key', 'lan-real-text-1').send({ direction: 'outbound', content: 'hello real evolution', contentType: 'text' }).expect(201);
    expect(providerCalls).toBe(1);
  });

  it('uses real media bytes and records explicit rejection without pretending sent', async () => {
    const tenant = createHash('sha256').update(companyId).digest('hex').slice(0, 24);
    const uploader = createHash('sha256').update(userId).digest('hex').slice(0, 24);
    const root = path.resolve(process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads'));
    const dir = path.join(root, 'communications', tenant, uploader);
    mediaFixturePath = path.join(dir, 'quote.pdf');
    fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(mediaFixturePath, Buffer.from('%PDF-real'));
    providerMode = 'rejected';
    await request(app.getHttpServer()).post(`/communications/conversations/${conversationId}/messages`).set('idempotency-key', 'lan-real-pdf-1').send({ direction: 'outbound', content: 'Quote', contentType: 'document', attachmentsMeta: { url: `/uploads/communications/${tenant}/${uploader}/quote.pdf`, originalName: 'quote.pdf', mimeType: 'application/pdf' } }).expect(503);
    const row = await prisma.externalActionOutbox.findFirst({ where: { companyId, idempotencyKey: 'lan-real-pdf-1' } });
    expect(row?.status).toBe('FAILED');
    expect(row?.providerReceiptId).toBeNull();
    expect(await prisma.communicationMessage.count({ where: { conversationId, externalMessageId: 'evo-pdf-real-1' } })).toBe(0);
    await prisma.externalActionOutbox.update({ where: { id: row!.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    providerMode = 'success';
    await request(app.getHttpServer()).post(`/communications/conversations/${conversationId}/messages`).set('idempotency-key', 'lan-real-pdf-1').send({ direction: 'outbound', content: 'Quote', contentType: 'document', attachmentsMeta: { url: `/uploads/communications/${tenant}/${uploader}/quote.pdf`, originalName: 'quote.pdf', mimeType: 'application/pdf' } }).expect(201);
    expect((await prisma.externalActionOutbox.findUnique({ where: { id: row!.id } }))?.status).toBe('SUCCEEDED');
  });

  it('keeps UNKNOWN durable and refuses a blind second provider call', async () => {
    providerMode = 'unknown';
    await request(app.getHttpServer()).post(`/communications/conversations/${conversationId}/messages`).set('idempotency-key', 'lan-real-unknown-1').send({ direction: 'outbound', content: 'unknown', contentType: 'text' }).expect(503);
    const row = await prisma.externalActionOutbox.findFirst({ where: { companyId, idempotencyKey: 'lan-real-unknown-1' } });
    expect(row?.status).toBe('UNKNOWN');
    const callsAfterUnknown = providerCalls;
    await request(app.getHttpServer()).post(`/communications/conversations/${conversationId}/messages`).set('idempotency-key', 'lan-real-unknown-1').send({ direction: 'outbound', content: 'unknown', contentType: 'text' }).expect(409);
    expect(providerCalls).toBe(callsAfterUnknown);
  });
});
