import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AgentController } from './agent.controller';
import { AgentService } from './agent.service';
import { AssistantPermissionService } from './assistant-permission.service';
import { AssistantExternalActionService } from './assistant-external-action.service';

describe('AgentController HTTP contract', () => {
  let app: INestApplication;
  const service = {
    create: jest.fn(),
    list: jest.fn(),
    findOne: jest.fn(),
    cancel: jest.fn(),
    confirmAuthorization: jest.fn(),
    getPendingAssistantActions: jest.fn(),
    confirmAssistantAction: jest.fn(),
    completeAssistantAction: jest.fn(),
    releaseAssistantAction: jest.fn(),
  };
  const permissions = {
    getProfile: jest.fn(),
    updateProfile: jest.fn(),
    listTemporaryGrants: jest.fn(),
    createTemporaryGrant: jest.fn(),
    revokeTemporaryGrant: jest.fn(),
  };
  const externalActions = {
    authorizeWhatsappTextSend: jest.fn(),
    completeWhatsappTextSend: jest.fn(),
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [AgentController],
      providers: [
        { provide: AgentService, useValue: service },
        { provide: AssistantPermissionService, useValue: permissions },
        { provide: AssistantExternalActionService, useValue: externalActions },
      ],
    }).compile();
    app = module.createNestApplication();
    app.use((req: any, _res: any, next: () => void) => {
      req.user = {
        id: 'user-1',
        companies: [{ id: '11111111-1111-4111-8111-111111111111', role: 'sales_user' }],
      };
      next();
    });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
  });

  afterAll(() => app.close());
  beforeEach(() => jest.clearAllMocks());

  it('accepts only an allowlisted safe run kind', async () => {
    service.create.mockResolvedValue({ id: 'run-1', status: 'COMPLETED' });
    await request(app.getHttpServer())
      .post('/agent-runs')
      .send({
        companyId: '11111111-1111-4111-8111-111111111111',
        leadId: '33333333-3333-4333-8333-333333333333',
        kind: 'READ_LEAD_SUMMARY',
      })
      .expect(201)
      .expect({ id: 'run-1', status: 'COMPLETED' });
    expect(service.create).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'READ_LEAD_SUMMARY' }),
      expect.objectContaining({ id: 'user-1' }),
    );
  });

  it('rejects unknown tools at DTO validation', async () => {
    await request(app.getHttpServer())
      .post('/agent-runs')
      .send({
        companyId: '11111111-1111-4111-8111-111111111111',
        leadId: '33333333-3333-4333-8333-333333333333',
        kind: 'SEND_WHATSAPP',
      })
      .expect(400);
    expect(service.create).not.toHaveBeenCalled();
  });

  it('does not expose an arbitrary status PATCH endpoint', async () => {
    await request(app.getHttpServer())
      .patch('/agent-runs/run-1')
      .send({ status: 'COMPLETED' })
      .expect(404);
  });

  it('validates the explicit one-time WhatsApp send authorization contract', async () => {
    externalActions.authorizeWhatsappTextSend.mockResolvedValue({
      status: 'CLAIMED',
      actionId: 'action-1',
    });
    const payload = {
      companyId: '11111111-1111-4111-8111-111111111111',
      conversationId: '22222222-2222-4222-8222-222222222222',
      requestId: '33333333-3333-4333-8333-333333333333',
      targetPhone: '+1 415 555 0100',
      text: 'Hello buyer',
      confirmed: true,
    };
    await request(app.getHttpServer())
      .post('/agent-runs/assistant/external-actions/whatsapp-text/authorize')
      .send(payload)
      .expect(201)
      .expect({ status: 'CLAIMED', actionId: 'action-1' });
    expect(externalActions.authorizeWhatsappTextSend).toHaveBeenCalledWith(
      payload,
      expect.objectContaining({ id: 'user-1' }),
    );

    await request(app.getHttpServer())
      .post('/agent-runs/assistant/external-actions/whatsapp-text/authorize')
      .send({ ...payload, confirmed: false, extra: true })
      .expect(400);
  });

  it('exposes the authenticated pending quote action list with a validated company id', async () => {
    service.getPendingAssistantActions.mockResolvedValue([{
      id: '33333333-3333-4333-8333-333333333333',
      createdAt: '2026-07-15T00:00:00.000Z',
      source: 'WECHAT_OWNER',
      actionProposal: { kind: 'PREPARE_QUOTE_DELIVERY' },
    }]);
    await request(app.getHttpServer())
      .get('/agent-runs/assistant/pending-actions')
      .query({ companyId: '11111111-1111-4111-8111-111111111111' })
      .expect(200)
      .expect((response) => {
        expect(response.body).toHaveLength(1);
        expect(response.body[0].source).toBe('WECHAT_OWNER');
      });
    expect(service.getPendingAssistantActions).toHaveBeenCalledWith(
      '11111111-1111-4111-8111-111111111111',
      expect.objectContaining({ id: 'user-1' }),
    );

    await request(app.getHttpServer())
      .get('/agent-runs/assistant/pending-actions')
      .query({ companyId: 'not-a-uuid' })
      .expect(400);
  });

  it('exposes a strict claim, complete, and release quote-preparation protocol', async () => {
    const proposalId = '33333333-3333-4333-8333-333333333333';
    const claimToken = Buffer.alloc(32, 3).toString('base64url');
    service.confirmAssistantAction.mockResolvedValue({
      proposalId, status: 'PREPARATION_CLAIMED', claimToken,
    });
    service.completeAssistantAction.mockResolvedValue({
      proposalId, status: 'PREPARATION_CONFIRMED', accepted: true,
    });
    service.releaseAssistantAction.mockResolvedValue({
      proposalId, status: 'PREPARATION_RELEASED', accepted: false,
    });

    await request(app.getHttpServer())
      .post(`/agent-runs/assistant/actions/${proposalId}/confirm`)
      .send({})
      .expect(201)
      .expect((response) => expect(response.body.status).toBe('PREPARATION_CLAIMED'));
    expect(service.confirmAssistantAction).toHaveBeenCalledWith(
      proposalId,
      expect.objectContaining({ id: 'user-1' }),
    );

    await request(app.getHttpServer())
      .post(`/agent-runs/assistant/actions/${proposalId}/complete`)
      .send({ claimToken })
      .expect(201)
      .expect((response) => expect(response.body.status).toBe('PREPARATION_CONFIRMED'));
    expect(service.completeAssistantAction).toHaveBeenCalledWith(
      proposalId,
      claimToken,
      expect.objectContaining({ id: 'user-1' }),
    );

    await request(app.getHttpServer())
      .post(`/agent-runs/assistant/actions/${proposalId}/release`)
      .send({ claimToken, failureCode: 'PDF_DOWNLOAD_FAILED' })
      .expect(201)
      .expect((response) => expect(response.body.status).toBe('PREPARATION_RELEASED'));
    expect(service.releaseAssistantAction).toHaveBeenCalledWith(
      proposalId,
      claimToken,
      'PDF_DOWNLOAD_FAILED',
      expect.objectContaining({ id: 'user-1' }),
    );

    await request(app.getHttpServer())
      .post(`/agent-runs/assistant/actions/${proposalId}/complete`)
      .send({ claimToken: 'not-a-valid-token', unexpected: true })
      .expect(400);
    await request(app.getHttpServer())
      .post(`/agent-runs/assistant/actions/${proposalId}/release`)
      .send({ claimToken, failureCode: 'unsafe free form' })
      .expect(400);
  });
});
