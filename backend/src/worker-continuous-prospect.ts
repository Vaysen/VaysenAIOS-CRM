/**
 * Continuous Prospect Worker — 24/7 autonomous customer acquisition
 *
 * This worker runs independently from the main API server.
 * It continuously searches for new prospects, evaluates them,
 * and auto-converts qualified leads into the assignment pool.
 *
 * Start: node dist/src/worker-continuous-prospect
 */
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { ContinuousProspectModule } from './modules/continuous-prospect/continuous-prospect.module';
import { ContinuousProspectService } from './modules/continuous-prospect/continuous-prospect.service';
import { PrismaModule } from './common/prisma/prisma.module';
import { Module } from '@nestjs/common';
import { assertRuntimeIsolation } from './common/queues/assert-isolation';

// Minimal standalone module that only loads what the worker needs
@Module({
  imports: [ContinuousProspectModule, PrismaModule],
})
class WorkerContinuousProspectModule {}

async function bootstrap() {
  const logger = new Logger('ContinuousProspectWorker');

  // Load env
  const path = require('path');
  const fs = require('fs');
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  }

  // Fail loudly if REDIS_DB doesn't match the Postgres schema (prevents this
  // worker from silently consuming the other instance's queue jobs).
  assertRuntimeIsolation('ContinuousProspectWorker');

  const app = await NestFactory.createApplicationContext(WorkerContinuousProspectModule, {
    logger: ['log', 'warn', 'error'],
  });

  const service = app.get(ContinuousProspectService);
  logger.log('Continuous prospect worker starting...');
  await service.start();

  // Keep alive
  process.on('SIGTERM', async () => {
    logger.log('SIGTERM received, stopping...');
    await service.stop();
    await app.close();
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    logger.log('SIGINT received, stopping...');
    await service.stop();
    await app.close();
    process.exit(0);
  });
}

bootstrap().catch((err) => {
  console.error('Continuous prospect worker failed to start:', err);
  process.exit(1);
});
