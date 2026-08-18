const {
  buildTenantRelationReport,
  runCli,
  runPreflight,
} = require('./security-preflight-tenant-relations');

describe('tenant relation security preflight', () => {
  it('batches scalar conversation IDs and reports only record IDs and counts', async () => {
    const prisma = {
      quote: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'quote-valid',
            companyId: 'tenant-a',
            leadId: 'lead-a',
            conversationId: 'conversation-a',
            lead: { companyId: 'tenant-a', customerSecret: 'not-for-output' },
          },
          {
            id: 'quote-foreign-conversation',
            companyId: 'tenant-a',
            leadId: 'lead-a',
            conversationId: 'conversation-b',
            lead: { companyId: 'tenant-a' },
          },
          {
            id: 'quote-for-order',
            companyId: 'tenant-b',
            leadId: 'lead-b',
            conversationId: null,
            lead: { companyId: 'tenant-b' },
          },
          {
            id: 'quote-missing-conversation',
            companyId: 'tenant-a',
            leadId: 'lead-a',
            conversationId: 'conversation-missing',
            lead: { companyId: 'tenant-a' },
          },
        ]),
      },
      order: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'order-foreign-lead',
            companyId: 'tenant-a',
            leadId: 'lead-b',
            quoteId: null,
            lead: { companyId: 'tenant-b', customerSecret: 'not-for-output' },
            quote: null,
          },
          {
            id: 'order-foreign-quote',
            companyId: 'tenant-a',
            leadId: 'lead-a',
            quoteId: 'quote-for-order',
            lead: { companyId: 'tenant-a' },
          },
          {
            id: 'order-missing-quote',
            companyId: 'tenant-a',
            leadId: 'lead-a',
            quoteId: 'quote-missing',
            lead: { companyId: 'tenant-a' },
          },
        ]),
      },
      conversation: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'conversation-a',
            companyId: 'tenant-a',
            leadId: 'lead-a',
          },
          {
            id: 'conversation-b',
            companyId: 'tenant-b',
            leadId: 'lead-a',
          },
        ]),
      },
    };
    const stdout = { write: jest.fn() };

    const exitCode = await runPreflight(prisma, stdout);

    expect(exitCode).toBe(1);
    expect(prisma.quote.findMany).toHaveBeenCalledWith({
      select: {
        id: true,
        companyId: true,
        leadId: true,
        conversationId: true,
        lead: { select: { companyId: true } },
      },
    });
    expect(prisma.conversation.findMany).toHaveBeenCalledWith({
      where: {
        id: {
          in: [
            'conversation-a',
            'conversation-b',
            'conversation-missing',
          ],
        },
      },
      select: { id: true, companyId: true, leadId: true },
    });
    const output = stdout.write.mock.calls[0][0];
    expect(JSON.parse(output)).toEqual({
      invalidQuoteCount: 2,
      invalidQuoteIds: [
        'quote-foreign-conversation',
        'quote-missing-conversation',
      ],
      invalidOrderCount: 3,
      invalidOrderIds: [
        'order-foreign-lead',
        'order-foreign-quote',
        'order-missing-quote',
      ],
    });
    expect(output).not.toContain('not-for-output');
    expect(prisma.order.findMany).toHaveBeenCalledWith({
      select: {
        id: true,
        companyId: true,
        leadId: true,
        quoteId: true,
        lead: { select: { companyId: true } },
      },
    });
  });

  it('does not query conversations when no quote references one', async () => {
    const prisma = {
      quote: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'quote-valid',
            companyId: 'tenant-a',
            leadId: 'lead-a',
            conversationId: null,
            lead: { companyId: 'tenant-a' },
          },
        ]),
      },
      order: { findMany: jest.fn().mockResolvedValue([]) },
      conversation: { findMany: jest.fn() },
    };

    await expect(buildTenantRelationReport(prisma)).resolves.toEqual({
      invalidQuoteCount: 0,
      invalidQuoteIds: [],
      invalidOrderCount: 0,
      invalidOrderIds: [],
    });
    expect(prisma.conversation.findMany).not.toHaveBeenCalled();
  });

  it('returns a fixed diagnostic without leaking Prisma or connection details', async () => {
    const stdout = { write: jest.fn() };
    const stderr = { write: jest.fn() };
    const prisma = {
      quote: {
        findMany: jest.fn().mockRejectedValue(
          new Error('postgres://secret@db/customer-name'),
        ),
      },
      order: { findMany: jest.fn() },
      $disconnect: jest.fn().mockResolvedValue(undefined),
    };

    await expect(runCli(() => prisma, stdout, stderr)).resolves.toBe(1);
    expect(stdout.write).not.toHaveBeenCalled();
    expect(stderr.write).toHaveBeenCalledWith(
      'Tenant relation preflight failed; no data was changed.\n',
    );
    expect(stderr.write.mock.calls.flat().join('')).not.toContain('secret');
    expect(prisma.$disconnect).toHaveBeenCalled();
  });
});
