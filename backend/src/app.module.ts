import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { BullModule } from '@nestjs/bullmq';
import { buildBullRootConfig } from './common/queues/bull-config';
import { ConfigModule } from './config/config.module';
import { PrismaModule } from './common/prisma/prisma.module';
import { AiProviderModule } from './common/ai/ai.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { CompaniesModule } from './modules/companies/companies.module';
import { LeadsModule } from './modules/leads/leads.module';
import { DuplicateLeadsModule } from './modules/duplicate-leads/duplicate-leads.module';
import { LeadScoresModule } from './modules/lead-scores/lead-scores.module';
import { ImportsModule } from './modules/imports/imports.module';
import { EmailAccountsModule } from './modules/email-accounts/email-accounts.module';
import { EmailTemplatesModule } from './modules/email-templates/email-templates.module';
import { EmailsModule } from './modules/emails/emails.module';
import { EmailTrackModule } from './modules/email-track/email-track.module';
import { UnsubscribeModule } from './modules/unsubscribe/unsubscribe.module';
import { FollowUpRemindersModule } from './modules/follow-up-reminders/follow-up-reminders.module';
import { TimelineModule } from './modules/timeline/timeline.module';
import { SearchModule } from './modules/search/search.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { ProductsModule } from './modules/products/products.module';
import { TagsModule } from './modules/tags/tags.module';
import { DeepResearchModule } from './modules/deep-research/deep-research.module';
import { MaterialsModule } from './modules/materials/materials.module';
import { QueuesModule } from './modules/queues/queues.module';
import { ContinuousProspectModule } from "./modules/continuous-prospect/continuous-prospect.module";
import { AiModule } from './modules/ai/ai.module';
import { CommunicationsModule } from './modules/communications/communications.module';
import { BusinessMailModule } from './modules/business-mail/business-mail.module';
import { EmailEventsSyncModule } from './modules/email-events-sync/email-events-sync.module';
import { WhatsAppModule } from './modules/whatsapp/whatsapp.module';
import { AiCommunicationsModule } from './modules/ai-communications/ai-communications.module';
import { QuotesModule } from './modules/quotes/quotes.module';
import { OrdersModule } from './modules/orders/orders.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { MailWorkbenchModule } from './modules/mail-workbench/mail-workbench.module';
import { CustomizerModule } from './modules/customizer/customizer.module';
import { RealtimeModule } from './common/realtime/realtime.module';
// TASK-102D: 注册客户身份解析模块,供 WhatsApp 等渠道调用 IdentityResolutionService
import { CustomerIdentityModule } from './modules/customer-identity/customer-identity.module';
import { CustomerAssetsModule } from './modules/customer-assets/customer-assets.module';
import { VoiceCustomerServiceModule } from './modules/voice-customer-service/voice-customer-service.module';
import { AgentModule } from './modules/agent/agent.module';
import { BrevoInboundModule } from './modules/brevo-inbound/brevo-inbound.module';
import { OpenClawModule } from './modules/openclaw/openclaw.module';
import { OwnerNotificationsModule } from './modules/owner-notifications/owner-notifications.module';
import { ImapInboundModule } from './modules/imap-inbound/imap-inbound.module';
import { AssistantToolModule } from './modules/assistant-tools/assistant-tool.module';
import { OpportunitiesModule } from './modules/opportunities/opportunities.module';
import { SalesSequencesModule } from './modules/sales-sequences/sales-sequences.module';
import { CustomerFactsModule } from './modules/customer-facts/customer-facts.module';
import { MarketingCampaignsModule } from './modules/marketing-campaigns/marketing-campaigns.module';
import { SalesDeliveryModule } from './modules/sales-delivery/sales-delivery.module';
import { AudienceSegmentsModule } from './modules/audience-segments/audience-segments.module';
import { DailyDiagnosisModule } from './modules/daily-diagnosis/daily-diagnosis.module';
import { ExchangeRatesModule } from './modules/exchange-rates/exchange-rates.module';

@Module({
  imports: [
    BullModule.forRoot(buildBullRootConfig()),
    ConfigModule,
    PrismaModule,
    AiProviderModule,
    RealtimeModule,
    AuthModule,
    UsersModule,
    CompaniesModule,
    LeadsModule,
    DuplicateLeadsModule,
    LeadScoresModule,
    ImportsModule,
    EmailAccountsModule,
    EmailTemplatesModule,
    EmailsModule,
    EmailTrackModule,
    UnsubscribeModule,
    FollowUpRemindersModule,
    TimelineModule,
    SearchModule,
    AnalyticsModule,
    ProductsModule,
    TagsModule,
    DeepResearchModule,
    MaterialsModule,
    QueuesModule,
    AiModule,
    ContinuousProspectModule,
    CommunicationsModule,
    BusinessMailModule,
    EmailEventsSyncModule,
    WhatsAppModule,
    CustomerIdentityModule,
    CustomerAssetsModule,
    AiCommunicationsModule,
    QuotesModule,
    OrdersModule,
    DashboardModule,
    MailWorkbenchModule,
    CustomizerModule,
    VoiceCustomerServiceModule,
    AgentModule,
    OpenClawModule,
    OwnerNotificationsModule,
    ImapInboundModule,
    AssistantToolModule,
    BrevoInboundModule,
    OpportunitiesModule,
    SalesSequencesModule,
    CustomerFactsModule,
    MarketingCampaignsModule,
    SalesDeliveryModule,
    AudienceSegmentsModule,
    DailyDiagnosisModule,
    ExchangeRatesModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}
