import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule } from './config/config.module';
import { PrismaModule } from './common/prisma/prisma.module';
import { buildBullRootConfig } from './common/queues/bull-config';
import { SearchWorkerModule } from './modules/search/search-worker.module';

@Module({
  imports: [
    BullModule.forRoot(buildBullRootConfig()),
    ConfigModule,
    PrismaModule,
    SearchWorkerModule,
  ],
})
export class WorkerProspectSearchModule {}
