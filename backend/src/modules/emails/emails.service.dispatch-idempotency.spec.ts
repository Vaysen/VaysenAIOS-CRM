import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { EmailsService } from './emails.service';

describe('EmailsService durable request idempotency', () => {
  const user = {
    id: 'user-1',
    activeCompanyId: 'company-1',
    activeCompany: {
      id: 'company-1',
      name: 'Example Company',
      website: 'https://example.com',
      role: 'company_admin',
    },
    companies: [{
      id: 'company-1',
      name: 'Example Company',
      website: 'https://example.com',
      role: 'company_admin',
    }],
  };

  const lead = (id: string, contactEmail = `${id}@buyer.example.com`) => ({
    id,
    companyId: 'company-1',
    ownerUserId: 'user-1',
    contactEmail,
    contactName: `Buyer ${id}`,
    companyName: `Buyer Company ${id}`,
    country: 'US',
    website: 'https://buyer.example.com',
    mainProducts: 'Packaging',
    status: 'new',
    reviewStatus: 'approved',
    emailVerificationStatus: 'official_page_verified',
    emailVerificationReason: 'Verified on the official website',
    deletedAt: null,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
  });

  function harness(initialLeads = [lead('lead-1')]) {
    const leads: any[] = initialLeads;
    let leadOrder = [...leads];
    const requests = new Map<string, any>();
    const messages = new Map<string, any>();
    const activities = new Map<string, any>();
    const queuedJobs = new Map<string, any>();
    const templateRow = {
      id: 'template-1',
      companyId: 'company-1',
      createdBy: 'user-1',
      subject: 'Hello {{contact_name}}',
      body: '<p>Hello {{contact_name}}</p>',
      variables: [],
      useCount: 0,
    };

    const requestCreate = jest.fn(async ({ data }: any) => {
      const index = `${data.companyId}:${data.idempotencyKey}`;
      if (requests.has(index)) {
        throw Object.assign(new Error('unique request'), { code: 'P2002' });
      }
      const row = {
        ...data,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      requests.set(index, row);
      return row;
    });
    const messageCreate = jest.fn(async ({ data }: any) => {
      if (messages.has(data.id)) {
        throw Object.assign(new Error('unique message'), { code: 'P2002' });
      }
      messages.set(data.id, {
        ...data,
        deletedAt: null,
      });
      return messages.get(data.id);
    });
    const seedCreateMany = jest.fn(async ({ data }: any) => {
      let count = 0;
      for (const item of data) {
        if (!leads.some((candidate) => candidate.id === item.id)) {
          leads.push({
            ...item,
            deletedAt: null,
            createdAt: new Date(),
          });
          count += 1;
        }
      }
      return { count };
    });

    const prisma: any = {
      lead: {
        findFirst: jest.fn(async ({ where }: any) => {
          if (where.id) return leads.find((item) => item.id === where.id) || null;
          return leads.find((item) => (
            item.companyId === where.companyId
            && item.contactEmail === where.contactEmail
            && item.deletedAt === null
          )) || null;
        }),
        findMany: jest.fn(async () => [...leadOrder]),
      },
      emailAccount: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'account-1',
          companyId: 'company-1',
          userId: 'user-1',
          senderName: 'Sales',
          senderEmail: 'sales@example.com',
          status: 'active',
          dailySentCount: 0,
          dailySendLimit: 100,
          hourlySentCount: 0,
          hourlySendLimit: 100,
          sendIntervalSeconds: 1,
        }),
      },
      emailTemplate: {
        findFirst: jest.fn().mockImplementation(async () => templateRow),
        updateMany: jest.fn(async ({ where, data }: any) => {
          if (
            templateRow.id !== where.id
            || templateRow.companyId !== where.companyId
          ) return { count: 0 };
          templateRow.useCount += Number(data.useCount.increment || 0);
          return { count: 1 };
        }),
      },
      unsubscribeRecord: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      blacklistRecord: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      emailDispatchRequest: {
        findUnique: jest.fn(async ({ where }: any) => requests.get(
          `${where.companyId_idempotencyKey.companyId}:${where.companyId_idempotencyKey.idempotencyKey}`,
        ) || null),
        updateMany: jest.fn(async ({ where, data }: any) => {
          const row = Array.from(requests.values()).find((item: any) => (
            item.id === where.id
            && item.companyId === where.companyId
            && item.payloadDigest === where.payloadDigest
            && item.status === where.status
          )) as any;
          if (!row) return { count: 0 };
          Object.assign(row, data);
          return { count: 1 };
        }),
      },
      emailMessage: {
        findMany: jest.fn(async ({ where }: any) => (
          (where.id.in as string[])
            .map((id) => messages.get(id))
            .filter(Boolean)
            .map((message: any) => ({
              id: message.id,
              lead: leads.find((item) => item.id === message.leadId) || null,
            }))
        )),
      },
      leadActivity: {
        create: jest.fn(async ({ data }: any) => {
          if (activities.has(data.id)) {
            throw Object.assign(new Error('unique activity'), { code: 'P2002' });
          }
          activities.set(data.id, { ...data });
          return activities.get(data.id);
        }),
      },
    };
    prisma.$transaction = jest.fn(async (callback: any) => {
      const requestSnapshot = new Map(
        Array.from(requests, ([key, value]) => [key, { ...value }]),
      );
      const messageSnapshot = new Map(
        Array.from(messages, ([key, value]) => [key, { ...value }]),
      );
      const activitySnapshot = new Map(
        Array.from(activities, ([key, value]) => [key, { ...value }]),
      );
      const leadSnapshot = [...leads];
      const templateUseCountSnapshot = templateRow.useCount;
      try {
        return await callback({
          emailDispatchRequest: {
            create: requestCreate,
            updateMany: prisma.emailDispatchRequest.updateMany,
          },
          lead: { createMany: seedCreateMany },
          emailMessage: { create: messageCreate },
          emailTemplate: {
            updateMany: prisma.emailTemplate.updateMany,
          },
          leadActivity: {
            create: prisma.leadActivity.create,
          },
        });
      } catch (error) {
        requests.clear();
        for (const [key, value] of requestSnapshot) requests.set(key, value);
        messages.clear();
        for (const [key, value] of messageSnapshot) messages.set(key, value);
        activities.clear();
        for (const [key, value] of activitySnapshot) activities.set(key, value);
        leads.splice(0, leads.length, ...leadSnapshot);
        templateRow.useCount = templateUseCountSnapshot;
        throw error;
      }
    });

    const makeQueue = () => ({
      add: jest.fn(async (name: string, data: any, options: any) => {
        queuedJobs.set(options.jobId, { id: options.jobId, name, data });
        return queuedJobs.get(options.jobId);
      }),
      getJob: jest.fn(async (jobId: string) => queuedJobs.get(jobId) || null),
    });
    const composeQueue = makeQueue();
    const validateQueue = makeQueue();
    const outbound = {
      assertEmailAccountAccess: jest.fn().mockResolvedValue(undefined),
    };
    const service = new EmailsService(
      prisma,
      { ingest: jest.fn() } as any,
      composeQueue as any,
      validateQueue as any,
      outbound as any,
      { assertMarketingRole: jest.fn() } as any,
    );

    return {
      service,
      prisma,
      composeQueue,
      validateQueue,
      requests,
      messages,
      activities,
      templateRow,
      requestCreate,
      messageCreate,
      seedCreateMany,
      setLeadOrder(next: any[]) {
        leadOrder = [...next];
      },
    };
  }

  const singleDto = (overrides: Record<string, unknown> = {}) => ({
    leadId: 'lead-1',
    emailAccountId: 'account-1',
    emailTemplateId: 'template-1',
    aiPersonalize: false,
    ...overrides,
  } as any);

  const batchDto = (leadIds: string[], overrides: Record<string, unknown> = {}) => ({
    selectAll: false,
    leadIds,
    emailAccountId: 'account-1',
    emailTemplateId: 'template-1',
    allowTemplateDirect: true,
    aiPersonalize: false,
    sendIntervalSeconds: 1,
    ...overrides,
  } as any);

  it('reuses one single-message snapshot and rejects a changed payload for the same key', async () => {
    const h = harness();
    const key = 'single-intent-0001';

    const first = await h.service.sendSingle(singleDto(), user, key);
    const replay = await h.service.sendSingle(singleDto(), user, key);

    expect(replay).toEqual(first);
    expect(h.requestCreate).toHaveBeenCalledTimes(1);
    expect(h.messageCreate).toHaveBeenCalledTimes(1);
    expect(h.validateQueue.add).toHaveBeenCalledTimes(1);
    const persistedMessage = Array.from(h.messages.values())[0];
    expect(persistedMessage.trackingId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(persistedMessage.unsubscribeToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(persistedMessage.trackingId).not.toContain(key);
    expect(persistedMessage.unsubscribeToken).not.toContain(key);
    const conflict = await h.service.sendSingle(
      singleDto({ subject: 'Different subject' }),
      user,
      key,
    ).catch((error) => error);
    expect(conflict).toBeInstanceOf(ConflictException);
    expect(conflict.getStatus()).toBe(409);
    expect(conflict.getResponse()).toEqual({
      statusCode: 409,
      code: 'EMAIL_IDEMPOTENCY_PAYLOAD_CONFLICT',
      message: 'Idempotency-Key was already used with a different email request',
    });
    expect(h.messageCreate).toHaveBeenCalledTimes(1);
  });

  it('keeps a single request RESERVED across a definite queue failure and repairs it on same-key retry', async () => {
    const h = harness();
    const key = 'single-intent-0002';
    h.validateQueue.add.mockRejectedValueOnce(new Error('redis unavailable'));

    await expect(h.service.sendSingle(singleDto(), user, key))
      .rejects.toBeInstanceOf(ServiceUnavailableException);

    const reserved = h.requests.get(`company-1:${key}`);
    expect(reserved.status).toBe('RESERVED');
    expect(h.messages.size).toBe(1);
    const retried = await h.service.sendSingle(singleDto(), user, key);
    expect(retried.emailMessageId).toBe(reserved.result.response.emailMessageId);
    expect(h.requestCreate).toHaveBeenCalledTimes(1);
    expect(h.messageCreate).toHaveBeenCalledTimes(1);
    expect(h.validateQueue.add).toHaveBeenCalledTimes(2);
    expect(h.validateQueue.add.mock.calls[0][2].jobId)
      .toBe(h.validateQueue.add.mock.calls[1][2].jobId);
    expect(reserved.status).toBe('ENQUEUED');
  });

  it('accepts an ambiguous queue acknowledgement only when deterministic getJob finds the job', async () => {
    const h = harness();
    const key = 'single-intent-0003';
    h.validateQueue.add.mockRejectedValueOnce(new Error('socket closed after write'));
    h.validateQueue.getJob.mockResolvedValueOnce({ id: 'accepted-job' });

    await expect(h.service.sendSingle(singleDto(), user, key)).resolves.toMatchObject({
      success: true,
    });

    expect(h.validateQueue.getJob).toHaveBeenCalledWith(
      expect.stringMatching(/^email-dispatch-.*-validate$/),
    );
    expect(h.requests.get(`company-1:${key}`).status).toBe('ENQUEUED');
  });

  it('rolls back a failed DB reservation and safely creates once on same-key retry', async () => {
    const h = harness();
    const key = 'single-intent-0004';
    h.messageCreate.mockRejectedValueOnce(new Error('database write failed'));

    await expect(h.service.sendSingle(singleDto(), user, key))
      .rejects.toThrow('database write failed');
    expect(h.requests.size).toBe(0);
    expect(h.messages.size).toBe(0);
    expect(h.validateQueue.add).not.toHaveBeenCalled();

    await expect(h.service.sendSingle(singleDto(), user, key)).resolves.toMatchObject({
      success: true,
    });
    expect(h.requests.size).toBe(1);
    expect(h.messages.size).toBe(1);
    expect(h.validateQueue.add).toHaveBeenCalledTimes(1);
  });

  it('reads back and reuses the winning request after a P2002 reservation race', async () => {
    const h = harness();
    const key = 'single-intent-race';
    const dto = singleDto();
    const inputDigest = (h.service as any).emailDispatchPayloadDigest({
      kind: 'SINGLE',
      operatorUserId: user.id,
      dto,
    });
    const winningRequest = {
      id: 'winning-request',
      companyId: 'company-1',
      operatorUserId: 'user-1',
      kind: 'SINGLE',
      idempotencyKey: key,
      payloadDigest: 'winning-payload-digest',
      status: 'ENQUEUED',
      result: {
        inputDigest,
        response: {
          success: true,
          emailMessageId: 'winning-message',
          status: 'DraftReady',
        },
        jobs: [],
        projection: { activities: [] },
      },
    };
    let readCount = 0;
    h.prisma.emailDispatchRequest.findUnique.mockImplementation(async () => {
      readCount += 1;
      return readCount >= 3 ? winningRequest : null;
    });
    h.prisma.$transaction.mockRejectedValueOnce(
      Object.assign(new Error('request won elsewhere'), { code: 'P2002' }),
    );

    await expect(h.service.sendSingle(dto, user, key)).resolves.toMatchObject({
      emailMessageId: 'winning-message',
    });

    expect(h.prisma.emailDispatchRequest.findUnique).toHaveBeenCalledTimes(3);
    expect(h.requestCreate).not.toHaveBeenCalled();
    expect(h.messageCreate).not.toHaveBeenCalled();
    expect(h.validateQueue.add).not.toHaveBeenCalled();
  });

  it('persists all batch rows before enqueue and replays skipped results without rechecking eligibility', async () => {
    const sendable = lead('lead-1');
    const skipped = lead('lead-2', '');
    const h = harness([skipped, sendable]);
    const key = 'batch-intent-0001';
    const dto = batchDto(['lead-1', 'lead-2']);

    const first = await h.service.sendBatch(dto, user, key);
    expect(first).toMatchObject({
      totalLeads: 2,
      queued: 1,
      skipped: 1,
    });
    expect(h.messageCreate).toHaveBeenCalledTimes(2);
    expect(h.validateQueue.add).toHaveBeenCalledTimes(1);
    expect(h.templateRow.useCount).toBe(1);
    expect(h.activities.size).toBe(1);
    skipped.contactEmail = 'now-valid@buyer.example.com';
    const replay = await h.service.sendBatch(dto, user, key);

    expect(replay).toEqual(first);
    expect(h.messageCreate).toHaveBeenCalledTimes(2);
    expect(h.validateQueue.add).toHaveBeenCalledTimes(1);
    expect(h.prisma.lead.findMany).toHaveBeenCalledTimes(1);
    await expect(h.service.sendBatch(
      batchDto(['lead-1', 'lead-2'], { subject: 'Changed' }),
      user,
      key,
    )).rejects.toBeInstanceOf(ConflictException);
  });

  it('repairs a partially unqueued batch without duplicating request or message rows', async () => {
    const h = harness([lead('lead-2'), lead('lead-1')]);
    const key = 'batch-intent-0002';
    const dto = batchDto(['lead-1', 'lead-2']);
    h.validateQueue.add.mockRejectedValueOnce(new Error('redis unavailable'));

    await expect(h.service.sendBatch(dto, user, key))
      .rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(h.requests.get(`company-1:${key}`).status).toBe('RESERVED');
    expect(h.messages.size).toBe(2);

    const result = await h.service.sendBatch(dto, user, key);
    expect(result.results.map((item: any) => item.leadId)).toEqual([
      'lead-1',
      'lead-2',
    ]);
    expect(h.requestCreate).toHaveBeenCalledTimes(1);
    expect(h.messageCreate).toHaveBeenCalledTimes(2);
    expect(h.validateQueue.add).toHaveBeenCalledTimes(3);
    expect(h.validateQueue.add.mock.calls[0][2].jobId)
      .toBe(h.validateQueue.add.mock.calls[1][2].jobId);
    expect(h.requests.get(`company-1:${key}`).status).toBe('ENQUEUED');
    expect(h.templateRow.useCount).toBe(2);
    expect(h.activities.size).toBe(1);
  });

  it('rolls back the whole batch snapshot on a DB row failure and retries without duplicates', async () => {
    const h = harness([lead('lead-1'), lead('lead-2')]);
    const key = 'batch-intent-db-failure';
    const dto = batchDto(['lead-1', 'lead-2']);
    h.messageCreate
      .mockImplementationOnce(async ({ data }: any) => {
        h.messages.set(data.id, { ...data, deletedAt: null });
        return h.messages.get(data.id);
      })
      .mockRejectedValueOnce(new Error('second message failed'));

    await expect(h.service.sendBatch(dto, user, key))
      .rejects.toThrow('second message failed');
    expect(h.requests.size).toBe(0);
    expect(h.messages.size).toBe(0);
    expect(h.validateQueue.add).not.toHaveBeenCalled();

    await expect(h.service.sendBatch(dto, user, key)).resolves.toMatchObject({
      totalLeads: 2,
      queued: 2,
    });
    expect(h.requests.size).toBe(1);
    expect(h.messages.size).toBe(2);
    expect(h.validateQueue.add).toHaveBeenCalledTimes(2);
  });

  it('creates an approved deterministic seed lead inside the request transaction', async () => {
    const original = {
      NODE_ENV: process.env.NODE_ENV,
      EMAIL_SEED_TEST_ENABLED: process.env.EMAIL_SEED_TEST_ENABLED,
      EMAIL_SEED_TEST_ADDRESS: process.env.EMAIL_SEED_TEST_ADDRESS,
      EMAIL_SEED_TEST_APPROVED_ADDRESSES:
        process.env.EMAIL_SEED_TEST_APPROVED_ADDRESSES,
      EMAIL_SEED_TEST_INTERVAL: process.env.EMAIL_SEED_TEST_INTERVAL,
    };
    process.env.NODE_ENV = 'production';
    process.env.EMAIL_SEED_TEST_ENABLED = 'true';
    process.env.EMAIL_SEED_TEST_ADDRESS = 'seed@example.com';
    process.env.EMAIL_SEED_TEST_APPROVED_ADDRESSES = 'seed@example.com';
    process.env.EMAIL_SEED_TEST_INTERVAL = '100';
    try {
      const h = harness([lead('lead-1')]);
      const key = 'batch-intent-with-seed';
      const dto = batchDto(['lead-1']);

      const first = await h.service.sendBatch(dto, user, key);
      expect(first).toMatchObject({
        queued: 1,
        seedQueued: 1,
      });
      expect(h.seedCreateMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            id: expect.stringMatching(/^[0-9a-f-]{36}$/i),
            companyId: 'company-1',
            contactEmail: 'seed@example.com',
            sourceType: 'system_seed_test',
          }),
        ],
        skipDuplicates: true,
      });
      expect(h.requestCreate.mock.invocationCallOrder[0])
        .toBeLessThan(h.seedCreateMany.mock.invocationCallOrder[0]);
      expect(h.seedCreateMany.mock.invocationCallOrder[0])
        .toBeLessThan(h.messageCreate.mock.invocationCallOrder[0]);
      expect(h.messages.size).toBe(2);

      await expect(h.service.sendBatch(dto, user, key)).resolves.toEqual(first);
      expect(h.seedCreateMany).toHaveBeenCalledTimes(1);
      expect(h.messageCreate).toHaveBeenCalledTimes(2);
      expect(h.validateQueue.add).toHaveBeenCalledTimes(2);
    } finally {
      for (const [name, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it('hashes the normalized batch DTO with a sorted actual lead snapshot', async () => {
    const firstLead = lead('lead-1');
    const secondLead = lead('lead-2');
    const h = harness([firstLead, secondLead]);
    const dto = batchDto(['lead-1', 'lead-2']);
    h.setLeadOrder([secondLead, firstLead]);
    await h.service.sendBatch(dto, user, 'batch-digest-key-1');
    h.setLeadOrder([firstLead, secondLead]);
    await h.service.sendBatch(dto, user, 'batch-digest-key-2');

    expect(h.requests.get('company-1:batch-digest-key-1').payloadDigest)
      .toBe(h.requests.get('company-1:batch-digest-key-2').payloadDigest);
  });

  it('atomically retries queue projection after a projection failure', async () => {
    const h = harness();
    const key = 'single-projection-retry';
    h.prisma.leadActivity.create.mockRejectedValueOnce(
      new Error('activity projection unavailable'),
    );

    await expect(h.service.sendSingle(singleDto(), user, key))
      .rejects.toThrow('activity projection unavailable');
    expect(h.requests.get(`company-1:${key}`).status).toBe('RESERVED');
    expect(h.templateRow.useCount).toBe(0);
    expect(h.activities.size).toBe(0);

    await expect(h.service.sendSingle(singleDto(), user, key))
      .resolves.toMatchObject({ success: true });
    expect(h.requests.get(`company-1:${key}`).status).toBe('ENQUEUED');
    expect(h.templateRow.useCount).toBe(1);
    expect(h.activities.size).toBe(1);
  });

  it('projects a skipped single request with zero queue jobs exactly once', async () => {
    const h = harness([lead('lead-1', '')]);
    const key = 'single-skipped-no-jobs';

    const first = await h.service.sendSingle(singleDto(), user, key);
    const replay = await h.service.sendSingle(singleDto(), user, key);

    expect(first).toMatchObject({ status: 'Skipped' });
    expect(replay).toEqual(first);
    expect(h.validateQueue.add).not.toHaveBeenCalled();
    expect(h.composeQueue.add).not.toHaveBeenCalled();
    expect(h.templateRow.useCount).toBe(0);
    expect(h.activities.size).toBe(1);
  });

  it('projects an all-skipped zero-job batch without incrementing template usage', async () => {
    const h = harness([lead('lead-1', ''), lead('lead-2', '')]);
    const key = 'batch-all-skipped-no-jobs';

    await expect(h.service.sendBatch(
      batchDto(['lead-1', 'lead-2']),
      user,
      key,
    )).resolves.toMatchObject({ queued: 0, skipped: 2 });

    expect(h.validateQueue.add).not.toHaveBeenCalled();
    expect(h.templateRow.useCount).toBe(0);
    expect(h.activities.size).toBe(1);
    expect(h.requests.get(`company-1:${key}`).status).toBe('ENQUEUED');
  });

  it('lets only the RESERVED CAS winner project during concurrent replay', async () => {
    const h = harness();
    const key = 'single-concurrent-projection';
    h.validateQueue.add.mockRejectedValueOnce(new Error('queue unavailable'));
    await expect(h.service.sendSingle(singleDto(), user, key))
      .rejects.toBeInstanceOf(ServiceUnavailableException);

    await Promise.all([
      h.service.sendSingle(singleDto(), user, key),
      h.service.sendSingle(singleDto(), user, key),
    ]);

    expect(h.templateRow.useCount).toBe(1);
    expect(h.activities.size).toBe(1);
    expect(h.requests.get(`company-1:${key}`).status).toBe('ENQUEUED');
  });

  it('replays an uncertain committed projection without duplicating it', async () => {
    const h = harness();
    const key = 'single-uncertain-projection-commit';
    const transaction = h.prisma.$transaction;
    let transactionCalls = 0;
    h.prisma.$transaction = jest.fn(async (callback: any) => {
      transactionCalls += 1;
      const result = await transaction(callback);
      if (transactionCalls === 2) {
        throw new Error('connection lost after commit');
      }
      return result;
    });

    await expect(h.service.sendSingle(singleDto(), user, key))
      .rejects.toThrow('connection lost after commit');
    expect(h.requests.get(`company-1:${key}`).status).toBe('ENQUEUED');
    expect(h.templateRow.useCount).toBe(1);
    expect(h.activities.size).toBe(1);

    await expect(h.service.sendSingle(singleDto(), user, key))
      .resolves.toMatchObject({ success: true });
    expect(h.templateRow.useCount).toBe(1);
    expect(h.activities.size).toBe(1);
  });
});
