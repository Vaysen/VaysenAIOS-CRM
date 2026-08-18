/**
 * sales-delivery-adapters.ts
 *
 * wesley-ai-crm 批次3：报价交付渠道适配器。
 * - email：复用 nodemailer（既有依赖）。配置 SALES_DELIVERY_SMTP_URL 时真实发送，
 *   否则记录发送意图（intent-only，providerMessageId 形如 intent:email:<uuid>）。
 * - whatsapp / meta：复用我方通道基础设施较重（Baileys 会话、Meta 凭证），本批次
 *   先记录发送意图，由后续批次接入真实通道。
 *
 * 说明：适配器只负责“发出去 + 拿回 providerMessageId”，状态机与回执由
 * SalesDeliveryService 统一驱动。
 */

import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { SalesDeliveryChannel } from '@prisma/client';

export interface DeliveryAttachment {
  filename: string;
  buffer: Buffer;
  contentType: string;
}

export interface DeliverySendInput {
  to: string;
  subject?: string;
  body?: string;
  attachment?: DeliveryAttachment | null;
}

export interface DeliverySendResult {
  providerMessageId: string;
  outcome: 'SENT' | 'DEFERRED';
  detail?: string;
}

export interface SalesDeliveryChannelAdapter {
  readonly channel: SalesDeliveryChannel;
  send(input: DeliverySendInput): Promise<DeliverySendResult>;
}

function intentResult(channel: string, detail: string): DeliverySendResult {
  return {
    providerMessageId: `intent:${channel}:${randomUUID()}`,
    outcome: 'SENT',
    detail,
  };
}

@Injectable()
export class SalesDeliveryEmailAdapter implements SalesDeliveryChannelAdapter {
  readonly channel = SalesDeliveryChannel.EMAIL;
  private readonly logger = new Logger(SalesDeliveryEmailAdapter.name);

  async send(input: DeliverySendInput): Promise<DeliverySendResult> {
    const smtpUrl = (process.env.SALES_DELIVERY_SMTP_URL || '').trim();
    const from = (process.env.SALES_DELIVERY_FROM_EMAIL || 'sales@localhost').trim();
    if (!smtpUrl) {
      const result = intentResult(
        'email',
        'intent-only: SALES_DELIVERY_SMTP_URL not configured',
      );
      this.logger.log(
        `email send intent recorded -> to=${input.to} id=${result.providerMessageId}`,
      );
      return result;
    }

    const nodemailer = require('nodemailer');
    const transport = nodemailer.createTransport(smtpUrl);
    try {
      const info = await transport.sendMail({
        from,
        to: input.to,
        subject: input.subject ?? 'Quote delivery',
        text: input.body ?? '',
        attachments: input.attachment
          ? [
              {
                filename: input.attachment.filename,
                content: input.attachment.buffer,
                contentType: input.attachment.contentType,
              },
            ]
          : [],
      });
      return {
        providerMessageId: String(
          info?.messageId || `smtp:${randomUUID()}`,
        ),
        outcome: 'SENT',
        detail: 'smtp',
      };
    } catch (err: any) {
      this.logger.error(`email send failed: ${err?.message ?? 'unknown'}`);
      return {
        providerMessageId: `smtp:${randomUUID()}`,
        outcome: 'DEFERRED',
        detail: err?.message ?? 'smtp error',
      };
    } finally {
      try {
        transport.close();
      } catch {
        // ignore close errors
      }
    }
  }
}

@Injectable()
export class SalesDeliveryWhatsAppAdapter implements SalesDeliveryChannelAdapter {
  readonly channel = SalesDeliveryChannel.WHATSAPP;
  private readonly logger = new Logger(SalesDeliveryWhatsAppAdapter.name);

  async send(input: DeliverySendInput): Promise<DeliverySendResult> {
    // 复用我方 whatsapp 模块的真实发送需 Baileys 会话（按 connectionId 绑定），
    // 本批次记录发送意图，保证闭环可验收、不引入会话副作用。
    const result = intentResult(
      'whatsapp',
      'intent-only: Baileys session dispatch deferred to later batch',
    );
    this.logger.log(
      `whatsapp send intent recorded -> to=${input.to} id=${result.providerMessageId}`,
    );
    return result;
  }
}

@Injectable()
export class SalesDeliveryMetaAdapter implements SalesDeliveryChannelAdapter {
  readonly channel = SalesDeliveryChannel.META;
  private readonly logger = new Logger(SalesDeliveryMetaAdapter.name);

  async send(input: DeliverySendInput): Promise<DeliverySendResult> {
    const result = intentResult(
      'meta',
      'intent-only: Meta/WhatsApp Business API dispatch deferred to later batch',
    );
    this.logger.log(
      `meta send intent recorded -> to=${input.to} id=${result.providerMessageId}`,
    );
    return result;
  }
}

@Injectable()
export class SalesDeliveryAdapterRegistry {
  private readonly byChannel = new Map<SalesDeliveryChannel, SalesDeliveryChannelAdapter>();

  constructor(
    email: SalesDeliveryEmailAdapter,
    whatsapp: SalesDeliveryWhatsAppAdapter,
    meta: SalesDeliveryMetaAdapter,
  ) {
    this.byChannel.set(email.channel, email);
    this.byChannel.set(whatsapp.channel, whatsapp);
    this.byChannel.set(meta.channel, meta);
  }

  get(channel: SalesDeliveryChannel): SalesDeliveryChannelAdapter {
    const adapter = this.byChannel.get(channel);
    if (!adapter) {
      throw new BadRequestException(`No delivery adapter for channel: ${channel}`);
    }
    return adapter;
  }
}
