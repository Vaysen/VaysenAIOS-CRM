import { ForbiddenException } from '@nestjs/common';
import { OpenClawReceiptStatus } from '@prisma/client';
import { createHash } from 'crypto';
import {
  OpenClawSelectionService,
  type OpenClawSelectionContext,
} from './openclaw-selection.service';

const COMPANY_ID = '11111111-1111-4111-8111-111111111111';
const CONVERSATION_ID = '22222222-2222-4222-8222-222222222222';
const LEAD_ID = '33333333-3333-4333-8333-333333333333';
const SEARCH_REQUEST_KEY = 's'.repeat(64);

const context: OpenClawSelectionContext = {
  companyId: COMPANY_ID,
  operatorUserId: 'owner-user',
  channel: 'openclaw-weixin',
  senderDigest: 'd'.repeat(64),
  accountDigest: 'a'.repeat(64),
  sessionDigest: 'e'.repeat(64),
  messageDigest: 'm'.repeat(64),
};

function advisoryLockKeyAt(mock: jest.Mock, index: number): string {
  const [query, ...parameters] = mock.mock.calls[index];
  const parameterizedSql = Array.from(query as readonly string[]).join('?');
  expect(parameterizedSql).toMatch(
    /pg_advisory_xact_lock\(hashtextextended\(\?, 0\)\)::text AS locked/,
  );
  expect(parameters).toHaveLength(1);
  expect(parameterizedSql).not.toContain(String(parameters[0]));
  return parameters[0] as string;
}

