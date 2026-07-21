import { Module } from '@nestjs/common';
import { QuotesController } from './quotes.controller';
import { QuotesService } from './quotes.service';
import { PrismaService } from '../../common/prisma/prisma.service';

@Module({
  controllers: [QuotesController],
  providers: [QuotesService, PrismaService],
  exports: [QuotesService],
})
export class QuotesModule {}
