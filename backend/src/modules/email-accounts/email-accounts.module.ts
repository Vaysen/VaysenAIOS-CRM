import { Module } from '@nestjs/common';
import { EmailAccountsService } from './email-accounts.service';
import { EmailAccountsController } from './email-accounts.controller';
import { OutboundModule } from '../outbound/outbound.module';

@Module({
  imports: [OutboundModule],
  controllers: [EmailAccountsController],
  providers: [EmailAccountsService],
  exports: [EmailAccountsService],
})
export class EmailAccountsModule {}
