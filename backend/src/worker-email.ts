import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { WorkerEmailModule } from './worker-email.module';
import { loadEnvFile } from './config/load-env';
import { assertRuntimeIsolation } from './common/queues/assert-isolation';

loadEnvFile();
assertRuntimeIsolation('EmailWorker');

async function bootstrap() {
  const logger = new Logger('EmailWorker');
  await NestFactory.createApplicationContext(WorkerEmailModule);
  logger.log('Email worker started - processing compose, validate, and send queues');
}
bootstrap();
