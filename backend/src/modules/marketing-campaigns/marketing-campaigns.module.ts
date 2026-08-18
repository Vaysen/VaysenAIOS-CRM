import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaService } from '../../common/prisma/prisma.service';
import { QUEUES } from '../../common/queues/queue-names';
import { MarketingCampaignsController } from './marketing-campaigns.controller';
import { MarketingCampaignsService } from './marketing-campaigns.service';
import { MarketingPreferencesController } from './marketing-preferences.controller';
import { MarketingPreferencesService } from './marketing-preferences.service';
import { MarketingSafetyController } from './marketing-safety.controller';
import { MarketingSafetyService } from './marketing-safety.service';
import { MarketingExecutionController } from './marketing-execution.controller';
import { MarketingExecutionService } from './marketing-execution.service';
import { EmailAccountsModule } from '../email-accounts/email-accounts.module';

/**
 * wesley-ai-crm 批次2：marketing-campaigns 营销活动模块。
 * R111 批次C：注册 marketing-delivery 队列（入队侧），消费侧为独立 worker 进程
 * worker-marketing-delivery（docker-compose worker-marketing-delivery 服务）。
 */
@Module({
  imports: [
    EmailAccountsModule,
    BullModule.registerQueue({
      name: QUEUES.marketingDelivery,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 15000 },
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    }),
  ],
  controllers: [
    MarketingCampaignsController,
    MarketingPreferencesController,
    MarketingSafetyController,
    MarketingExecutionController,
  ],
  providers: [
    MarketingCampaignsService,
    MarketingPreferencesService,
    MarketingSafetyService,
    MarketingExecutionService,
    PrismaService,
  ],
  exports: [
    MarketingCampaignsService,
    MarketingExecutionService,
    MarketingSafetyService,
  ],
})
export class MarketingCampaignsModule {}
