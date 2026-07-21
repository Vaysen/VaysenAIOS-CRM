'use strict';

const net = require('node:net');
const { PrismaClient } = require('@prisma/client');

function probeRedis() {
  const host = process.env.REDIS_HOST || 'redis';
  const port = Number(process.env.REDIS_PORT || 6379);

  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(3000);
    socket.once('connect', () => {
      socket.end();
      resolve();
    });
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error('Redis health probe timed out'));
    });
    socket.once('error', reject);
  });
}

async function main() {
  const prisma = new PrismaClient();
  try {
    await prisma.$queryRawUnsafe('SELECT 1');
    await probeRedis();
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(`[worker-healthcheck] ${error?.message || error}`);
  process.exitCode = 1;
});
