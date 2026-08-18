'use strict';

async function buildTenantRelationReport(prisma) {
  const [quotes, orders] = await Promise.all([
    prisma.quote.findMany({
      select: {
        id: true,
        companyId: true,
        leadId: true,
        conversationId: true,
        lead: { select: { companyId: true } },
      },
    }),
    prisma.order.findMany({
      select: {
        id: true,
        companyId: true,
        leadId: true,
        quoteId: true,
        lead: { select: { companyId: true } },
      },
    }),
  ]);

  const quotesById = new Map(quotes.map((quote) => [quote.id, quote]));
  const conversationIds = [
    ...new Set(
      quotes
        .map((quote) => quote.conversationId)
        .filter((id) => typeof id === 'string' && id.length > 0),
    ),
  ];
  const conversations = conversationIds.length
    ? await prisma.conversation.findMany({
      where: { id: { in: conversationIds } },
      select: { id: true, companyId: true, leadId: true },
    })
    : [];
  const conversationsById = new Map(
    conversations.map((conversation) => [conversation.id, conversation]),
  );

  const invalidQuoteIds = quotes.filter((quote) => {
    const conversation = quote.conversationId
      ? conversationsById.get(quote.conversationId)
      : null;
    return (quote.leadId && quote.lead?.companyId !== quote.companyId)
      || (
        quote.conversationId
        && (
          !conversation
          || conversation.companyId !== quote.companyId
          || conversation.leadId !== quote.leadId
        )
      );
  }).map((quote) => quote.id);

  const invalidOrderIds = orders.filter((order) => {
    const quote = order.quoteId ? quotesById.get(order.quoteId) : null;
    return (order.leadId && order.lead?.companyId !== order.companyId)
      || (
        order.quoteId
        && (
          !quote
          || quote.companyId !== order.companyId
          || quote.leadId !== order.leadId
        )
      );
  }).map((order) => order.id);

  return {
    invalidQuoteCount: invalidQuoteIds.length,
    invalidQuoteIds,
    invalidOrderCount: invalidOrderIds.length,
    invalidOrderIds,
  };
}

async function runPreflight(prisma, stdout = process.stdout) {
  const report = await buildTenantRelationReport(prisma);
  stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.invalidQuoteCount || report.invalidOrderCount ? 1 : 0;
}

async function runCli(createPrisma, stdout = process.stdout, stderr = process.stderr) {
  let prisma;
  try {
    prisma = createPrisma();
    return await runPreflight(prisma, stdout);
  } catch {
    stderr.write('Tenant relation preflight failed; no data was changed.\n');
    return 1;
  } finally {
    if (prisma) {
      try {
        await prisma.$disconnect();
      } catch {
        // Keep diagnostics fixed and free of connection or query details.
      }
    }
  }
}

if (require.main === module) {
  const { PrismaClient } = require('@prisma/client');
  runCli(() => new PrismaClient())
    .then((exitCode) => {
      process.exitCode = exitCode;
    });
}

module.exports = {
  buildTenantRelationReport,
  runCli,
  runPreflight,
};
