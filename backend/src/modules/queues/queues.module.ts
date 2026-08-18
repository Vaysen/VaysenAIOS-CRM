import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '@/common/prisma/prisma.module';
import { QUEUES } from '@/common/queues/queue-names';
import { QueuesController } from './queues.controller';
import { QueuesService } from './queues.service';

@Module({
  imports: [
    PrismaModule,
    BullModule.registerQueue(
      { name: QUEUES.emailCompose },
      { name: QUEUES.emailValidate },
      { name: QUEUES.emailSend },
      { name: QUEUES.prospectSearch },
      { name: QUEUES.deepResearch },
      { name: QUEUES.maintenance },
      { name: QUEUES.marketingDelivery },
    ),
  ],
  controllers: [QueuesController],
  providers: [QueuesService],
})
export class QueuesModule {}
