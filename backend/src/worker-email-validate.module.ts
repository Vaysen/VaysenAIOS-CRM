import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { buildBullRootConfig } from './common/queues/bull-config';
import { ConfigModule } from './config/config.module';
import { PrismaModule } from './common/prisma/prisma.module';
import { QUEUES } from './common/queues/queue-names';
import { EmailValidateProcessor } from './modules/emails/email-validate.processor';

@Module({
  imports: [
    BullModule.forRoot(buildBullRootConfig()),
    BullModule.registerQueue(
      {
        name: QUEUES.emailValidate,
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
      {
        name: QUEUES.emailSend,
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
  ],
  providers: [EmailValidateProcessor],
})
export class WorkerEmailValidateModule {}
