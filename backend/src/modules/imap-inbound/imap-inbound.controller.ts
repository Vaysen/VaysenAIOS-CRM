import { Body, Controller, Get, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ImapInboundService } from './imap-inbound.service';

@ApiTags('IMAP inbound')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('imap-inbound')
export class ImapInboundController {
  constructor(private readonly service: ImapInboundService) {}
  @Get('accounts/:id/config') config(@CurrentUser() u: any, @Param('id') id: string) { return this.service.getConfig(u, id); }
  @Patch('accounts/:id/config') update(@CurrentUser() u: any, @Param('id') id: string, @Body() body: any) { return this.service.updateConfig(u, id, body); }
  @Post('accounts/:id/test') test(@CurrentUser() u: any, @Param('id') id: string) { return this.service.testConnection(u, id); }
  @Post('accounts/:id/sync') sync(@CurrentUser() u: any, @Param('id') id: string) { return this.service.sync(u, id); }
  @Post('sync-all') syncAll(@CurrentUser() u: any) { return this.service.syncAll(u); }
  @Get('reviews') reviews(@CurrentUser() u: any) { return this.service.listReviews(u); }
  @Post('reviews/:id/resolve') resolve(@CurrentUser() u: any, @Param('id') id: string, @Body() body: { leadId: string }) { return this.service.resolveReview(u, id, body.leadId); }
}
