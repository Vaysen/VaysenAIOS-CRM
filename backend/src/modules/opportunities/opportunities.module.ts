import { Module } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { OpportunitiesController } from './opportunities.controller';
import { OpportunitiesService } from './opportunities.service';

@Module({
  controllers: [OpportunitiesController],
  providers: [OpportunitiesService, PrismaService],
  exports: [OpportunitiesService],
})
export class OpportunitiesModule {}
