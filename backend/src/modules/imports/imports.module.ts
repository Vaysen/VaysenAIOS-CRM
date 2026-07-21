import { Module, forwardRef } from '@nestjs/common';
import { ImportsService } from './imports.service';
import { ImportsController } from './imports.controller';
import { DuplicateLeadsModule } from '../duplicate-leads/duplicate-leads.module';
import { LeadScoresModule } from '../lead-scores/lead-scores.module';
import { TimelineModule } from '../timeline/timeline.module';

@Module({
  imports: [
    forwardRef(() => DuplicateLeadsModule),
    LeadScoresModule,
    TimelineModule,
  ],
  controllers: [ImportsController],
  providers: [ImportsService],
  exports: [ImportsService],
})
export class ImportsModule {}
