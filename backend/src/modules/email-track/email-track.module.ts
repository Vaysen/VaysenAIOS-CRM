import { Module } from '@nestjs/common';
import { EmailTrackController } from './email-track.controller';
import { EmailTrackService } from './email-track.service';
import { FollowUpRemindersModule } from '../follow-up-reminders/follow-up-reminders.module';
import { TimelineModule } from '../timeline/timeline.module';

@Module({
  imports: [FollowUpRemindersModule, TimelineModule],
  controllers: [EmailTrackController],
  providers: [EmailTrackService],
})
export class EmailTrackModule {}
