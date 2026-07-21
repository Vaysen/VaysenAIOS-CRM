import { Module, forwardRef } from '@nestjs/common';
import { LeadsService } from './leads.service';
import { AiCoachService } from './ai-coach.service';
import { LeadsController } from './leads.controller';
import { DuplicateLeadsModule } from '../duplicate-leads/duplicate-leads.module';
import { LeadScoresModule } from '../lead-scores/lead-scores.module';
import { FollowUpRemindersModule } from '../follow-up-reminders/follow-up-reminders.module';
import { TimelineModule } from '../timeline/timeline.module';
import { TagsModule } from '../tags/tags.module';
import { AiModule } from '../../common/ai/ai.module';
import { LanguageService } from '../../common/services/language.service';

@Module({
  imports: [
    forwardRef(() => DuplicateLeadsModule),
    LeadScoresModule,
    FollowUpRemindersModule,
    TimelineModule,
    TagsModule,
    AiModule,
  ],
  controllers: [LeadsController],
  providers: [LeadsService, AiCoachService, LanguageService],
  exports: [LeadsService, LanguageService],
})
export class LeadsModule {}
