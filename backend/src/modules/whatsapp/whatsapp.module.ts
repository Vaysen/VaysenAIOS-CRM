import { Module } from '@nestjs/common';
import { WhatsAppController } from './whatsapp.controller';
import { WhatsAppService } from './whatsapp.service';
import { WhatsAppAdapter } from './whatsapp-adapter';
import { EvolutionApiService } from './evolution-api.service';
import { EvolutionWebhookController } from './evolution-webhook.controller';
import { ElectronWebhookController } from './electron-webhook.controller';
import { BroadcastController } from './broadcast.controller';
// TASK-102D: 注入统一身份解析服务(PrismaModule 为全局模块,直接可用)
import { CustomerIdentityModule } from '../customer-identity/customer-identity.module';

@Module({
  imports: [CustomerIdentityModule],
  controllers: [WhatsAppController, EvolutionWebhookController, ElectronWebhookController, BroadcastController],
  providers: [WhatsAppService, WhatsAppAdapter, EvolutionApiService],
  exports: [WhatsAppService, EvolutionApiService],
})
export class WhatsAppModule {}
