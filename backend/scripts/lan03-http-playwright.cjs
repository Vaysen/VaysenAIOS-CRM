const { request } = require('../../node_modules/playwright');
const { PrismaClient } = require('@prisma/client');
const fs = require('fs');
const seed = JSON.parse(fs.readFileSync('C:/tmp/lan03-http-seed.log', 'utf16le').replace(/^\uFEFF/, '').trim());
const prisma = new PrismaClient();
async function main() {
  const api = await request.newContext({ baseURL: 'http://127.0.0.1:4000', extraHTTPHeaders: { Authorization: `Bearer ${seed.token}`, 'X-Company-Id': seed.companyId } });
  const before = await api.get(`/api/imap-inbound/accounts/${seed.accountId}/config`);
  const update = await api.patch(`/api/imap-inbound/accounts/${seed.accountId}/config`, { data: { host: '127.0.0.1', port: 1143, tls: false, username: 'fake', secret: 'local-only', enabled: true, pollIntervalSeconds: 60 } });
  const after = await api.get(`/api/imap-inbound/accounts/${seed.accountId}/config`);
  const reviews = await api.get('/api/imap-inbound/reviews');
  const result = { before: before.status(), update: update.status(), after: after.status(), reviews: reviews.status(), configured: (await after.json()).configured };
  console.log(JSON.stringify(result));
  if (result.before !== 200 || result.update !== 200 || result.after !== 200 || result.reviews !== 200 || result.configured !== true) process.exitCode = 1;
  await api.dispose();
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "Company" CASCADE');
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
