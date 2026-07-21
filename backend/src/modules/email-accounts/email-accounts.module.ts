import { Module } from '@nestjs/common';
import { EmailAccountsService } from './email-accounts.service';
import { EmailAccountsController } from './email-accounts.controller';

@Module({
  controllers: [EmailAccountsController],
  providers: [EmailAccountsService],
  exports: [EmailAccountsService],
})
export class EmailAccountsModule {}
