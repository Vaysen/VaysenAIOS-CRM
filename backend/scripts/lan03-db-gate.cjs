const { PrismaClient } = require('@prisma/client');
const { ImapInboundService, parseRfc822 } = require('../dist/src/modules/imap-inbound/imap-inbound.service');

const prisma = new PrismaClient();
const service = new ImapInboundService(prisma);
const id = `lan03-${Date.now()}`;
const source = Buffer.from([
  'From: buyer@example.com', 'To: sales@example.com', 'Message-ID: <db-gate@example.com>',
  'Subject: DB gate', '', 'hello',
].join('\r\n'));

async function main() {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "Company" CASCADE');
  const company = await prisma.company.create({ data: { name: id, slug: id } });
  const other = await prisma.company.create({ data: { name: `${id}-other`, slug: `${id}-other` } });
  const user = await prisma.user.create({ data: { email: `${id}@example.com`, passwordHash: 'test', firstName: 'Test', lastName: 'Admin' } });
  const lead = await prisma.lead.create({ data: { companyId: company.id, leadName: 'Active lead' } });
  const deleted = await prisma.lead.create({ data: { companyId: company.id, leadName: 'Deleted lead', deletedAt: new Date() } });
  const merged = await prisma.lead.create({ data: { companyId: company.id, leadName: 'Merged lead', mergedToId: lead.id } });
  await prisma.contactPoint.create({ data: { companyId: company.id, leadId: lead.id, type: 'email', originalValue: 'buyer@example.com', normalizedValue: 'buyer@example.com' } });
  const account = await prisma.emailAccount.create({ data: { companyId: company.id, senderName: 'Sales', senderEmail: 'sales@example.com', smtpHost: 'stub', smtpPort: 25, smtpUsername: 'sales@example.com', smtpPasswordEncrypted: 'encrypted-test' } });
  const parsed = await parseRfc822(source);
  const accountInput = { id: account.id, companyId: company.id };

  const race = await Promise.allSettled([
    service.store(accountInput, 1, 9n, parsed, `imap:${account.id}:message:db-gate@example.com`),
    service.store(accountInput, 1, 9n, parsed, `imap:${account.id}:message:db-gate@example.com`),
  ]);
  const raceCounts = {
    fulfilled: race.filter((r) => r.status === 'fulfilled').length,
    p2002: race.filter((r) => r.status === 'rejected' && r.reason?.code === 'P2002').length,
    conversations: await prisma.conversation.count({ where: { companyId: company.id } }),
    messages: await prisma.communicationMessage.count({ where: { sourceAccountId: account.id } }),
  };
  if (raceCounts.fulfilled !== 1 || raceCounts.p2002 !== 1 || raceCounts.conversations !== 1 || raceCounts.messages !== 1) throw new Error(`race invariant failed ${JSON.stringify(raceCounts)} reasons=${JSON.stringify(race.map((r) => r.status === 'rejected' ? { code: r.reason?.code, message: r.reason?.message } : r.status))}`);

  const badKey = `imap:${account.id}:message:rollback@example.com`;
  await Promise.allSettled([service.store({ id: account.id, companyId: '00000000-0000-0000-0000-000000000000' }, 2, 9n, parsed, badKey)]);
  const orphanCount = await prisma.conversation.count({ where: { threadKey: badKey } });
  if (orphanCount !== 0) throw new Error(`rollback left orphan conversation: ${orphanCount}`);

  const admin = { id: user.id, activeCompanyId: company.id, activeCompany: { id: company.id, role: 'company_admin' } };
  const member = { id: user.id, activeCompanyId: company.id, activeCompany: { id: company.id, role: 'sales_user' } };
  const viewer = { id: user.id, activeCompanyId: company.id, activeCompany: { id: company.id, role: 'viewer' } };
  await service.updateConfig(admin, account.id, { host: 'stub', port: 993, tls: true, username: 'sales@example.com', secret: 'secret', enabled: true });
  const noIdSource = Buffer.from('From: buyer@example.com\r\nTo: sales@example.com\r\nSubject: No id\r\n\r\nno-id body');
  let attempt = 0;
  service.factory = () => {
    attempt += 1;
    if (attempt === 1) return { connect: async () => { throw new Error('stub disconnect'); }, logout: async () => {}, getMailboxLock: async () => ({ release() {} }), fetch: async function* () {} };
    const validity = attempt === 2 ? 11n : attempt === 3 ? 11n : 12n;
    const body = attempt === 4 ? Buffer.from(`${noIdSource.toString()}\r\nchanged`) : noIdSource;
    return { mailbox: { uidValidity: validity }, connect: async () => {}, logout: async () => {}, getMailboxLock: async () => ({ release() {} }), fetch: async function* () { yield { uid: 10, source: body }; } };
  };
  const reconnectError = await service.syncAccount(account.id);
  const firstUidSync = await service.syncAccount(account.id);
  const duplicateUidSync = await service.syncAccount(account.id);
  const changedValiditySync = await service.syncAccount(account.id);
  const noIdMessages = await prisma.communicationMessage.findMany({ where: { sourceAccountId: account.id, rawMessageId: null }, select: { imapUidValidity: true, imapUid: true } });
  if (reconnectError.status !== 'error' || firstUidSync.received !== 1 || duplicateUidSync.received !== 0 || changedValiditySync.received !== 1 || noIdMessages.length !== 2 || String(noIdMessages[0].imapUidValidity) !== '11' || String(noIdMessages[1].imapUidValidity) !== '12') throw new Error(`uid/reconnect invariant failed ${JSON.stringify({ reconnectError, firstUidSync, duplicateUidSync, changedValiditySync, noIdMessages })}`);
  const permission = { memberConfig: false, viewerConfig: false, crossTenant: false, deletedRejected: false, mergedRejected: false };
  for (const candidate of [member, viewer]) { try { await service.updateConfig(candidate, account.id, { enabled: false }); } catch (e) { permission[candidate.activeCompany.role === 'sales_user' ? 'memberConfig' : 'viewerConfig'] = e.status === 403; } }
  try { await service.updateConfig({ ...admin, activeCompanyId: other.id, activeCompany: { id: other.id, role: 'company_admin' } }, account.id, { enabled: false }); } catch (e) { permission.crossTenant = e.status === 404 || e.status === 403; }

  const review = await prisma.emailInboundReview.create({ data: { companyId: company.id, communicationMessageId: (await prisma.communicationMessage.findFirstOrThrow({ where: { sourceAccountId: account.id } })).id, fromEmail: 'buyer@example.com', reason: 'manual', candidateLeadIds: [deleted.id, merged.id] } });
  for (const leadId of [deleted.id, merged.id]) { try { await service.resolveReview(admin, review.id, leadId); } catch (e) { if (e.status === 404) permission[leadId === deleted.id ? 'deletedRejected' : 'mergedRejected'] = true; } }
  if (!Object.values(permission).every(Boolean)) throw new Error(`permission invariant failed ${JSON.stringify(permission)}`);
  console.log(JSON.stringify({ raceCounts, orphanCount, permission, auditActivities: await prisma.leadActivity.count({ where: { companyId: company.id } }) }));
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "Company" CASCADE');
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
