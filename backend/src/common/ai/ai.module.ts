import { Global, Module } from '@nestjs/common';
import { AiProviderService } from './ai-provider.service';

@Global()
@Module({
  providers: [AiProviderService],
  exports: [AiProviderService],
})
export class AiProviderModule {}

// Re-export as AiModule alias so feature modules can import { AiModule } from '.../common/ai/ai.module'
export { AiProviderModule as AiModule };
