export const OWNER_NOTIFICATION_SENDER = Symbol('OWNER_NOTIFICATION_SENDER');

export const OWNER_INBOUND_EVENT_TYPES = [
  'WHATSAPP_INBOUND',
  'EMAIL_INBOUND',
] as const;

export type OwnerInboundEventType = (typeof OWNER_INBOUND_EVENT_TYPES)[number];

export interface OwnerNotificationDelivery {
  id: string;
  companyId: string;
  eventType: OwnerInboundEventType;
  destination: 'OWNER_WECHAT';
  subject: string | null;
  preview: string;
  sourceType: string;
  sourceId: string | null;
  conversationId: string | null;
  leadId: string | null;
}
export interface OwnerNotificationDeliveryReceipt {
  provider: string;
  receiptId: string;
}
/**
 * The concrete WeChat adapter owns credentials and the raw owner peer. The
 * outbox gives it only tenant-scoped, redacted business data.
 */
export interface OwnerNotificationSender {
  send(notification: OwnerNotificationDelivery): Promise<OwnerNotificationDeliveryReceipt>;
}
