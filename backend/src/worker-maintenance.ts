import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { WorkerMaintenanceModule } from './worker-maintenance.module';
import { loadEnvFile } from './config/load-env';
import { assertRuntimeIsolation } from './common/queues/assert-isolation';

loadEnvFile();
assertRuntimeIsolation('MaintenanceWorker');

async function bootstrap() {
  const logger = new Logger('MaintenanceWorker');
  await NestFactory.createApplicationContext(WorkerMaintenanceModule);
  logger.log('Maintenance worker started - maintenance queue is ready');
}
bootstrap();
