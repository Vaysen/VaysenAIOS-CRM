import {
  Controller,
  Post,
  Get,
  Delete,
  Patch,
  Body,
  Param,
  Query,
  Headers,
  UseGuards,
  Res,
  Sse,
  Req,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Response } from 'express';
import { Observable, interval } from 'rxjs';
import { Public } from '../../common/decorators/public.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { WhatsAppService } from './whatsapp.service';
import { WebsiteWhatsAppClickDto } from './dto/website-click.dto';
import {
  assertFixedWindowRateLimit,
  envLimit,
  getRequestIp,
} from '../../common/security/request-security';

@ApiTags('WhatsApp')
@Controller('whatsapp')
export class WhatsAppController {
  constructor(private readonly whatsappService: WhatsAppService) {}

  @Public()
  @Post('click')
  @ApiOperation({ summary: 'Record WhatsApp click from website' })
  recordClick(@Body() body: WebsiteWhatsAppClickDto, @Req() req: any) {
    const limit = envLimit('WHATSAPP_CLICK_RATE_LIMIT', 30, 1, 1000);
    assertFixedWindowRateLimit(
      'whatsapp.click.ip',
      getRequestIp(req),
      limit,
      15 * 60 * 1000,
    );
    assertFixedWindowRateLimit(
      'whatsapp.click.source',
      body.sourceKey,
      limit * 5,
      15 * 60 * 1000,
    );
    return this.whatsappService.recordClick(
      body,
      String(req?.headers?.origin || ''),
    );
  }

  @Get('accounts')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'List WhatsApp accounts' })
  listAccounts(@CurrentUser() user: any) {
    return this.whatsappService.listAccounts(user);
  }

  @Patch('accounts/:id')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Edit WhatsApp account name / risk-control limits (admin)' })
  updateAccount(
    @Param('id') id: string,
    @Body() body: {
      name?: string;
      phone?: string;
      sendLimitPerHour?: number;
      sendLimitDaily?: number;
      sendIntervalSeconds?: number;
    },
    @CurrentUser() user: any,
  ) {
    return this.whatsappService.updateAccount(id, body, user);
  }

  @Post('accounts')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Add WhatsApp account and init QR session' })
  addAccount(@Body() body: { name: string; phone?: string }, @CurrentUser() user: any) {
    return this.whatsappService.createAccount(body, user);
  }

  @Get('accounts/:id/qr')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Get current QR code for account' })
  getQrCode(@Param('id') id: string, @CurrentUser() user: any) {
    return this.whatsappService.getQrCode(id, user);
  }

  @Get('accounts/:id/status')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Get connection status' })
  getStatus(@Param('id') id: string, @CurrentUser() user: any) {
    return this.whatsappService.getStatus(id, user);
  }

  @Post('accounts/:id/reconnect')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Reconnect WhatsApp account (generate new QR)' })
  reconnect(@Param('id') id: string, @CurrentUser() user: any) {
    return this.whatsappService.reconnect(id, user);
  }

  @Post('accounts/:id/disconnect')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Disconnect WhatsApp account' })
  disconnect(@Param('id') id: string, @CurrentUser() user: any) {
    return this.whatsappService.disconnect(id, user);
  }

  @Delete('accounts/:id')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Remove WhatsApp account' })
  removeAccount(@Param('id') id: string, @CurrentUser() user: any) {
    return this.whatsappService.removeAccount(id, user);
  }

  @Post('accounts/:id/send')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Send WhatsApp message' })
  sendMessage(
    @Param('id') id: string,
    @Body() body: { to: string; text: string; leadId: string; conversationId: string },
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentUser() user: any,
  ) {
    return this.whatsappService.sendMessage(id, body, user, {
      idempotencyKey: idempotencyKey || '',
      leadId: body.leadId,
      conversationId: body.conversationId,
    });
  }

  /**
   * SSE 端点 — 实时推送 QR 码更新和连接状态
   * 前端通过 EventSource 订阅此端点
   */
  @Sse('accounts/:id/stream')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'SSE stream for QR updates and connection status' })
  streamUpdates(@Param('id') id: string, @CurrentUser() user: any): Observable<any> {
    return new Observable((subscriber) => {
      // 每 2 秒轮询数据库状态作为 SSE 推送
      const pollInterval = interval(2000);
      const subscription = pollInterval.subscribe(async () => {
        try {
          const status = await this.whatsappService.getStatus(id, user);
          const qr = await this.whatsappService.getQrCode(id, user);
          subscriber.next({
            data: JSON.stringify({
              status: status.status,
              qrCode: qr.qrCode,
              phoneNumber: status.phoneNumber,
              timestamp: new Date().toISOString(),
            }),
          });

          // 如果已连接，关闭 SSE
          if (status.status === 'connected') {
            subscriber.complete();
            subscription.unsubscribe();
          }
        } catch (err) {
          subscriber.error(err);
        }
      });

      // 清理
      return () => subscription.unsubscribe();
    });
  }

  // ========== 客户头像 ==========

  @Get('conversations/:conversationId/avatar')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Get customer WhatsApp avatar' })
  getCustomerAvatar(
    @Param('conversationId') conversationId: string,
    @CurrentUser() user: any,
  ) {
    return this.whatsappService.getCustomerAvatar(conversationId, user);
  }

  // ========== Evolution API 路由 ==========

  @Post('evolution/accounts')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Create Evolution API WhatsApp instance' })
  createEvolutionAccount(
    @Body() body: { name: string; phone?: string },
    @CurrentUser() user: any,
  ) {
    return this.whatsappService.createEvolutionInstance(body, user);
  }

  @Get('evolution/accounts/:id/qr')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Get Evolution instance QR code' })
  getEvolutionQr(
    @Param('id') id: string,
    @CurrentUser() user: any,
  ) {
    return this.whatsappService.getEvolutionQrCode(id, user);
  }

  @Post('evolution/accounts/:id/send-text')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Send text via Evolution API' })
  sendEvolutionText(
    @Param('id') id: string,
    @Body() body: { to: string; text: string; leadId: string; conversationId: string },
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentUser() user: any,
  ) {
    return this.whatsappService.sendEvolutionText(id, body.to, body.text, user, {
      idempotencyKey: idempotencyKey || '',
      leadId: body.leadId,
      conversationId: body.conversationId,
    });
  }

  @Post('evolution/accounts/:id/send-media')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Send media via Evolution API' })
  sendEvolutionMedia(
    @Param('id') id: string,
    @Body() body: {
      to: string;
      type: 'image' | 'document' | 'video' | 'audio';
      base64?: string;
      url?: string;
      filename?: string;
      caption?: string;
      mimeType?: string;
      leadId: string;
      conversationId: string;
    },
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @CurrentUser() user: any,
  ) {
    return this.whatsappService.sendEvolutionMedia(id, body.to, body, user, {
      idempotencyKey: idempotencyKey || '',
      leadId: body.leadId,
      conversationId: body.conversationId,
    });
  }

  @Post('evolution/accounts/:id/disconnect')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard)
  @ApiOperation({ summary: 'Disconnect Evolution instance' })
  disconnectEvolution(
    @Param('id') id: string,
    @CurrentUser() user: any,
  ) {
    return this.whatsappService.disconnectEvolution(id, user);
  }
}
