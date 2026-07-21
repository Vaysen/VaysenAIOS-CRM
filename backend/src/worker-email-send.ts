import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { WorkerEmailSendModule } from './worker-email-send.module';
import { loadEnvFile } from './config/load-env';
import { assertRuntimeIsolation } from './common/queues/assert-isolation';

loadEnvFile();
assertRuntimeIsolation('EmailSendWorker');

async function bootstrap() {
  const logger = new Logger('EmailSendWorker');
  await NestFactory.createApplicationContext(WorkerEmailSendModule);
  logger.log('Email send worker started - processing email-send queue');
}
bootstrap();
