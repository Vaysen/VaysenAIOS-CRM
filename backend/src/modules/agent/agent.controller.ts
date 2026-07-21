import { Body, Controller, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AgentService } from './agent.service';
import { CreateAgentRunDto } from './dto/create-agent-run.dto';
import { AssistantChatDto } from './dto/assistant-chat.dto';
import { PendingAssistantActionsQueryDto } from './dto/pending-assistant-actions.dto';
import {
  AssistantActionClaimTokenDto,
  ReleaseAssistantActionClaimDto,
} from './dto/assistant-action-claim.dto';
import { AssistantPermissionService } from './assistant-permission.service';
import {
  CreateAssistantTemporaryGrantDto,
  UpdateAssistantPermissionProfileDto,
} from './dto/assistant-permission.dto';
import { AssistantExternalActionService } from './assistant-external-action.service';
import {
  AuthorizeWhatsappTextSendDto,
  CompleteWhatsappTextSendDto,
} from './dto/assistant-external-action.dto';

@ApiTags('AI Business Assistant')
@ApiBearerAuth()
@Controller('agent-runs')
export class AgentController {
  constructor(
    private readonly service: AgentService,
    private readonly permissions: AssistantPermissionService,
    private readonly externalActions: AssistantExternalActionService,
  ) {}

  @Post()
  @ApiOperation({ summary: 'Run an allowlisted read-only or draft-only assistant tool' })
  create(@Body() dto: CreateAgentRunDto, @CurrentUser() user: any) {
    return this.service.create(dto, user);
  }

  @Get()
  list(@Query('companyId') companyId: string, @CurrentUser() user: any) {
    return this.service.list(companyId, user);
  }

  @Get('assistant/brief')
  @ApiOperation({ summary: 'Read the current operator assistant work brief' })
  brief(@Query('companyId') companyId: string, @CurrentUser() user: any) {
    return this.service.getBrief(companyId, user);
  }

  @Get('assistant/chat')
  @ApiOperation({ summary: 'Read the current operator assistant conversation' })
  chatHistory(
    @Query('companyId') companyId: string,
    @Query('threadId') threadId: string,
    @CurrentUser() user: any,
  ) {
    return this.service.getChatHistory(companyId, threadId, user);
  }

  @Post('assistant/chat')
  @ApiOperation({ summary: 'Chat with the assistant and propose human-confirmed quote preparation' })
  chat(@Body() dto: AssistantChatDto, @CurrentUser() user: any) {
    return this.service.chat(dto, user);
  }

  @Get('assistant/pending-actions')
  @ApiOperation({ summary: 'List unexpired quote proposals the current operator may confirm' })
  pendingAssistantActions(
    @Query() query: PendingAssistantActionsQueryDto,
    @CurrentUser() user: any,
  ) {
    return this.service.getPendingAssistantActions(query.companyId, user);
  }

  @Get('assistant/permissions')
  @ApiOperation({ summary: 'Read the effective assistant capability policy for the active company' })
  assistantPermissions(@Query('companyId') companyId: string, @CurrentUser() user: any) {
    return this.permissions.getProfile(companyId, user);
  }

  @Patch('assistant/permissions')
  @ApiOperation({ summary: 'Company administrator updates the assistant permission preset and overrides' })
  updateAssistantPermissions(
    @Body() dto: UpdateAssistantPermissionProfileDto,
    @CurrentUser() user: any,
  ) {
    return this.permissions.updateProfile(dto, user);
  }

  @Get('assistant/grants')
  @ApiOperation({ summary: 'List visible temporary assistant execution grants' })
  assistantGrants(@Query('companyId') companyId: string, @CurrentUser() user: any) {
    return this.permissions.listTemporaryGrants(companyId, user);
  }

  @Post('assistant/grants')
  @ApiOperation({ summary: 'Company administrator creates a scoped temporary execution grant' })
  createAssistantGrant(
    @Body() dto: CreateAssistantTemporaryGrantDto,
    @CurrentUser() user: any,
  ) {
    return this.permissions.createTemporaryGrant(dto, user);
  }

  @Post('assistant/grants/:id/revoke')
  @ApiOperation({ summary: 'Company administrator revokes a temporary execution grant' })
  revokeAssistantGrant(@Param('id') id: string, @CurrentUser() user: any) {
    return this.permissions.revokeTemporaryGrant(id, user);
  }

  @Post('assistant/external-actions/whatsapp-text/authorize')
  @ApiOperation({ summary: 'Create and atomically consume one exact, short-lived WhatsApp send grant' })
  authorizeWhatsappTextSend(
    @Body() dto: AuthorizeWhatsappTextSendDto,
    @CurrentUser() user: any,
  ) {
    return this.externalActions.authorizeWhatsappTextSend(dto, user);
  }

  @Post('assistant/external-actions/whatsapp-text/:id/complete')
  @ApiOperation({ summary: 'Record the terminal desktop result of a claimed WhatsApp text send' })
  completeWhatsappTextSend(
    @Param('id') id: string,
    @Body() dto: CompleteWhatsappTextSendDto,
    @CurrentUser() user: any,
  ) {
    return this.externalActions.completeWhatsappTextSend(id, dto, user);
  }

  @Post('assistant/actions/:id/confirm')
  @ApiOperation({ summary: 'Atomically claim a deterministic quote preparation proposal' })
  confirmAssistantAction(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.confirmAssistantAction(id, user);
  }

  @Post('assistant/actions/:id/complete')
  @ApiOperation({ summary: 'Accept a quote proposal only after the desktop prepared its PDF' })
  completeAssistantAction(
    @Param('id') id: string,
    @Body() dto: AssistantActionClaimTokenDto,
    @CurrentUser() user: any,
  ) {
    return this.service.completeAssistantAction(id, dto.claimToken, user);
  }

  @Post('assistant/actions/:id/release')
  @ApiOperation({ summary: 'Release a failed quote preparation claim for a safe retry' })
  releaseAssistantAction(
    @Param('id') id: string,
    @Body() dto: ReleaseAssistantActionClaimDto,
    @CurrentUser() user: any,
  ) {
    return this.service.releaseAssistantAction(id, dto.claimToken, dto.failureCode, user);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.findOne(id, user);
  }

  @Post(':id/cancel')
  cancel(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.cancel(id, user);
  }

  @Post('authorizations/:id/confirm')
  @ApiOperation({ summary: 'Company administrator confirms an unexpired high-risk authorization' })
  confirmAuthorization(@Param('id') id: string, @CurrentUser() user: any) {
    return this.service.confirmAuthorization(id, user);
  }
}
