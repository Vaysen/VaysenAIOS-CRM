import { Module } from '@nestjs/common';
import { PrismaModule } from '../../common/prisma/prisma.module';
import { ImapInboundController } from './imap-inbound.controller';
import { ImapInboundService } from './imap-inbound.service';

@Module({ imports: [PrismaModule], controllers: [ImapInboundController], providers: [ImapInboundService], exports: [ImapInboundService] })
export class ImapInboundModule {}
