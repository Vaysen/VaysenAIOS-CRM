import { Module } from '@nestjs/common';
import { EmailEventsSyncService } from './email-events-sync.service';
import { PrismaService } from '../../common/prisma/prisma.service';

@Module({
  providers: [EmailEventsSyncService, PrismaService],
  exports: [EmailEventsSyncService],
})
export class EmailEventsSyncModule {}
