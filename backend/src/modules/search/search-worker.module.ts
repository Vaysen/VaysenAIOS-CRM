import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '@/common/prisma/prisma.module';
import { QUEUES } from '@/common/queues/queue-names';
import { SearchService } from './search.service';
import { SearchProcessor } from './search.processor';

@Module({
  imports: [
    PrismaModule,
    BullModule.registerQueue({ name: QUEUES.prospectSearch }),
  ],
  providers: [SearchService, SearchProcessor],
})
export class SearchWorkerModule {}
