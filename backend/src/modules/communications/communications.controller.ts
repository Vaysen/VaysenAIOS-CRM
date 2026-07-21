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
import { RealtimeEventBus } from '../../common/realtime/realtime-event-bus';
import { getAccessibleCompanyIds } from '../../common/utils/data-isolation';
import { Observable } from 'rxjs';
import { Response } from 'express';
import { Logger } from '@nestjs/common';
import {
  createCommunicationUploadFilename,
  ensureUploadsRoot,
  validateCommunicationUpload,
} from './attachment-security';
import { CustomerMergeService } from '../customer-identity/customer-merge.service';
import { MergeLeadsDto } from './dto/merge-leads.dto';

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
  findConversation(@Param('id') id: string, @CurrentUser() user: any) {
    return this.communicationsService.findConversation(id, user);
  }

  @Post('conversations')
  @ApiOperation({ summary: 'Create a conversation (WhatsApp auto-archiving etc.)' })
  createConversation(
    @Body() body: { channel?: string; leadId?: string; contactPhone?: string; subject?: string; status?: string },
    @CurrentUser() user: any,
  ) {
    return this.communicationsService.createConversation(body, user);
  }

  @Public()
  @Post('website-inquiries')
  @ApiOperation({ summary: 'Create a website inquiry (public endpoint — no auth)' })
  createWebsiteInquiry(@Body() dto: CreateWebsiteInquiryDto) {
    return this.communicationsService.createWebsiteInquiry(dto);
  }

  @Post('conversations/:id/messages')
  @ApiOperation({ summary: 'Add a message to a conversation' })
  addMessage(
    @Param('id') id: string,
    @Body() dto: CreateMessageDto,
    @CurrentUser() user: any,
  ) {
    return this.communicationsService.addMessage(id, dto, user);
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
          cb(null, ensureUploadsRoot());
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
  uploadAttachment(@UploadedFile() file: Express.Multer.File) {
    return this.communicationsService.uploadAttachment(file);
  }

  /**
   * SSE 实时推送端点 — 前端通过 EventSource 连接
   * 推送 WhatsApp 新消息、会话更新等事件
   */
  @Sse('events')
  sseEvents(@CurrentUser() user: any): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      // 使用统一工具函数获取用户可访问的公司 ID 列表
      // 修复：之前使用 user.companyId（不存在），导致所有 SSE 事件被过滤掉
      const userCompanyIds = getAccessibleCompanyIds(user);
      this.logger.log(
        `SSE connected — user: ${user.email}, companyIds: ${JSON.stringify(userCompanyIds)}`,
      );

      // 发送初始连接确认
      subscriber.next({
        type: 'connected',
        data: { status: 'connected', timestamp: new Date().toISOString() },
      } as any);

      // 监听 WhatsApp 新消息事件
      const cleanupWhatsApp = this.eventBus.on('whatsapp.message', (payload: any) => {
        const matched = payload.companyId && userCompanyIds.includes(payload.companyId);
        this.logger.debug(
          `SSE whatsapp.message — companyId: ${payload.companyId}, matched: ${matched}`,
        );
        if (matched) {
          subscriber.next({
            type: 'whatsapp.message',
            data: payload,
          } as any);
        }
      });

      // 监听会话更新事件
      const cleanupConv = this.eventBus.on('conversation.update', (payload: any) => {
        const matched = payload.companyId && userCompanyIds.includes(payload.companyId);
        if (matched) {
          subscriber.next({
            type: 'conversation.update',
            data: payload,
          } as any);
        }
      });

      // 心跳 — 每 30 秒发送一次，保持连接
      const heartbeat = setInterval(() => {
        subscriber.next({
          type: 'heartbeat',
          data: { timestamp: new Date().toISOString() },
        } as any);
      }, 30000);

      // 清理
      return () => {
        this.logger.log(`SSE disconnected — user: ${user.email}`);
        cleanupWhatsApp();
        cleanupConv();
        clearInterval(heartbeat);
      };
    });
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
