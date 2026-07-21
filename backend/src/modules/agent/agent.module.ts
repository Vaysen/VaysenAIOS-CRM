import { Module, forwardRef } from '@nestjs/common';
import { AgentController } from './agent.controller';
import { AgentService } from './agent.service';
import { DeepResearchModule } from '../deep-research/deep-research.module';
import { OpenClawModule } from '../openclaw/openclaw.module';
import { AssistantPermissionService } from './assistant-permission.service';
import { AssistantExternalActionService } from './assistant-external-action.service';

@Module({
  imports: [DeepResearchModule, forwardRef(() => OpenClawModule)],
  controllers: [AgentController],
  providers: [AgentService, AssistantPermissionService, AssistantExternalActionService],
  exports: [AgentService, AssistantPermissionService, AssistantExternalActionService],
})
export class AgentModule {}