function createHarness() {
  const selections = new Map<string, any>();
  const receipt: any = {
    requestKey: SEARCH_REQUEST_KEY,
    companyId: context.companyId,
    operatorUserId: context.operatorUserId,
    senderDigest: context.senderDigest,
    sessionDigest: context.sessionDigest,
    messageDigest: context.messageDigest,
    toolName: 'customer-search',
    status: OpenClawReceiptStatus.COMPLETED,
  };
  const prisma: any = {
    $queryRaw: jest.fn().mockResolvedValue([{ locked: '' }]),
    openClawSelectionToken: {
      createMany: jest.fn(async ({ data }: any) => {
        for (const row of data) {
          selections.set(row.tokenDigest, {
            id: `selection-${selections.size + 1}`,
            consumedAt: null,
            createdAt: new Date(),
            ...row,
          });
        }
        return { count: data.length };
      }),
      findUnique: jest.fn(async ({ where }: any) => selections.get(where.tokenDigest) || null),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const row = [...selections.values()].find((candidate) => candidate.id === where.id);
        if (!row || row.consumedAt || row.expiresAt <= where.expiresAt.gt) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
    openClawToolReceipt: {
      findUnique: jest.fn(async ({ where }: any) => (
        where.requestKey === receipt.requestKey ? receipt : null
      )),
    },
  };
  prisma.$transaction = jest.fn(async (callback: any) => callback(prisma));
  return {
    prisma,
    receipt,
    selections,
    service: new OpenClawSelectionService(prisma),
  };
}

async function issueUnique(service: OpenClawSelectionService) {
  return service.issueForUniqueSearch(context, SEARCH_REQUEST_KEY, {
    count: 1,
    hasMore: false,
    uniqueMatch: true,
    customers: [{
      customerName: 'Unique Buyer',
      trustedLeadId: LEAD_ID,
      whatsappConversationId: CONVERSATION_ID,
    }],
  });
}

describe('OpenClawSelectionService', () => {
  afterEach(() => jest.useRealTimers());

  it.each([
    [{ count: 0, customers: [] }],
    [{ count: 2, customers: [
      { whatsappConversationId: CONVERSATION_ID },
      { whatsappConversationId: '33333333-3333-4333-8333-333333333333' },
    ] }],
    [{ count: 1, customers: [{ trustedLeadId: 'model-invented-id', whatsappConversationId: null }] }],
    [{ count: 1, customers: [{ trustedLeadId: LEAD_ID, whatsappConversationId: 'model-invented-id' }] }],
    [{
      count: 1,
      hasMore: true,
      uniqueMatch: false,
      customers: [{ trustedLeadId: LEAD_ID, whatsappConversationId: CONVERSATION_ID }],
    }],
    [{
      count: 1,
      hasMore: false,
      uniqueMatch: false,
      customers: [{ trustedLeadId: LEAD_ID, whatsappConversationId: CONVERSATION_ID }],
    }],
  ])('does not issue an action capability unless search uniquely resolves a trusted conversation', async (result) => {
    const { service, prisma } = createHarness();
    await expect(service.issueForUniqueSearch(context, SEARCH_REQUEST_KEY, result)).resolves.toBeNull();
    expect(prisma.openClawSelectionToken.createMany).not.toHaveBeenCalled();
  });

  it('issues independent tool-bound tokens while persisting only their digests', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-15T10:00:00.000Z'));
    const { service, prisma } = createHarness();
    const issued = await issueUnique(service);

    expect(issued).toEqual({
      expiresAt: '2026-07-15T10:02:00.000Z',
      tokens: expect.objectContaining({
        'prepare-quote-delivery': expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        'start-background-research': expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        'customer-get': expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        'customer-add-note': expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        'customer-update': expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        'customer-set-stage': expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        'task-create': expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        'order-list': expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        'order-create-draft': expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        'order-update-stage': expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        'quote-list': expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        'quote-create-draft': expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
        'whatsapp-send-quote': expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      }),
    });
    expect(issued!.tokens['prepare-quote-delivery']).not.toBe(
      issued!.tokens['start-background-research'],
    );
    const rows = prisma.openClawSelectionToken.createMany.mock.calls[0][0].data;
    const issuedTokens = issued!.tokens;
    expect(rows).toHaveLength(18);
    for (const row of rows) {
      expect(row.tokenDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(row)).not.toContain(
        issuedTokens[row.targetTool as keyof typeof issuedTokens],
      );
      expect(row).toEqual(expect.objectContaining({
        companyId: context.companyId,
        operatorUserId: context.operatorUserId,
        sessionDigest: context.sessionDigest,
        messageDigest: context.messageDigest,
        searchRequestKey: SEARCH_REQUEST_KEY,
        leadId: LEAD_ID,
        conversationId: CONVERSATION_ID,
      }));
    }
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(advisoryLockKeyAt(prisma.$queryRaw, 0)).toBe(
      `openclaw-selection-issue:${SEARCH_REQUEST_KEY}`,
    );
  });

  it('issues customer and email capabilities for one trusted lead without a WhatsApp conversation', async () => {
    const { service, prisma } = createHarness();
    const issued = await service.issueForUniqueSearch(context, SEARCH_REQUEST_KEY, {
      count: 1,
      hasMore: false,
      uniqueMatch: true,
      customers: [{ trustedLeadId: LEAD_ID, customerName: 'Email-only buyer' }],
    });

    expect(issued?.tokens['customer-get']).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued?.tokens['email-send']).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(prisma.openClawSelectionToken.createMany.mock.calls[0][0].data)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ leadId: LEAD_ID, conversationId: null }),
      ]));
  });

  it('consumes a token once and derives the lead and conversation UUIDs from PostgreSQL', async () => {
    const { service, prisma, selections } = createHarness();
    const issued = await issueUnique(service);
    const token = issued!.tokens['prepare-quote-delivery'];

    await expect(service.consume(token, 'prepare-quote-delivery', context))
      .resolves.toEqual({ leadId: LEAD_ID, conversationId: CONVERSATION_ID, replay: false });
    const row = selections.get(createHash('sha256').update(token).digest('hex'));
    expect(row.consumedAt).toBeInstanceOf(Date);
    await expect(service.consume(token, 'prepare-quote-delivery', context))
      .resolves.toEqual({ leadId: LEAD_ID, conversationId: CONVERSATION_ID, replay: true });
    const expectedConsumeLock = `openclaw-selection-consume:${
      createHash('sha256').update(token).digest('hex')
    }`;
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(3);
    expect(advisoryLockKeyAt(prisma.$queryRaw, 0)).toBe(
      `openclaw-selection-issue:${SEARCH_REQUEST_KEY}`,
    );
    expect(advisoryLockKeyAt(prisma.$queryRaw, 1)).toBe(expectedConsumeLock);
    expect(advisoryLockKeyAt(prisma.$queryRaw, 2)).toBe(expectedConsumeLock);
  });

  it('rejects an action-before-search token without creating or reading business data', async () => {
    const { service, prisma } = createHarness();
    await expect(service.consume(
      'N'.repeat(43),
      'prepare-quote-delivery',
      context,
    )).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.openClawToolReceipt.findUnique).not.toHaveBeenCalled();
    expect(prisma.openClawSelectionToken.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    ['wrong company', { companyId: 'other-company' }],
    ['wrong operator', { operatorUserId: 'other-owner' }],
    ['wrong channel', { channel: 'vaysen-crm' }],
    ['wrong sender', { senderDigest: 'f'.repeat(64) }],
    ['wrong account', { accountDigest: 'b'.repeat(64) }],
    ['wrong session', { sessionDigest: 'c'.repeat(64) }],
    ['wrong original message/request', { messageDigest: 'x'.repeat(64) }],
  ])('rejects a token used in the %s context', async (_label, override) => {
    const { service } = createHarness();
    const issued = await issueUnique(service);
    await expect(service.consume(
      issued!.tokens['prepare-quote-delivery'],
      'prepare-quote-delivery',
      { ...context, ...override } as OpenClawSelectionContext,
    )).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects cross-tool use, expiration, invalid stored conversation and incomplete source receipt', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-15T10:00:00.000Z'));
    const { service, selections, receipt } = createHarness();
    const issued = await issueUnique(service);
    const quoteToken = issued!.tokens['prepare-quote-delivery'];

    await expect(service.consume(quoteToken, 'start-background-research', context))
      .rejects.toBeInstanceOf(ForbiddenException);

    const row = selections.get(createHash('sha256').update(quoteToken).digest('hex'));
    row.conversationId = 'model-invented-id';
    await expect(service.consume(quoteToken, 'prepare-quote-delivery', context))
      .rejects.toBeInstanceOf(ForbiddenException);

    row.conversationId = CONVERSATION_ID;
    receipt.status = OpenClawReceiptStatus.PROCESSING;
    await expect(service.consume(quoteToken, 'prepare-quote-delivery', context))
      .rejects.toBeInstanceOf(ForbiddenException);

    receipt.status = OpenClawReceiptStatus.COMPLETED;
    jest.setSystemTime(new Date('2026-07-15T10:02:01.000Z'));
    await expect(service.consume(quoteToken, 'prepare-quote-delivery', context))
      .rejects.toBeInstanceOf(ForbiddenException);
  });
});
