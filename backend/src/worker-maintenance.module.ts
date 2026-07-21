import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule } from './config/config.module';
import { PrismaModule } from './common/prisma/prisma.module';
import { QUEUES } from './common/queues/queue-names';
import { buildBullRootConfig } from './common/queues/bull-config';
import { OpenClawMaintenanceService } from './modules/openclaw/openclaw-maintenance.service';

@Module({
  imports: [
    BullModule.forRoot(buildBullRootConfig()),
    BullModule.registerQueue({ name: QUEUES.maintenance }),
    ConfigModule,
    PrismaModule,
  ],
  providers: [OpenClawMaintenanceService],
})
export class WorkerMaintenanceModule {}
