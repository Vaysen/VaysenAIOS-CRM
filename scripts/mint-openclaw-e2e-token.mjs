import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';

const [companyId, ownerEmail, ttlRaw = '600'] = process.argv.slice(2);
const fail = (message) => {
  throw new Error(`OpenClaw E2E token mint rejected: ${message}`);
};

if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(companyId || '')) {
  fail('company id must be a UUID');
}
if (!/^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(ownerEmail || '')) {
  fail('owner email is invalid');
}
const ttlSeconds = Number(ttlRaw);
if (!Number.isInteger(ttlSeconds) || ttlSeconds < 300 || ttlSeconds > 900) {
  fail('TTL must be between 300 and 900 seconds');
}
const jwtSecret = process.env.JWT_SECRET || '';
if (jwtSecret.length < 32) fail('JWT_SECRET is unavailable or too short');

const prisma = new PrismaClient();
try {
  const user = await prisma.user.findFirst({
    where: {
      email: { equals: ownerEmail, mode: 'insensitive' },
      isActive: true,
      deletedAt: null,
    },
    select: {
      id: true,
      email: true,
      companies: {
        where: { companyId, isActive: true },
        select: { role: { select: { name: true } } },
      },
    },
  });
  if (!user) fail('active owner account was not found');
  if (user.companies.length !== 1 || user.companies[0]?.role?.name !== 'company_admin') {
    fail('owner must have exactly one active company_admin relation for the acceptance company');
  }

  const token = jwt.sign(
    { sub: user.id, email: user.email },
    jwtSecret,
    { expiresIn: ttlSeconds, jwtid: randomUUID() },
  );
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
    fail('JWT library returned an invalid token shape');
  }
  process.stdout.write(token);
} finally {
  await prisma.$disconnect();
}
