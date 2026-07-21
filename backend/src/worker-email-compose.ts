import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { WorkerEmailComposeModule } from './worker-email-compose.module';
import { loadEnvFile } from './config/load-env';
import { assertRuntimeIsolation } from './common/queues/assert-isolation';

loadEnvFile();
assertRuntimeIsolation('EmailComposeWorker');

async function bootstrap() {
  const logger = new Logger('EmailComposeWorker');
  await NestFactory.createApplicationContext(WorkerEmailComposeModule);
  logger.log('Email compose worker started - processing email-compose queue');
}
bootstrap();
