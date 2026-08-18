import { Module } from '@nestjs/common';
import { QuotesModule } from '../quotes/quotes.module';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SalesDeliveryController } from './sales-delivery.controller';
import { SalesDeliveryWebhookController } from './sales-delivery-webhook.controller';
import { SalesDeliveryService } from './sales-delivery.service';
import { SalesDeliveryRecoveryService } from './sales-delivery-recovery.service';
import {
  SalesDeliveryAdapterRegistry,
  SalesDeliveryEmailAdapter,
  SalesDeliveryMetaAdapter,
  SalesDeliveryWhatsAppAdapter,
} from './sales-delivery-adapters';

/**
 * wesley-ai-crm 批次3：sales-delivery 报价交付回执链。
 * - 复用 QuotesModule 的 PDF 渲染（generatePiHtml / htmlToPdf）
 * - 无 BullMQ worker：恢复服务由 /sales-delivery/recovery/run 驱动（可从简）
 * - Webhook 回执端点 @Public() + HMAC（见 webhook controller）
 */
@Module({
  imports: [QuotesModule],
  controllers: [SalesDeliveryController, SalesDeliveryWebhookController],
  providers: [
    SalesDeliveryService,
    SalesDeliveryRecoveryService,
    SalesDeliveryAdapterRegistry,
    SalesDeliveryEmailAdapter,
    SalesDeliveryWhatsAppAdapter,
    SalesDeliveryMetaAdapter,
    PrismaService,
  ],
  exports: [SalesDeliveryService, SalesDeliveryRecoveryService],
})
export class SalesDeliveryModule {}
