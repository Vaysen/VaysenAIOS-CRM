import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { buildBullRootConfig } from './common/queues/bull-config';
import { ConfigModule } from './config/config.module';
import { PrismaModule } from './common/prisma/prisma.module';
import { TimelineModule } from './modules/timeline/timeline.module';
import { FollowUpRemindersModule } from './modules/follow-up-reminders/follow-up-reminders.module';
import { SearchWorkerModule } from './modules/search/search-worker.module';

@Module({
  imports: [
    BullModule.forRoot(buildBullRootConfig()),
    ConfigModule,
    PrismaModule,
    TimelineModule,
    FollowUpRemindersModule,
    SearchWorkerModule,
  ],
})
export class WorkerModule {}
