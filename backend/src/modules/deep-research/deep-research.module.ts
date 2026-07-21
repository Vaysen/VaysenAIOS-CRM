import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '@/common/prisma/prisma.module';
import { QUEUES } from '@/common/queues/queue-names';
import { DeepResearchController } from './deep-research.controller';
import { DataGathererService } from './data-gatherer.service';
import { BackgroundCheckAgent } from './background-check.agent';
import { ContactDiscoveryAgent } from './contact-discovery.agent';
import { MarketAnalysisAgent } from './market-analysis.agent';
import { ReportTemplateService } from './report-template';
import { DeepResearchRunService } from './deep-research-run.service';

@Module({
  imports: [
    PrismaModule,
    BullModule.registerQueue({
      name: QUEUES.deepResearch,
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 30000 },
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    }),
  ],
  controllers: [DeepResearchController],
  providers: [DataGathererService, BackgroundCheckAgent, ContactDiscoveryAgent, MarketAnalysisAgent, ReportTemplateService, DeepResearchRunService],
  exports: [DataGathererService, BackgroundCheckAgent, ContactDiscoveryAgent, MarketAnalysisAgent, ReportTemplateService, DeepResearchRunService],
})
export class DeepResearchModule {}
