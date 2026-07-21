import { Module } from '@nestjs/common';
import { BrevoInboundController } from './brevo-inbound.controller';
import { BrevoInboundService } from './brevo-inbound.service';

@Module({
  controllers: [BrevoInboundController],
  providers: [BrevoInboundService],
  exports: [BrevoInboundService],
})
export class BrevoInboundModule {}
