import { Module } from '@nestjs/common';
import { FollowUpRemindersController } from './follow-up-reminders.controller';
import { FollowUpRemindersService } from './follow-up-reminders.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TimelineModule } from '../timeline/timeline.module';

@Module({
  imports: [TimelineModule],
  controllers: [FollowUpRemindersController],
  providers: [FollowUpRemindersService, PrismaService],
  exports: [FollowUpRemindersService],
})
export class FollowUpRemindersModule {}
