import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { WorkerEmailValidateModule } from './worker-email-validate.module';
import { loadEnvFile } from './config/load-env';
import { assertRuntimeIsolation } from './common/queues/assert-isolation';

loadEnvFile();
assertRuntimeIsolation('EmailValidateWorker');

async function bootstrap() {
  const logger = new Logger('EmailValidateWorker');
  await NestFactory.createApplicationContext(WorkerEmailValidateModule);
  logger.log('Email validate worker started - processing email-validate queue');
}
bootstrap();
