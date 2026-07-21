import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { WorkerProspectSearchModule } from './worker-prospect-search.module';
import { loadEnvFile } from './config/load-env';
import { assertRuntimeIsolation } from './common/queues/assert-isolation';

loadEnvFile();
assertRuntimeIsolation('ProspectSearchWorker');

async function bootstrap() {
  const logger = new Logger('ProspectSearchWorker');
  await NestFactory.createApplicationContext(WorkerProspectSearchModule);
  logger.log('Prospect search worker started - processing prospect-search queue');
}
bootstrap();
