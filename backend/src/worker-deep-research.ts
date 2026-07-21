import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { WorkerDeepResearchModule } from './worker-deep-research.module';
import { loadEnvFile } from './config/load-env';
import { assertRuntimeIsolation } from './common/queues/assert-isolation';

loadEnvFile();
assertRuntimeIsolation('DeepResearchWorker');

async function bootstrap() {
  const logger = new Logger('DeepResearchWorker');
  await NestFactory.createApplicationContext(WorkerDeepResearchModule);
  logger.log('Deep research worker started - processing deep-research queue');
}
bootstrap();
