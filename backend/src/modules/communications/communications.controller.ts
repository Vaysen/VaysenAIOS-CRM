import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Query,
  Body,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  Sse,
  MessageEvent,
  Res,
  Req,
  Headers,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiConsumes } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { Public } from '../../common/decorators/public.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CommunicationsService } from './communications.service';
import { QueryConversationsDto } from './dto/query-conversations.dto';
import { CreateWebsiteInquiryDto } from './dto/create-website-inquiry.dto';
import { CreateMessageDto } from './dto/create-message.dto';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { RealtimeEventBus } from '../../common/realtime/realtime-event-bus';
import { requireActiveCompany } from '../../common/utils/data-isolation';
import { Observable, from, switchMap } from 'rxjs';
import { Response } from 'express';
import { Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import {
  createCommunicationUploadFilename,
  ensureUploadsRoot,
  validateCommunicationUpload,
} from './attachment-security';
import { CustomerMergeService } from '../customer-identity/customer-merge.service';
import { MergeLeadsDto } from './dto/merge-leads.dto';
import {
  assertFixedWindowRateLimit,
  envLimit,
  getRequestIp,
} from '../../common/security/request-security';
import { safeDigest, safeLogEvent } from '../../common/security/safe-logging';

type CommunicationSseDirection = 'inbound' | 'outbound';
type CommunicationSseContentType = 'audio' | 'document' | 'html' | 'image' | 'json' | 'text' | 'video';

export type CommunicationSseMessageEventData = {
  conversationId: string | null;
  messageId: string | null;
  emailId: string | null;
  direction: CommunicationSseDirection | null;
  contentType: CommunicationSseContentType | null;
  updatedAt: string | null;
  timestamp: string;
};

export type CommunicationSseEventDto =
  | { type: 'connected'; data: { status: 'connected'; timestamp: string } }
  | { type: 'heartbeat'; data: { timestamp: string } }
  | {
      type: 'whatsapp.message' | 'email.received' | 'conversation.update';
      data: CommunicationSseMessageEventData;
    };

@ApiTags('Communications')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('communications')
export class CommunicationsController {
  private readonly logger = new Logger(CommunicationsController.name);

  constructor(
    private readonly communicationsService: CommunicationsService,
    private readonly eventBus: RealtimeEventBus,
    private readonly customerMerge: CustomerMergeService,
  ) {}

  @Get('conversations')
  @ApiOperation({ summary: 'List conversations with pagination and filters' })
  findConversations(@Query() query: QueryConversationsDto, @CurrentUser() user: any) {
    return this.communicationsService.findConversations(query, user);
  }

  @Get('conversations/:id')
  @ApiOperation({ summary: 'Get conversation detail with messages and AI artifacts' })
  findConversation(
    @Param('id') id: string,
    @Query() query: QueryConversationsDto,
    @CurrentUser() user: any,
  ) {
    return this.communicationsService.findConversation(id, user, query);
  }

  @Post('conversations')
  @ApiOperation({ summary: 'Create a conversation (WhatsApp auto-archiving etc.)' })
  createConversation(
    @Body() body: CreateConversationDto,
    @CurrentUser() user: any,
  ) {
    return this.communicationsService.createConversation(body, user);
  }

  @Public()
  @Post('website-inquiries')
  @ApiOperation({ summary: 'Create a website inquiry (public endpoint — no auth)' })
  createWebsiteInquiry(@Body() dto: CreateWebsiteInquiryDto, @Req() req: any) {
    const limit = envLimit('WEBSITE_INQUIRY_RATE_LIMIT', 20, 1, 500);
    assertFixedWindowRateLimit(
      'communications.website-inquiry.ip',
      getRequestIp(req),
      limit,
      15 * 60 * 1000,
    );
    return this.communicationsService.createWebsiteInquiry(
      dto,
      String(req?.headers?.origin || ''),
    );
  }

  @Post('conversations/:id/messages')
  @ApiOperation({ summary: 'Add a message to a conversation' })
  addMessage(
    @Param('id') id: string,
    @Body() dto: CreateMessageDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentUser() user: any,
  ) {
    return this.communicationsService.addMessage(
      id,
      { ...dto, idempotencyKey: idempotencyKey || dto.idempotencyKey },
      user,
    );
  }

  @Patch('conversations/:id/status')
  @ApiOperation({ summary: 'Update conversation status (active / archived / closed)' })
  updateStatus(
    @Param('id') id: string,
    @Body('status') status: string,
    @CurrentUser() user: any,
  ) {
    return this.communicationsService.updateConversationStatus(id, status, user);
  }

  @Patch('conversations/:id/read')
  @ApiOperation({ summary: 'Mark all inbound messages in a conversation as read' })
  markRead(@Param('id') id: string, @CurrentUser() user: any) {
    return this.communicationsService.markConversationRead(id, user);
  }

  @Patch('conversations/:id/assign')
  @ApiOperation({ summary: 'Assign or unassign a conversation to a user' })
  assignConversation(
    @Param('id') id: string,
    @Body('assignedUserId') assignedUserId: string | null,
    @CurrentUser() user: any,
  ) {
    return this.communicationsService.assignConversation(id, assignedUserId, user);
  }

  @Post('upload')
  @ApiOperation({ summary: 'Upload an attachment for conversation messages' })
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', {
    limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
    fileFilter: (_req, file, cb) => {
      try {
        validateCommunicationUpload(file);
        cb(null, true);
      } catch (error) {
        cb(error as Error, false);
      }
    },
    storage: diskStorage({
      destination: (req, file, cb) => {
        try {
          const activeCompany = requireActiveCompany((req as any).user);
          if (activeCompany.role === 'viewer') {
            throw new Error('Viewer accounts cannot upload attachments');
          }
          const userId = String((req as any).user?.id || '');
          if (!userId) throw new Error('Authenticated uploader is required');
          assertFixedWindowRateLimit(
            'communications.upload.user',
            `${activeCompany.id}:${userId}`,
            envLimit('COMMUNICATION_UPLOAD_RATE_LIMIT', 10, 1, 100),
            15 * 60 * 1000,
          );
          const root = ensureUploadsRoot();
          const tenantSegment = createHash('sha256')
            .update(activeCompany.id)
            .digest('hex')
            .slice(0, 24);
          const userSegment = createHash('sha256')
            .update(userId)
            .digest('hex')
            .slice(0, 24);
          const scopedDirectory = path.join(
            root,
            'communications',
            tenantSegment,
            userSegment,
          );
          fs.mkdirSync(scopedDirectory, { recursive: true, mode: 0o750 });
          cb(null, scopedDirectory);
        } catch (error) {
          cb(error as Error, '');
        }
      },
      filename: (req, file, cb) => {
        try {
          cb(null, createCommunicationUploadFilename(file));
        } catch (error) {
          cb(error as Error, '');
        }
      },
    }),
  }))
  uploadAttachment(
    @UploadedFile() file: Express.Multer.File,
    @CurrentUser() user: any,
  ) {
    return this.communicationsService.uploadAttachment(file, user);
  }

  /**
   * SSE 实时推送端点 — 前端通过 EventSource 连接
   * 推送 WhatsApp 新消息、会话更新等事件
   */
  @Sse('events')
  sseEvents(@CurrentUser() user: any): Observable<MessageEvent> {
    return from(this.communicationsService.resolveActiveCompanyId(user)).pipe(
      switchMap((activeCompanyId) => new Observable<MessageEvent>((subscriber) => {
      // The database-validated active tenant is the only SSE subscription scope.
      this.logger.log(
        safeLogEvent('communications.sse.connected', {
          eventType: 'connected',
          matched: true,
          userRef: safeDigest(user?.id, 'sse-user'),
          companyRef: safeDigest(activeCompanyId, 'sse-company'),
        }),
      );

      // 发送初始连接确认
      subscriber.next({
        type: 'connected',
        data: { status: 'connected', timestamp: new Date().toISOString() },
      } satisfies CommunicationSseEventDto as any);

      // 监听 WhatsApp 新消息事件
      const cleanupWhatsApp = this.eventBus.on('whatsapp.message', (payload: any) => {
        const matched = payload.companyId === activeCompanyId;
        this.logger.debug(
          safeLogEvent('communications.sse.event', {
            eventType: 'whatsapp.message',
            matched,
            companyRef: safeDigest(payload?.companyId, 'sse-company'),
          }),
        );
        if (matched) {
          subscriber.next({
            type: 'whatsapp.message',
            data: this.projectSseMessageEvent(payload),
          } satisfies CommunicationSseEventDto as any);
        }
      });

      const cleanupEmail = this.eventBus.on('email.received', (payload: any) => {
        const matched = payload.companyId === activeCompanyId;
        this.logger.debug(
          safeLogEvent('communications.sse.event', {
            eventType: 'email.received',
            matched,
            companyRef: safeDigest(payload?.companyId, 'sse-company'),
          }),
        );
        if (matched) {
          subscriber.next({
            type: 'email.received',
            data: this.projectSseMessageEvent(payload),
          } satisfies CommunicationSseEventDto as any);
        }
      });

      // 监听会话更新事件
      const cleanupConv = this.eventBus.on('conversation.update', (payload: any) => {
        const matched = payload.companyId === activeCompanyId;
        if (matched) {
          subscriber.next({
            type: 'conversation.update',
            data: this.projectSseMessageEvent(payload),
          } satisfies CommunicationSseEventDto as any);
        }
      });

      // 心跳 — 每 30 秒发送一次，保持连接
      const heartbeat = setInterval(() => {
        subscriber.next({
          type: 'heartbeat',
          data: { timestamp: new Date().toISOString() },
        } satisfies CommunicationSseEventDto as any);
      }, 30000);

      // 清理
      return () => {
        this.logger.log(
          safeLogEvent('communications.sse.disconnected', {
            eventType: 'disconnected',
            matched: true,
            userRef: safeDigest(user?.id, 'sse-user'),
            companyRef: safeDigest(activeCompanyId, 'sse-company'),
          }),
        );
        cleanupWhatsApp();
        cleanupEmail();
        cleanupConv();
        clearInterval(heartbeat);
      };
      })),
    );
  }

  private projectSseMessageEvent(payload: any): CommunicationSseMessageEventData {
    const timestamp = this.safeSseTimestamp(payload?.timestamp) || new Date().toISOString();
    return {
      conversationId: this.safeSseId(payload?.conversationId),
      messageId: this.safeSseId(payload?.messageId ?? payload?.communicationMessageId),
      emailId: this.safeSseId(payload?.emailId),
      direction: this.safeSseDirection(payload?.direction),
      contentType: this.safeSseContentType(payload?.contentType),
      updatedAt: this.safeSseTimestamp(payload?.updatedAt),
      timestamp,
    };
  }

  private safeSseId(value: unknown): string | null {
    const candidate = String(value ?? '').trim();
    return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(candidate) ? candidate : null;
  }

  private safeSseDirection(value: unknown): CommunicationSseDirection | null {
    return value === 'inbound' || value === 'outbound' ? value : null;
  }

  private safeSseContentType(value: unknown): CommunicationSseContentType | null {
    const candidate = String(value ?? '').trim().toLowerCase();
    const allowed: ReadonlySet<CommunicationSseContentType> = new Set([
      'audio',
      'document',
      'html',
      'image',
      'json',
      'text',
      'video',
    ]);
    return allowed.has(candidate as CommunicationSseContentType)
      ? candidate as CommunicationSseContentType
      : null;
  }

  private safeSseTimestamp(value: unknown): string | null {
    if (value === undefined || value === null || value === '') return null;
    const date = new Date(value as string | number | Date);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  /**
   * 合并两个客户（Lead）— 将源客户的所有数据合并到目标客户
   * 用于处理同一客户被识别为多个 Lead 的情况
   */
  @Post('merge-leads')
  @ApiOperation({ summary: 'Merge source lead into target lead' })
  async mergeLeads(
    @CurrentUser() user: any,
    @Body() body: MergeLeadsDto,
  ) {
    const result = await this.customerMerge.mergeAuthorized({
      companyId: body.companyId,
      candidateId: body.candidateId,
      targetUpdatedAt: body.targetUpdatedAt,
      mode: body.mode,
      fieldChoices: body.fieldChoices,
    }, user);
    return { success: true, ...result };
  }
}
