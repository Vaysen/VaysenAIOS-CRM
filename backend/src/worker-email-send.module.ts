import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { buildBullRootConfig } from './common/queues/bull-config';
import { ConfigModule } from './config/config.module';
import { PrismaModule } from './common/prisma/prisma.module';
import { QUEUES } from './common/queues/queue-names';
import { TimelineModule } from './modules/timeline/timeline.module';
import { FollowUpRemindersModule } from './modules/follow-up-reminders/follow-up-reminders.module';
import { EmailSendProcessor } from './modules/emails/email-send.processor';

@Module({
  imports: [
    BullModule.forRoot(buildBullRootConfig()),
    BullModule.registerQueue(
      {
        name: QUEUES.emailSend,
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 10000 },
          removeOnComplete: 100,
          removeOnFail: 100,
        },
      },
      {
        name: QUEUES.emailCompose,
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 10000 },
          removeOnComplete: 100,
          removeOnFail: 100,
        },
      },
    ),
    ConfigModule,
    PrismaModule,
    TimelineModule,
    FollowUpRemindersModule,
  ],
  providers: [EmailSendProcessor],
})
export class WorkerEmailSendModule {}
