import { Global, Module } from '@nestjs/common';
import { RealtimeEventBus } from './realtime-event-bus';

@Global()
@Module({
  providers: [RealtimeEventBus],
  exports: [RealtimeEventBus],
})
export class RealtimeModule {}
