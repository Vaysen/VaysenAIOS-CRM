import { Module } from '@nestjs/common';
import { DuplicateLeadsController } from './duplicate-leads.controller';
import { DuplicateLeadsService } from './duplicate-leads.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { LeadScoresModule } from '../lead-scores/lead-scores.module';
import { TimelineModule } from '../timeline/timeline.module';

@Module({
  imports: [LeadScoresModule, TimelineModule],
  controllers: [DuplicateLeadsController],
  providers: [DuplicateLeadsService, PrismaService],
  exports: [DuplicateLeadsService],
})
export class DuplicateLeadsModule {}
