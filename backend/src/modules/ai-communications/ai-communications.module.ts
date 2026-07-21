import { Module } from '@nestjs/common';
import { AiCommunicationsController } from './ai-communications.controller';
import { AiCommunicationsService } from './ai-communications.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RolesGuard } from '../../common/guards/roles.guard';

@Module({
  controllers: [AiCommunicationsController],
  providers: [AiCommunicationsService, PrismaService, RolesGuard],
  exports: [AiCommunicationsService],
})
export class AiCommunicationsModule {}
