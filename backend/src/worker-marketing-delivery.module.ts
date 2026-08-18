import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { buildBullRootConfig } from './common/queues/bull-config';
import { ConfigModule } from './config/config.module';
import { RealtimeModule } from './common/realtime/realtime.module';
import { PrismaModule } from './common/prisma/prisma.module';
import { AiProviderModule } from './common/ai/ai.module';
import { QUEUES } from './common/queues/queue-names';
import { MarketingCampaignsModule } from './modules/marketing-campaigns/marketing-campaigns.module';
import { MarketingDeliveryProcessor } from './modules/marketing-campaigns/marketing-delivery.processor';
import { WhatsAppModule } from './modules/whatsapp/whatsapp.module';
import { OwnerNotificationsModule } from './modules/owner-notifications/owner-notifications.module';

/**
 * R111 批次C：marketing-delivery 队列专用 worker 进程。
 * - 注册 marketing-delivery 队列 + MarketingDeliveryProcessor（concurrency=1）
 * - 依赖 WhatsAppModule（复用 WhatsAppService.sendTextWithReceipt 幂等回执链路）
 * - 依赖 MarketingCampaignsModule（复用 evaluateGate 触点级十道闸复评）
 */
@Module({
  imports: [
    BullModule.forRoot(buildBullRootConfig()),
    BullModule.registerQueue({
      name: QUEUES.marketingDelivery,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 15000 },
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    }),
    ConfigModule,
    RealtimeModule,
    PrismaModule,
    AiProviderModule,
    MarketingCampaignsModule,
    WhatsAppModule,
    OwnerNotificationsModule,
  ],
  providers: [MarketingDeliveryProcessor],
})
export class WorkerMarketingDeliveryModule {}
