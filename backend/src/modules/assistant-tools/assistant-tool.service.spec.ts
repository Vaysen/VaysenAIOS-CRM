import { AssistantToolService } from './assistant-tool.service';
import { createServer } from 'node:http';

const LEAD = '11111111-1111-4111-8111-111111111111';
const USER = { id: 'user-1', activeCompanyId: 'company-1', activeCompany: { id: 'company-1', role: 'company_admin' }, companies: [{ id: 'company-1', role: 'company_admin' }] };

describe('AssistantToolService', () => {
  const row = (state: string, overrides: Record<string, any> = {}) => ({ id: 'execution-1', requestKey: 'request-1', idempotencyKey: 'idem-1', companyId: 'company-1', operatorUserId: 'user-1', toolName: 'message_draft_prepare', state, confirmationRequired: true, parameterSummary: { leadId: LEAD, channel: 'whatsapp', body: 'Hello' }, result: null, resultRef: null, errorCode: null, createdAt: new Date(), startedAt: null, completedAt: null, ...overrides });

  it('plans a write and leaves it awaiting confirmation', async () => {
    const created = row('AWAITING_CONFIRMATION');
    const prisma: any = {
      assistantToolExecution: { findUnique: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue(created) },
      lead: { findFirst: jest.fn().mockResolvedValue({ id: LEAD }) },
    };
    const service = new AssistantToolService(prisma, {} as any, {} as any, {} as any, {} as any);
    const result = await service.plan({ companyId: 'company-1', toolName: 'message_draft_prepare', requestId: 'request-1', parameters: { leadId: LEAD, channel: 'whatsapp', body: 'Hello' } }, USER);
    expect(result.state).toBe('AWAITING_CONFIRMATION');
    expect(prisma.assistantToolExecution.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ confirmationRequired: true, state: 'AWAITING_CONFIRMATION' }) }));
  });

  it('executes a confirmed message as a draft and never calls a sender', async () => {
    const planned = row('AWAITING_CONFIRMATION');
    const running = row('RUNNING');
    const succeeded = row('SUCCEEDED', { confirmationRequired: true, result: { status: 'DRAFT_ONLY', sent: false } });
    const prisma: any = {
      assistantToolExecution: {
        findFirst: jest.fn().mockResolvedValueOnce(planned).mockResolvedValueOnce({ ...planned, state: 'RUNNING', startedAt: new Date() }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue(succeeded),
      },
      conversation: { upsert: jest.fn().mockResolvedValue({ id: 'conversation-1' }) },
      communicationMessage: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn().mockResolvedValue({ id: 'message-1' }) },
    };
    const service = new AssistantToolService(prisma, {} as any, {} as any, {} as any, {} as any);
    const result = await service.confirm('execution-1', USER);
    expect(result.state).toBe('SUCCEEDED');
    expect(result.result).toEqual(expect.objectContaining({ status: 'DRAFT_ONLY', sent: false }));
    expect(prisma.assistantToolExecution.update).toHaveBeenCalled();
    void running;
  });

  it('does not let a viewer confirm a persistent message draft', async () => {
    const planned = row('AWAITING_CONFIRMATION');
    const failed = row('FAILED', { errorCode: 'TOOL_REJECTED_403' });
    const viewer = { ...USER, id: 'viewer-1', activeCompany: { id: 'company-1', role: 'viewer' }, companies: [{ id: 'company-1', role: 'viewer' }] };
    const prisma: any = {
      assistantToolExecution: { findFirst: jest.fn().mockResolvedValueOnce(planned).mockResolvedValueOnce(failed), updateMany: jest.fn().mockResolvedValue({ count: 1 }), update: jest.fn().mockResolvedValue(failed) },
      lead: { findFirst: jest.fn().mockResolvedValue({ id: LEAD, ownerUserId: 'owner-1' }) },
      conversation: { upsert: jest.fn() },
      communicationMessage: { findUnique: jest.fn(), upsert: jest.fn() },
    };
    const service = new AssistantToolService(prisma, {} as any, {} as any, {} as any, {} as any);
    const result = await service.confirm('execution-1', viewer);
    expect(result).toEqual(expect.objectContaining({ state: 'FAILED', errorCode: 'TOOL_REJECTED_403' }));
    expect(prisma.conversation.upsert).not.toHaveBeenCalled();
    expect(prisma.communicationMessage.upsert).not.toHaveBeenCalled();
  });

  it('rejects unsupported fields so model output cannot route arbitrary operations', async () => {
    const prisma: any = { assistantToolExecution: { findUnique: jest.fn() }, lead: { findFirst: jest.fn() } };
    const service = new AssistantToolService(prisma, {} as any, {} as any, {} as any, {} as any);
    await expect(service.plan({ companyId: 'company-1', toolName: 'customer_asset_read', parameters: { leadId: LEAD, url: 'http://evil' } }, USER)).rejects.toThrow('unsupported field');
  });

  it('routes every read tool through plan into the existing internal service', async () => {
    const assets = { getCustomerAsset: jest.fn().mockResolvedValue({ asset: true }) };
    const timeline = { findTimeline: jest.fn().mockResolvedValue({ events: [] }) };
    const quotes = { findAll: jest.fn().mockResolvedValue({ data: [] }) };
    const orders = { findAll: jest.fn().mockResolvedValue({ data: [] }) };
    const runRead = async (toolName: string, parameters: Record<string, unknown>, result: unknown) => {
      const rowData = row('PLANNING', { toolName, confirmationRequired: false, parameterSummary: parameters, result: null });
      const prisma: any = { assistantToolExecution: { findUnique: jest.fn().mockResolvedValue(null), findFirst: jest.fn().mockResolvedValue(rowData), create: jest.fn().mockResolvedValue(rowData), updateMany: jest.fn().mockResolvedValue({ count: 1 }), update: jest.fn().mockResolvedValue({ ...rowData, state: 'SUCCEEDED', result }) }, lead: { findFirst: jest.fn().mockResolvedValue({ id: LEAD, ownerUserId: USER.id }) } };
      const service = new AssistantToolService(prisma, assets as any, timeline as any, quotes as any, orders as any);
      await expect(service.plan({ companyId: 'company-1', toolName, parameters }, USER)).resolves.toEqual(expect.objectContaining({ state: 'SUCCEEDED', result }));
    };
    await runRead('customer_asset_read', { leadId: LEAD }, { asset: true });
    await runRead('customer_timeline_read', { leadId: LEAD, limit: 10 }, { events: [] });
    await runRead('order_status_read', { leadId: LEAD }, { data: [] });
    await runRead('quote_status_read', { leadId: LEAD }, { data: [] });
    expect(assets.getCustomerAsset).toHaveBeenCalledWith('company-1', LEAD, expect.objectContaining({
      id: USER.id,
      activeCompanyId: 'company-1',
    }));
    expect(timeline.findTimeline).toHaveBeenCalled();
    expect(orders.findAll).toHaveBeenCalled();
    expect(quotes.findAll).toHaveBeenCalled();
  });

  it('writes a real follow-up row only after confirmation and creates a quote through QuotesService', async () => {
    const runWrite = async (toolName: string, parameters: Record<string, unknown>, result: unknown, dependencies: Record<string, unknown>) => {
      const planned = row('AWAITING_CONFIRMATION', { toolName, parameterSummary: parameters });
      const succeeded = row('SUCCEEDED', { toolName, parameterSummary: parameters, result });
      const prisma: any = { assistantToolExecution: { findUnique: jest.fn().mockResolvedValue(null), findFirst: jest.fn().mockResolvedValue(planned), create: jest.fn().mockResolvedValue(planned), updateMany: jest.fn().mockResolvedValue({ count: 1 }), update: jest.fn().mockResolvedValue(succeeded) }, lead: { findFirst: jest.fn().mockResolvedValue({ id: LEAD, ownerUserId: USER.id }) }, quote: { findUnique: jest.fn().mockResolvedValue(null) }, ...dependencies };
      const service = new AssistantToolService(prisma, {} as any, {} as any, dependencies.quotes as any || {} as any, {} as any);
      const plannedResult = await service.plan({ companyId: 'company-1', toolName, parameters }, USER);
      expect(plannedResult.state).toBe('AWAITING_CONFIRMATION');
      await expect(service.confirm(plannedResult.id, USER)).resolves.toEqual(expect.objectContaining({ state: 'SUCCEEDED', result }));
      return prisma;
    };
    const followUp = { id: 'reminder-1', leadId: LEAD, title: 'Call customer', dueAt: new Date('2026-08-01T00:00:00.000Z') };
    const followUpPrisma = await runWrite('task_follow_up_create', { leadId: LEAD, title: 'Call customer', dueAt: '2026-08-01T00:00:00.000Z' }, { status: 'SUCCEEDED', id: 'reminder-1' }, { followUpReminder: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockResolvedValue(followUp) } });
    const quotes = { createQuote: jest.fn().mockResolvedValue({ id: 'quote-1', referenceNo: 'AI-execution-1', status: 'draft', totalAmount: 12 }) };
    const quotePrisma = await runWrite('quote_draft_create', { leadId: LEAD, lineItems: [{ productName: 'Bag', quantity: 1, unitPrice: 12 }] }, { status: 'SUCCEEDED', id: 'quote-1', sent: false }, { quotes });
    expect(followUpPrisma.followUpReminder.create).toHaveBeenCalledTimes(1);
    expect(quotePrisma).toBeTruthy();
    expect(quotes.createQuote).toHaveBeenCalledTimes(1);
  });

  it('claims confirmation once under concurrent confirmation and preserves idempotency', async () => {
    const planned = row('AWAITING_CONFIRMATION');
    const succeeded = row('SUCCEEDED', { result: { status: 'DRAFT_ONLY', sent: false } });
    const prisma: any = {
      assistantToolExecution: {
        findUnique: jest.fn().mockResolvedValue(planned),
        findFirst: jest.fn().mockResolvedValue(planned),
        updateMany: jest.fn().mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 }),
        update: jest.fn().mockResolvedValue(succeeded),
      },
    };
    const service = new AssistantToolService(prisma, {} as any, {} as any, {} as any, {} as any);
    const [first, second] = await Promise.all([service.confirm('execution-1', USER), service.confirm('execution-1', USER)]);
    expect(first.state).toBe('SUCCEEDED');
    expect(second.state).toBe('AWAITING_CONFIRMATION');
    expect(prisma.assistantToolExecution.updateMany).toHaveBeenCalledTimes(2);
  });

  it('cancels without dispatching and rejects another tenant', async () => {
    const planned = row('AWAITING_CONFIRMATION');
    const cancelled = row('CANCELLED', { errorCode: 'CANCELLED_BY_USER' });
    const prisma: any = {
      assistantToolExecution: {
        findFirst: jest.fn().mockResolvedValueOnce(planned).mockResolvedValueOnce(cancelled),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const service = new AssistantToolService(prisma, {} as any, {} as any, {} as any, {} as any);
    const result = await service.cancel('execution-1', USER);
    expect(result.state).toBe('CANCELLED');
    expect(prisma.assistantToolExecution.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ errorCode: 'CANCELLED_BY_USER' }) }));
    await expect(service.history('other-company', USER)).rejects.toThrow('Company must be the active company');
    void cancelled;
  });

  it('records execution failure rather than reporting success', async () => {
    const planned = row('PLANNING', { confirmationRequired: false, toolName: 'customer_asset_read' });
    const failed = row('FAILED', { confirmationRequired: false, state: 'FAILED', errorCode: 'TOOL_EXECUTION_FAILED' });
    const prisma: any = {
      assistantToolExecution: {
        findUnique: jest.fn().mockResolvedValue(null),
        findFirst: jest.fn().mockResolvedValue(planned),
        create: jest.fn().mockResolvedValue(planned),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue(failed),
      },
      lead: { findFirst: jest.fn().mockResolvedValue({ id: LEAD }) },
    };
    const assets = { getCustomerAsset: jest.fn().mockRejectedValue(new Error('service down')) };
    const service = new AssistantToolService(prisma, assets as any, {} as any, {} as any, {} as any);
    const result = await service.plan({ companyId: 'company-1', toolName: 'customer_asset_read', parameters: { leadId: LEAD } }, USER);
    expect(result.state).toBe('FAILED');
    expect(result.errorCode).toBe('TOOL_EXECUTION_FAILED');
  });

  it('reports provider not_configured and validates a real local stub response', async () => {
    const prisma: any = {};
    const service = new AssistantToolService(prisma, {} as any, {} as any, {} as any, {} as any);
    delete process.env.AI_PROVIDER_ENDPOINT;
    delete process.env.AI_PROVIDER_MODEL;
    delete process.env.AI_PROVIDER_API_KEY;
    await expect(service.providerConnectionTest()).resolves.toEqual(expect.objectContaining({ ok: false, status: 'not_configured' }));
    const server = createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ model: 'stub-model', choices: [{ message: { content: 'ok' } }] })); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('stub did not bind');
    process.env.AI_PROVIDER_ENDPOINT = `http://127.0.0.1:${address.port}/v1/chat/completions`;
    process.env.AI_PROVIDER_MODEL = 'stub-model';
    process.env.AI_PROVIDER_API_KEY = 'stub-key';
    await expect(service.providerConnectionTest()).resolves.toEqual(expect.objectContaining({ ok: true, status: 'ok' }));
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    delete process.env.AI_PROVIDER_ENDPOINT;
    delete process.env.AI_PROVIDER_MODEL;
    delete process.env.AI_PROVIDER_API_KEY;
  });

  it('returns a healthy RUNNING lease without redispatching', async () => {
    const running = row('RUNNING', { startedAt: new Date() });
    const prisma: any = { assistantToolExecution: { findFirst: jest.fn().mockResolvedValue(running), updateMany: jest.fn() } };
    const service = new AssistantToolService(prisma, {} as any, {} as any, {} as any, {} as any);
    await expect(service.confirm('execution-1', USER)).resolves.toEqual(expect.objectContaining({ state: 'RUNNING' }));
    expect(prisma.assistantToolExecution.updateMany).not.toHaveBeenCalled();
  });

  it('reclaims one expired RUNNING lease and reconciles an existing follow-up', async () => {
    process.env.AI_TOOL_RUNNING_LEASE_MS = '1';
    const running = row('RUNNING', { toolName: 'task_follow_up_create', startedAt: new Date(Date.now() - 1000), parameterSummary: { leadId: LEAD, title: 'Retry me', dueAt: '2026-08-01T00:00:00.000Z' } });
    const succeeded = row('SUCCEEDED', { toolName: 'task_follow_up_create', parameterSummary: running.parameterSummary, result: { status: 'SUCCEEDED', id: 'reminder-1' } });
    const prisma: any = {
      assistantToolExecution: { findFirst: jest.fn().mockResolvedValueOnce(running).mockResolvedValueOnce({ ...running, startedAt: new Date() }).mockResolvedValueOnce(succeeded), updateMany: jest.fn().mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 1 }), update: jest.fn().mockResolvedValue(succeeded) },
      lead: { findFirst: jest.fn().mockResolvedValue({ id: LEAD, ownerUserId: USER.id }) },
      followUpReminder: { findFirst: jest.fn().mockResolvedValue({ id: 'reminder-1', leadId: LEAD, title: 'Retry me', dueAt: new Date() }), create: jest.fn() },
    };
    const service = new AssistantToolService(prisma, {} as any, {} as any, {} as any, {} as any);
    await expect(service.confirm('execution-1', USER)).resolves.toEqual(expect.objectContaining({ state: 'SUCCEEDED' }));
    expect(prisma.followUpReminder.create).not.toHaveBeenCalled();
    delete process.env.AI_TOOL_RUNNING_LEASE_MS;
  });
});
