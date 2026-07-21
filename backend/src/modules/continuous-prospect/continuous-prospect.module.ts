import { Module } from '@nestjs/common';
import { PrismaModule } from '@/common/prisma/prisma.module';
import { ContinuousProspectService } from './continuous-prospect.service';
import { ContinuousProspectController } from './continuous-prospect.controller';

@Module({
  imports: [PrismaModule],
  controllers: [ContinuousProspectController],
  providers: [ContinuousProspectService],
  exports: [ContinuousProspectService],
})
export class ContinuousProspectModule {}
