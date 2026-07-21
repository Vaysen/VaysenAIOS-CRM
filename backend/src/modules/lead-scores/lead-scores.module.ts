import { Module } from '@nestjs/common';
import { LeadScoringService } from './lead-scoring.service';
import { LeadScoresService } from './lead-scores.service';
import { LeadScoresController } from './lead-scores.controller';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TimelineModule } from '../timeline/timeline.module';

@Module({
  imports: [TimelineModule],
  controllers: [LeadScoresController],
  providers: [LeadScoringService, LeadScoresService, PrismaService],
  exports: [LeadScoringService, LeadScoresService],
})
export class LeadScoresModule {}
