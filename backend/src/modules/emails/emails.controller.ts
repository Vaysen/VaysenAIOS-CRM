import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  Headers,
  UseGuards,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiHeader,
  ApiQuery,
  ApiResponse,
} from '@nestjs/swagger';
import { EmailsService } from './emails.service';
import { SendSingleDto } from './dto/send-single.dto';
import { SendBatchDto } from './dto/send-batch.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { normalizeIdempotencyKey } from '../../common/security/idempotency-key';

@ApiTags('Email Sending')
@ApiBearerAuth()
@UseGuards(AuthGuard('jwt'))
@Controller('emails')
export class EmailsController {
  constructor(private readonly emailsService: EmailsService) {}

  @Post('send-single')
  @ApiOperation({ summary: 'Send email to a single lead' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Canonical 8-200 character key. Replays are re-authorized against current access.',
    schema: {
      type: 'string',
      minLength: 8,
      maxLength: 200,
      pattern: '^[A-Za-z0-9][A-Za-z0-9._:/-]{7,199}$',
    },
  })
  @ApiResponse({ status: 201, description: 'Email queued or skipped' })
  @ApiResponse({
    status: 400,
    description: 'Idempotency-Key is missing or malformed',
    schema: {
      example: {
        statusCode: 400,
        message: 'A canonical Idempotency-Key is required',
        error: 'Bad Request',
      },
    },
  })
  @ApiResponse({
    status: 409,
    description: 'Idempotency-Key payload conflict',
    schema: {
      example: {
        statusCode: 409,
        code: 'EMAIL_IDEMPOTENCY_PAYLOAD_CONFLICT',
        message: 'Idempotency-Key was already used with a different email request',
      },
    },
  })
  sendSingle(
    @Body() dto: SendSingleDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentUser() user: any,
  ) {
    return this.emailsService.sendSingle(
      dto,
      user,
      normalizeIdempotencyKey(idempotencyKey),
    );
  }

  @Post('send-batch')
  @ApiOperation({ summary: 'Send email to multiple leads' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'Canonical 8-200 character key. Replays are re-authorized against current access.',
    schema: {
      type: 'string',
      minLength: 8,
      maxLength: 200,
      pattern: '^[A-Za-z0-9][A-Za-z0-9._:/-]{7,199}$',
    },
  })
  @ApiResponse({ status: 201, description: 'Batch send results' })
  @ApiResponse({
    status: 400,
    description: 'Idempotency-Key is missing or malformed',
    schema: {
      example: {
        statusCode: 400,
        message: 'A canonical Idempotency-Key is required',
        error: 'Bad Request',
      },
    },
  })
  @ApiResponse({
    status: 409,
    description: 'Idempotency-Key payload conflict',
    schema: {
      example: {
        statusCode: 409,
        code: 'EMAIL_IDEMPOTENCY_PAYLOAD_CONFLICT',
        message: 'Idempotency-Key was already used with a different email request',
      },
    },
  })
  sendBatch(
    @Body() dto: SendBatchDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentUser() user: any,
  ) {
    return this.emailsService.sendBatch(
      dto,
      user,
      normalizeIdempotencyKey(idempotencyKey),
    );
  }

  @Get('queue-status')
  @ApiOperation({ summary: 'Get email sending queue status' })
  async getQueueStatus(@CurrentUser() user: any) {
    return this.emailsService.getQueueStatus(user);
  }

  @Get('team-stats')
  @ApiOperation({ summary: 'Get per-user email stats for admin dashboard' })
  async getTeamStats(@CurrentUser() user: any) {
    return this.emailsService.getTeamStats(user);
  }

  @Post('ai-draft')
  @ApiOperation({ summary: 'Generate an AI-personalized email draft for a lead' })
  generateAiDraft(
    @Body() dto: { leadId: string; emailAccountId?: string; emailTemplateId?: string; productName?: string },
    @CurrentUser() user: any,
  ) {
    return this.emailsService.generateAiDraft(dto, user);
  }

  @Get()
  @ApiOperation({ summary: 'List email messages' })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiQuery({ name: 'status', required: false, description: 'Filter by status' })
  @ApiQuery({ name: 'leadId', required: false, description: 'Filter by lead' })
  @ApiQuery({ name: 'emailAccountId', required: false, description: 'Filter by email account' })
  @ApiQuery({ name: 'senderUserId', required: false, description: 'Filter by sender' })
  @ApiQuery({ name: 'dateFrom', required: false, description: 'Filter from date (ISO)' })
  @ApiQuery({ name: 'dateTo', required: false, description: 'Filter to date (ISO)' })
  findAll(
    @CurrentUser() user: any,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('status') status?: string,
    @Query('leadId') leadId?: string,
    @Query('emailAccountId') emailAccountId?: string,
    @Query('senderUserId') senderUserId?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ) {
    return this.emailsService.findAll(user, {
      page, limit, status, leadId, emailAccountId, senderUserId, dateFrom, dateTo,
    });
  }

  @Get('by-lead/:leadId')
  @ApiOperation({ summary: 'Get emails for a specific lead' })
  findByLead(@Param('leadId') leadId: string, @CurrentUser() user: any) {
    return this.emailsService.findByLead(leadId, user);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get email message detail' })
  findOne(@Param('id') id: string, @CurrentUser() user: any) {
    return this.emailsService.findOne(id, user);
  }

  @Post(':id/resend')
  @ApiOperation({ summary: 'Resend a failed email' })
  resend(@Param('id') id: string, @CurrentUser() user: any) {
    return this.emailsService.resend(id, user);
  }
}
