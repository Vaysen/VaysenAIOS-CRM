import { PrismaClient } from '@prisma/client';
import { Queue } from 'bullmq';

const prisma = new PrismaClient();
const REDIS_HOST = process.env.REDIS_HOST || 'localhost';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '16379', 10);

const Q = new Queue('prospect-search', { connection: { host: REDIS_HOST, port: REDIS_PORT } });

const tasks = await prisma.searchTask.findMany({
  where: { status: 'pending', createdAt: { gte: new Date(Date.now() - 5 * 60 * 1000) } },
  select: { id: true, keywords: true, targetCountry: true, customerType: true, excludeWords: true, searchLanguage: true, maxResults: true, createdBy: true },
});

console.log(`Queueing ${tasks.length} tasks...`);
let n = 0;
for (const t of tasks) {
  await Q.add('execute-search', {
    taskId: t.id,
    keywords: t.keywords,
    targetCountry: t.targetCountry,
    customerType: t.customerType,
    excludeWords: t.excludeWords,
    searchLanguage: t.searchLanguage,
    maxResults: t.maxResults,
  }, { removeOnComplete: 100, removeOnFail: 100 });
  n++;
}
console.log(`Queued ${n} tasks`);
await Q.close();
await prisma.$disconnect();
