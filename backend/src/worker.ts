import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { WorkerModule } from './worker.module';
import { loadEnvFile } from './config/load-env';

loadEnvFile();

async function bootstrap() {
  const logger = new Logger('Worker');
  await NestFactory.createApplicationContext(WorkerModule);
  logger.log('Worker started');
}

bootstrap();
