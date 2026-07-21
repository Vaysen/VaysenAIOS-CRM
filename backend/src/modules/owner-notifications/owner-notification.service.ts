import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  OWNER_INBOUND_EVENT_TYPES,
  OwnerInboundEventType,
} from './owner-notification.types';

const DEFAULT_TTL_MS = 24 * 60 * 60_000;
const MAX_TTL_MS = 7 * 24 * 60 * 60_000;
const MAX_PREVIEW_LENGTH = 180;
const MAX_SUBJECT_LENGTH = 100;

export interface EnqueueOwnerInboundNotification {
  companyId: string;
  eventType: OwnerInboundEventType;
  sourceMessageKey: string;
  sourceType: string;
  sourceId?: string | null;
  conversationId?: string | null;
  leadId?: string | null;
  subject?: string | null;
  preview?: string | null;
  expiresAt?: Date;
  maxAttempts?: number;
}
@Injectable()
export class OwnerNotificationService {
  constructor(private readonly prisma: PrismaService) {}

  async enqueueInbound(input: EnqueueOwnerInboundNotification) {
    this.assertInboundEvent(input.eventType);
    const companyId = this.requireValue(input.companyId, 'companyId', 128);
    const sourceMessageKey = this.requireValue(input.sourceMessageKey, 'sourceMessageKey', 1_000);
    const sourceType = this.requireValue(input.sourceType, 'sourceType', 80);
    const now = new Date();
    const requestedExpiry = input.expiresAt?.getTime() || now.getTime() + DEFAULT_TTL_MS;
    const expiryMs = Math.min(requestedExpiry, now.getTime() + MAX_TTL_MS);
    if (!Number.isFinite(expiryMs) || expiryMs <= now.getTime()) {
      throw new Error('Owner notification expiresAt must be in the future');
    }

    const eventKey = createHash('sha256')
      .update(JSON.stringify([companyId, input.eventType, sourceMessageKey]))
      .digest('hex');
    const data = {
      companyId,
      eventKey,
      eventType: input.eventType,
      destination: 'OWNER_WECHAT',
      sourceType,
      sourceId: this.optionalInternalReference(input.sourceId),
      conversationId: this.optionalInternalReference(input.conversationId),
      leadId: this.optionalInternalReference(input.leadId),
      subject: input.subject
        ? redactOwnerNotificationText(input.subject, MAX_SUBJECT_LENGTH)
        : null,
      preview: redactOwnerNotificationText(input.preview || '[无文本内容]', MAX_PREVIEW_LENGTH),
      status: 'PENDING' as const,
      attempts: 0,
      maxAttempts: Math.max(1, Math.min(10, Math.trunc(input.maxAttempts || 5))),
      nextAttemptAt: now,
      expiresAt: new Date(expiryMs),
    };

    try {
      const record = await this.prisma.ownerNotificationOutbox.create({ data });
      return { created: true, record };
    } catch (error: any) {
      if (error?.code !== 'P2002') throw error;
      const record = await this.prisma.ownerNotificationOutbox.findUnique({ where: { eventKey } });
      if (!record) throw error;
      return { created: false, record };
    }
  }

  private assertInboundEvent(eventType: string): asserts eventType is OwnerInboundEventType {
    if (!(OWNER_INBOUND_EVENT_TYPES as readonly string[]).includes(eventType)) {
      throw new Error(`Owner notification rejects non-inbound event type: ${eventType}`);
    }
  }

  private requireValue(value: string, field: string, maxLength: number) {
    const normalized = String(value || '').trim();
    if (!normalized) throw new Error(`Owner notification ${field} is required`);
    if (normalized.length > maxLength) throw new Error(`Owner notification ${field} is too long`);
    return normalized;
  }

  private optionalInternalReference(value?: string | null) {
    const normalized = String(value || '').trim();
    if (!normalized) return null;
    if (normalized.length > 128 || !/^[a-zA-Z0-9:_-]+$/.test(normalized)) {
      throw new Error('Owner notification contains an invalid internal reference');
    }
    return normalized;
  }
}
export function redactOwnerNotificationText(value: string, maxLength = MAX_PREVIEW_LENGTH) {
  const compact = String(value || '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/https?:\/\/\S+/gi, '[链接]')
    .replace(/([\w.+-])[\w.+-]*(@[\w.-]+\.[a-z]{2,})/gi, '$1***$2')
    .replace(/(?:\+?\d[\d\s().-]{5,}\d)/g, (candidate) => {
      const digits = candidate.replace(/\D/g, '');
      if (digits.length < 7) return candidate;
      return `${digits.slice(0, 3)}****${digits.slice(-2)}`;
    })
    .replace(/\b(api[_ -]?key|password|secret|token)\s*[:=]\s*\S+/gi, '$1=[已脱敏]')
    .replace(/\s+/g, ' ')
    .trim();
  const fallback = compact || '[无文本内容]';
  return fallback.length <= maxLength ? fallback : `${fallback.slice(0, maxLength - 1)}…`;
}
