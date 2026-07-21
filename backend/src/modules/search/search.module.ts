import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '@/common/prisma/prisma.module';
import { QUEUES } from '@/common/queues/queue-names';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';

@Module({
  imports: [
    PrismaModule,
    BullModule.registerQueue({ name: QUEUES.prospectSearch }),
  ],
  controllers: [SearchController],
  providers: [SearchService],
  exports: [SearchService],
})
export class SearchModule {}
