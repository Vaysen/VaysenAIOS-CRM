import { Module } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CustomerFactsController } from './customer-facts.controller';
import { CustomerFactsService } from './customer-facts.service';

@Module({
  controllers: [CustomerFactsController],
  providers: [CustomerFactsService, PrismaService],
  exports: [CustomerFactsService],
})
export class CustomerFactsModule {}
