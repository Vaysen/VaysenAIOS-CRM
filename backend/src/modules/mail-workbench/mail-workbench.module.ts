import { Module } from '@nestjs/common';
import { MailWorkbenchController } from './mail-workbench.controller';
import { MailWorkbenchService } from './mail-workbench.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AiProviderService } from '../../common/ai/ai-provider.service';
import { AiModule } from '../../common/ai/ai.module';
import { LeadsModule } from '../leads/leads.module';

@Module({
  imports: [AiModule, LeadsModule],
  controllers: [MailWorkbenchController],
  providers: [MailWorkbenchService, PrismaService, AiProviderService],
  exports: [MailWorkbenchService],
})
export class MailWorkbenchModule {}
