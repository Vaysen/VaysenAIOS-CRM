import { Module } from '@nestjs/common';
import { UnsubscribeController } from './unsubscribe.controller';
import { UnsubscribeService } from './unsubscribe.service';
import { TimelineModule } from '../timeline/timeline.module';

@Module({
  imports: [TimelineModule],
  controllers: [UnsubscribeController],
  providers: [UnsubscribeService],
})
export class UnsubscribeModule {}
