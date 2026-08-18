const { PrismaClient } = require('@prisma/client');
const jwt = require('jsonwebtoken');
const prisma = new PrismaClient();
async function main() {
  const slug = `lan03-http-${Date.now()}`;
  const company = await prisma.company.create({ data: { name: slug, slug } });
  const role = await prisma.role.upsert({ where: { name: 'company_admin' }, update: {}, create: { name: 'company_admin', displayName: 'Company Administrator' } });
  const user = await prisma.user.create({ data: { email: `${slug}@example.com`, passwordHash: 'test', firstName: 'HTTP', lastName: 'Admin' } });
  await prisma.userCompanyRelation.create({ data: { userId: user.id, companyId: company.id, roleId: role.id, isDefault: true } });
  const account = await prisma.emailAccount.create({ data: { companyId: company.id, senderName: 'Sales', senderEmail: `${slug}@example.com`, smtpHost: 'stub', smtpPort: 25, smtpUsername: 'stub', smtpPasswordEncrypted: 'stub' } });
  const token = jwt.sign({ sub: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '10m' });
  console.log(JSON.stringify({ companyId: company.id, accountId: account.id, token }));
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
