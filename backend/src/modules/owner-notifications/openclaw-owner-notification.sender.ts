import { Injectable } from '@nestjs/common';
import { OpenClawBindingStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { OpenClawGatewayClient } from '../openclaw/openclaw-gateway.client';
import {
  OwnerNotificationDelivery,
  OwnerNotificationDeliveryReceipt,
  OwnerNotificationSender,
} from './owner-notification.types';

@Injectable()
export class OpenClawOwnerNotificationSender implements OwnerNotificationSender {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: OpenClawGatewayClient,
  ) {}

  async send(notification: OwnerNotificationDelivery): Promise<OwnerNotificationDeliveryReceipt> {
    const bindings = await this.prisma.openClawOperatorBinding.findMany({
      where: {
        companyId: notification.companyId,
        channel: 'openclaw-weixin',
        status: OpenClawBindingStatus.ACTIVE,
      },
      select: { senderDigest: true },
      orderBy: { boundAt: 'desc' },
      take: 2,
    });
    const ownerDigest = bindings.length === 1 ? bindings[0]?.senderDigest || '' : '';
    if (!/^[a-f0-9]{64}$/.test(ownerDigest)) {
      throw new Error(bindings.length > 1
        ? 'OWNER_WECHAT_BINDING_AMBIGUOUS'
        : 'OWNER_WECHAT_NOT_BOUND');
    }

    const result = await this.gateway.notifyOwner({
      ownerDigest,
      eventKey: notification.id,
      text: this.formatMessage(notification),
    });
    if (!result.success || !result.messageId) {
      throw new Error(`OWNER_WECHAT_${result.reason.toUpperCase()}`);
    }
    return {
      provider: 'openclaw-weixin',
      receiptId: result.messageId,
    };
  }

  private formatMessage(notification: OwnerNotificationDelivery) {
    const channel = notification.eventType === 'WHATSAPP_INBOUND' ? 'WhatsApp' : '邮件';
    const subject = notification.subject ? `\n主题：${notification.subject}` : '';
    return [
      `【Vaysen ${channel}新消息】${subject}`,
      notification.preview,
      '请打开 CRM 查看并处理。',
    ].join('\n');
  }
}
