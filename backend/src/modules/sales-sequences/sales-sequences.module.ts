import { Module } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { SalesSequencesController } from './sales-sequences.controller';
import { SalesSequencesService } from './sales-sequences.service';

@Module({
  controllers: [SalesSequencesController],
  providers: [SalesSequencesService, PrismaService],
  exports: [SalesSequencesService],
})
export class SalesSequencesModule {}
