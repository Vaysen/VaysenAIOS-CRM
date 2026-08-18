/**
 * sales-delivery-webhook.controller.ts
 *
 * 供应商回执端点：POST /api/sales-delivery/provider-webhooks/:provider/:connectionId
 * - @Public()：供应商回调不携带业务 JWT，绕过全局 JwtAuthGuard
 * - HMAC 校验：x-sales-delivery-signature = HMAC-SHA256(rawBody, SALES_DELIVERY_WEBHOOK_SECRET)，
 *   常量时间比对（timingSafeEqual），密钥未配置时 fail-closed（503）
 * - 幂等：receiptKey（payload.receiptKey/messageId/id）由 service 去重
 */

import {
  BadRequestException,
  Controller,
  Headers,
  Param,
  Post,
  RawBodyRequest,
  Req,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Public } from '../../common/decorators/public.decorator';
import { SalesDeliveryService } from './sales-delivery.service';

const MAX_WEBHOOK_BODY_BYTES = 256 * 1024;

@ApiTags('Sales Delivery Webhooks')
@Public()
@Controller('sales-delivery/provider-webhooks')
export class SalesDeliveryWebhookController {
  constructor(private readonly service: SalesDeliveryService) {}

  @Post(':provider/:connectionId')
  @ApiOperation({
    summary: 'Provider delivery receipt webhook (HMAC-signed, idempotent by receiptKey)',
  })
  async receive(
    @Param('provider') provider: string,
    @Param('connectionId') connectionId: string,
    @Headers('x-sales-delivery-signature') signature: string | undefined,
    @Req() req: RawBodyRequest<Request>,
  ) {
    this.assertSignature(signature, req.rawBody);

    let payload: Record<string, any>;
    try {
      payload = JSON.parse((req.rawBody ?? Buffer.from('')).toString('utf8'));
    } catch {
      throw new BadRequestException('Webhook body must be valid JSON');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new BadRequestException('Webhook body must be a JSON object');
    }

    return this.service.recordProviderReceipt(provider, payload, connectionId);
  }

  /** 常量时间 HMAC 校验；密钥缺失或签名不符一律拒绝 */
  private assertSignature(
    signature: string | undefined,
    rawBody: Buffer | undefined,
  ): void {
    const secret = (process.env.SALES_DELIVERY_WEBHOOK_SECRET || '').trim();
    if (!secret) {
      throw new ServiceUnavailableException(
        'Webhook verification is not configured (SALES_DELIVERY_WEBHOOK_SECRET)',
      );
    }
    if (!signature) {
      throw new UnauthorizedException('Missing x-sales-delivery-signature header');
    }
    const body = rawBody ?? Buffer.from('');
    if (body.length > MAX_WEBHOOK_BODY_BYTES) {
      throw new BadRequestException('Webhook body too large');
    }
    const expected = createHmac('sha256', secret).update(body).digest();
    let supplied: Buffer;
    try {
      supplied = Buffer.from(signature, 'hex');
    } catch {
      throw new UnauthorizedException('Invalid webhook signature encoding');
    }
    if (supplied.length !== expected.length || !timingSafeEqual(expected, supplied)) {
      throw new UnauthorizedException('Invalid webhook signature');
    }
  }
}
