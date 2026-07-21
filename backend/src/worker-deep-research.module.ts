import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { buildBullRootConfig } from './common/queues/bull-config';
import { ConfigModule } from './config/config.module';
import { PrismaModule } from './common/prisma/prisma.module';
import { QUEUES } from './common/queues/queue-names';
import { DataGathererService } from './modules/deep-research/data-gatherer.service';
import { BackgroundCheckAgent } from './modules/deep-research/background-check.agent';
import { ContactDiscoveryAgent } from './modules/deep-research/contact-discovery.agent';
import { MarketAnalysisAgent } from './modules/deep-research/market-analysis.agent';
import { ReportTemplateService } from './modules/deep-research/report-template';
import { DeepResearchProcessor } from './modules/deep-research/deep-research.processor';

@Module({
  imports: [
    BullModule.forRoot(buildBullRootConfig()),
    BullModule.registerQueue({
      name: QUEUES.deepResearch,
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 30000 },
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    }),
    ConfigModule,
    PrismaModule,
  ],
  providers: [
    DataGathererService,
    BackgroundCheckAgent,
    ContactDiscoveryAgent,
    MarketAnalysisAgent,
    ReportTemplateService,
    DeepResearchProcessor,
  ],
})
export class WorkerDeepResearchModule {}
