import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { EmailsController } from './emails.controller';
import { EmailsService } from './emails.service';
import { QUEUES } from '@/common/queues/queue-names';
import { OutboundModule } from '../outbound/outbound.module';
import { EmailAccountsModule } from '../email-accounts/email-accounts.module';

@Module({
  imports: [
    OutboundModule,
    // R111 批次A: 邮箱账户分级 → 营销动作强制校验（send-batch / send-single source=marketing）
    EmailAccountsModule,
    BullModule.registerQueue(
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
        name: QUEUES.emailValidate,
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
  ],
  controllers: [EmailsController],
  providers: [EmailsService],
  exports: [EmailsService],
})
export class EmailsModule {}
