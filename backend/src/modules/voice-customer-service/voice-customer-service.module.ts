import { Module } from '@nestjs/common';
import { VoiceCustomerServiceController } from './voice-customer-service.controller';
import { VoiceCustomerServiceService } from './voice-customer-service.service';

@Module({
  controllers: [VoiceCustomerServiceController],
  providers: [VoiceCustomerServiceService],
  exports: [VoiceCustomerServiceService],
})
export class VoiceCustomerServiceModule {}
