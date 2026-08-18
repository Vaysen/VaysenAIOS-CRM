import { Body, Controller, Get, Patch, Post, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { MailWorkbenchService } from './mail-workbench.service';
import { MailWorkbenchBatchDto } from './dto/mail-workbench-batch.dto';

@ApiTags('Mail Workbench')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('mail-workbench')
export class MailWorkbenchController {
  constructor(private readonly svc: MailWorkbenchService) {}

  @Get('tree') @ApiOperation({ summary: 'Get folder tree with counts (accountId=单账号；不传=聚合全部+账号分组)' })
  getTree(@CurrentUser() u: any, @Query('accountId') accountId?: string) { return this.svc.getTree(u, accountId); }

  @Get('messages') @ApiOperation({ summary: 'List messages with filters (accountId=单账号/uncategorized 未分类；不传=聚合全部)' })
  getMessages(
    @Query('page') p?: string,
    @Query('limit') l?: string,
    @Query('folder') f?: string,
    @Query('search') s?: string,
    @Query('customerId') customerId?: string,
    @Query('ownerUserId') ownerUserId?: string,
    @Query('source') source?: string,
    @Query('status') status?: string,
    @Query('q') q?: string,
    @Query('accountId') accountId?: string,
    @CurrentUser() u?: any,
  ) {
    return this.svc.getMessages(u, {
      page: Number(p) || 1, limit: Number(l) || 20, folder: f, search: s,
      customerId, ownerUserId, source, status, q, accountId,
    });
  }

  @Get('messages/:id') @ApiOperation({ summary: 'Get single message' })
  getMessage(@Param('id') id: string, @CurrentUser() u: any) { return this.svc.getMessage(id, u); }

  @Patch('messages/batch') @ApiOperation({ summary: 'Batch update messages: mark_read|mark_unread|star|unstar|archive|delete (仅限本公司 inbound 消息)' })
  batchUpdate(@Body() dto: MailWorkbenchBatchDto, @CurrentUser() u: any) { return this.svc.batchUpdate(u, dto); }

  @Post('messages/:id/summarize') @ApiOperation({ summary: 'AI summarize message' })
  summarize(@Param('id') id: string, @CurrentUser() u: any) { return this.svc.summarize(id, u); }

  @Post('messages/:id/translate') @ApiOperation({ summary: 'AI translate with mode, sourceLanguage and targetLanguage' })
  translate(
    @Param('id') id: string,
    @Body() body: { targetLanguage?: string; sourceLanguage?: string; mode?: 'bilingual' | 'target_only' | 'source_only' },
    @CurrentUser() u: any,
  ) {
    return this.svc.translate(id, u, body?.targetLanguage, body?.mode, body?.sourceLanguage);
  }

  @Post('messages/:id/reply-drafts') @ApiOperation({ summary: 'Generate 3 reply drafts in customer language' })
  replyDrafts(
    @Param('id') id: string,
    @Body() body: { targetLanguage?: string },
    @CurrentUser() u: any,
  ) {
    return this.svc.replyDrafts(id, u, body?.targetLanguage);
  }

  @Post('messages/:id/scenario-draft') @ApiOperation({ summary: 'Generate scenario-based reply draft in customer language' })
  scenarioDraft(
    @Param('id') id: string,
    @Body() body: { scenario: string; targetLanguage?: string },
    @CurrentUser() u: any,
  ) {
    return this.svc.scenarioDraft(id, body.scenario, u, body?.targetLanguage);
  }

  @Get('summary') @ApiOperation({ summary: 'Get mail workbench summary counts' })
  getSummary(@CurrentUser() u: any) { return this.svc.getSummary(u); }
}
