import { Module } from '@nestjs/common';
import { AssistantPermissionService } from '../agent/assistant-permission.service';
import { OutboundComplianceService } from './outbound-compliance.service';
import { OutboundController } from './outbound.controller';

@Module({
  controllers: [OutboundController],
  providers: [AssistantPermissionService, OutboundComplianceService],
  exports: [OutboundComplianceService],
})
export class OutboundModule {}
