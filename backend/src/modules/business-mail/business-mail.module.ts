import { Module } from '@nestjs/common';
import { BusinessMailController } from './business-mail.controller';
import { BusinessMailService } from './business-mail.service';
import { PrismaService } from '../../common/prisma/prisma.service';

@Module({
  controllers: [BusinessMailController],
  providers: [BusinessMailService, PrismaService],
  exports: [BusinessMailService],
})
export class BusinessMailModule {}
