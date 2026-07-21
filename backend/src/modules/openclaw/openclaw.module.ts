import { Module, forwardRef } from '@nestjs/common';
import { AgentModule } from '../agent/agent.module';
import { BusinessMailModule } from '../business-mail/business-mail.module';
import { WhatsAppModule } from '../whatsapp/whatsapp.module';
import { QuotesModule } from '../quotes/quotes.module';
import { OpenClawController } from './openclaw.controller';
import { OpenClawGatewayClient } from './openclaw-gateway.client';
import { OpenClawHmacGuard } from './openclaw-hmac.guard';
import { OpenClawInternalController } from './openclaw-internal.controller';
import { OpenClawRuntimeService } from './openclaw-runtime.service';
import { OpenClawToolBrokerService } from './openclaw-tool-broker.service';
import { OpenClawCrmSessionService } from './openclaw-crm-session.service';
import { OpenClawSelectionService } from './openclaw-selection.service';

@Module({
  imports: [forwardRef(() => AgentModule), BusinessMailModule, QuotesModule, WhatsAppModule],
  controllers: [OpenClawController, OpenClawInternalController],
  providers: [
    OpenClawGatewayClient,
    OpenClawRuntimeService,
    OpenClawHmacGuard,
    OpenClawToolBrokerService,
    OpenClawCrmSessionService,
    OpenClawSelectionService,
  ],
  exports: [OpenClawGatewayClient, OpenClawRuntimeService, OpenClawCrmSessionService],
})
export class OpenClawModule {}
