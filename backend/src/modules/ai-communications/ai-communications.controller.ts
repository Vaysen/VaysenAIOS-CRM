import { Controller, Get, Post, Param, Body, Patch, UseGuards, NotFoundException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AiCommunicationsService } from './ai-communications.service';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { aiDiagnosticsEnabled, buildAiDiagnosticSnapshot } from './ai-diagnostic';

@ApiTags('AI Communications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('ai-communications')
export class AiCommunicationsController {
  constructor(private readonly aiService: AiCommunicationsService) {}

  @Post('translate/:messageId')
  @ApiOperation({ summary: 'Translate a message (default: customer language -> Chinese for operators)' })
  translate(
    @Param('messageId') id: string,
    @Body() body: { targetLang?: string; sourceLanguage?: string },
    @CurrentUser() user: any,
  ) {
    return this.aiService.translateMessage(id, user, body?.targetLang || 'zh', body?.sourceLanguage);
  }

  @Post('summarize/:conversationId')
  @ApiOperation({ summary: 'Summarize a conversation' })
  summarize(@Param('conversationId') id: string, @CurrentUser() user: any) {
    return this.aiService.summarizeConversation(id, user);
  }

  @Post('suggest-replies/:messageId')
  @ApiOperation({ summary: 'Generate reply suggestions in customer language with Chinese summaries' })
  suggestReplies(
    @Param('messageId') id: string,
    @Body() body: { targetLanguage?: string },
    @CurrentUser() user: any,
  ) {
    return this.aiService.suggestReplies(id, user, body?.targetLanguage);
  }

  @Post('extract-quote/:conversationId')
  @ApiOperation({ summary: 'Extract quote fields from conversation' })
  extractQuote(@Param('conversationId') id: string, @CurrentUser() user: any) {
    return this.aiService.extractQuoteFields(id, user);
  }

  @Post('generate-quote/:conversationId')
  @ApiOperation({ summary: 'AI generate full quote with pricing from conversation' })
  generateQuote(
    @Param('conversationId') id: string,
    @Body() body: { type?: string },
    @CurrentUser() user: any,
  ) {
    return this.aiService.generateQuote(id, user, body?.type || 'quote');
  }

  @Post('translate-draft')
  @ApiOperation({ summary: 'Translate operator draft into customer language' })
  translateDraft(@Body() body: { text: string; targetLanguage?: string }, @CurrentUser() user: any) {
    return this.aiService.translateDraft(body.text, user, body?.targetLanguage || 'en');
  }

  /** Legacy alias for translate-draft (backward compatibility) */
  @Post('cn-to-en-draft')
  @ApiOperation({ summary: 'Translate Chinese input to English draft (legacy alias)' })
  translateCnToEn(@Body() body: { text: string; targetLanguage?: string }, @CurrentUser() user: any) {
    return this.aiService.translateDraft(body.text, user, body?.targetLanguage || 'en');
  }

  @Post('generate-follow-up')
  @ApiOperation({ summary: 'Generate follow-up record from conversation' })
  generateFollowUp(@Body() body: { conversationId: string }, @CurrentUser() user: any) {
    return this.aiService.generateFollowUpRecord(body.conversationId, user);
  }

  @Post('generate-reply')
  @ApiOperation({ summary: 'Generate reply suggestions from raw chat context (used by WhatsApp integration)' })
  generateReply(@Body() body: { context: string; targetLanguage?: string }, @CurrentUser() user: any) {
    return this.aiService.generateReplyFromContext(body.context, user, body?.targetLanguage || 'en');
  }

  @Post('customer-analysis/:leadId')
  @ApiOperation({ summary: 'Generate AI customer background analysis' })
  customerAnalysis(@Param('leadId') leadId: string, @CurrentUser() user: any) {
    return this.aiService.generateCustomerAnalysis(leadId, user);
  }

  @Get('diagnose')
  @Roles('super_admin')
  @ApiOperation({ summary: 'Run system diagnostic (read-only)' })
  diagnose() {
    if (!aiDiagnosticsEnabled()) {
      // Do not advertise an operational endpoint unless an administrator explicitly enables it.
      throw new NotFoundException('AI diagnostics are disabled');
    }
    return buildAiDiagnosticSnapshot();
  }

  @Patch('artifacts/:id')
  @ApiOperation({ summary: 'Accept or reject an AI artifact' })
  updateStatus(
    @Param('id') id: string,
    @Body() body: { status: string; modifiedOutput?: string },
    @CurrentUser() user: any,
  ) {
    return this.aiService.updateArtifactStatus(id, body.status, user, body.modifiedOutput);
  }
}
