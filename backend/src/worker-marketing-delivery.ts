import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { WorkerMarketingDeliveryModule } from './worker-marketing-delivery.module';
import { loadEnvFile } from './config/load-env';
import { assertRuntimeIsolation } from './common/queues/assert-isolation';

loadEnvFile();
assertRuntimeIsolation('MarketingDeliveryWorker');

async function bootstrap() {
  const logger = new Logger('MarketingDeliveryWorker');
  await NestFactory.createApplicationContext(WorkerMarketingDeliveryModule);
  logger.log('Marketing delivery worker started - processing marketing-delivery queue');
}
bootstrap();
