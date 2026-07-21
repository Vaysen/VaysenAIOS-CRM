import axios from 'axios';
import api from '@/lib/api';

const SERVER_WHATSAPP_STATUSES = new Set([
  'pending_qr',
  'waiting_scan',
  'connected',
  'reconnecting',
  'disconnected',
  'error',
]);

export type ServerWhatsAppStatus =
  | 'pending_qr'
  | 'waiting_scan'
  | 'connected'
  | 'reconnecting'
  | 'disconnected'
  | 'error'
  | 'unknown';

export interface ServerWhatsAppAccount {
  id: string;
  accountName: string;
  phoneNumber: string | null;
  status: ServerWhatsAppStatus;
  connectedAt: string | null;
  lastSeenAt: string | null;
}

export interface ServerWhatsAppQr {
  status: ServerWhatsAppStatus;
  qrDataUrl: string | null;
  expireAt: string | null;
  phoneNumber: string | null;
}

export interface EmailDeliveryReceipt {
  status: 'SUCCEEDED';
  messageId: string;
  accepted: string[];
  response: string | null;
}

export interface MessagingDeliveryFailure {
  status: 'BLOCKED' | 'FAILED';
  code: string;
  message: string;
}

export interface BusinessEmailAccount {
  id: string;
  senderName: string;
  senderEmail: string;
  replyToEmail: string | null;
  status: string;
}

export interface OwnerNotificationStatus {
  available: true;
  enabled: boolean;
  channel: 'openclaw-weixin';
  channelStatus: 'CONNECTED' | 'UNBOUND' | 'OFFLINE' | 'ERROR';
  counts: {
    pending: number;
    sending: number;
    sent: number;
    failed: number;
  };
  lastDelivery: {
    status: 'PENDING' | 'SENDING' | 'SENT' | 'FAILED';
    eventType: string;
    createdAt: string;
    sentAt: string | null;
    errorCode: string | null;
  } | null;
}

export type OwnerNotificationStatusResult =
  | OwnerNotificationStatus
  | { available: false; reason: 'NOT_EXPOSED' | 'UNREACHABLE' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isoOrNull(value: unknown): string | null {
  const text = optionalText(value);
  return text && !Number.isNaN(Date.parse(text)) ? text : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

export function parseServerWhatsAppAccount(value: unknown): ServerWhatsAppAccount {
  if (!isRecord(value)) throw new Error('WhatsApp 账号返回格式无效');
  const id = optionalText(value.id);
  const accountName = optionalText(value.accountName);
  if (!id || !accountName) throw new Error('WhatsApp 账号缺少必要标识');
  const rawStatus = optionalText(value.status)?.toLowerCase() || 'unknown';
  const status = SERVER_WHATSAPP_STATUSES.has(rawStatus)
    ? (rawStatus as ServerWhatsAppStatus)
    : 'unknown';
  return {
    id,
    accountName,
    phoneNumber: optionalText(value.phoneNumber),
    status,
    connectedAt: isoOrNull(value.connectedAt),
    lastSeenAt: isoOrNull(value.lastSeenAt),
  };
}

export function parseServerWhatsAppAccounts(value: unknown): ServerWhatsAppAccount[] {
  if (!Array.isArray(value)) throw new Error('WhatsApp 账号列表返回格式无效');
  return value.map(parseServerWhatsAppAccount);
}

export function parseServerWhatsAppQr(value: unknown): ServerWhatsAppQr {
  if (!isRecord(value)) throw new Error('WhatsApp 二维码返回格式无效');
  const rawStatus = optionalText(value.status)?.toLowerCase() || 'unknown';
  const status = SERVER_WHATSAPP_STATUSES.has(rawStatus)
    ? (rawStatus as ServerWhatsAppStatus)
    : 'unknown';
  const qr = optionalText(value.qrCode);
  if (
    qr
    && (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(qr) || qr.length > 900_000)
  ) {
    throw new Error('WhatsApp 二维码未通过本地安全校验');
  }
  return {
    status,
    qrDataUrl: qr,
    expireAt: isoOrNull(value.expireAt),
    phoneNumber: optionalText(value.phoneNumber),
  };
}

export async function listServerWhatsAppAccounts(): Promise<ServerWhatsAppAccount[]> {
  const response = await api.get<unknown>('/whatsapp/accounts');
  return parseServerWhatsAppAccounts(response.data);
}

export async function createServerWhatsAppAccount(input: {
  name: string;
  phone?: string;
}): Promise<ServerWhatsAppAccount> {
  const response = await api.post<unknown>('/whatsapp/accounts', input);
  return parseServerWhatsAppAccount(response.data);
}

export async function getServerWhatsAppQr(accountId: string): Promise<ServerWhatsAppQr> {
  const response = await api.get<unknown>(
    `/whatsapp/accounts/${encodeURIComponent(accountId)}/qr`,
  );
  return parseServerWhatsAppQr(response.data);
}

export async function reconnectServerWhatsAppAccount(
  accountId: string,
): Promise<ServerWhatsAppQr> {
  const response = await api.post<unknown>(
    `/whatsapp/accounts/${encodeURIComponent(accountId)}/reconnect`,
    {},
  );
  return parseServerWhatsAppQr(response.data);
}

export async function disconnectServerWhatsAppAccount(accountId: string): Promise<void> {
  const response = await api.post<unknown>(
    `/whatsapp/accounts/${encodeURIComponent(accountId)}/disconnect`,
    {},
  );
  if (!isRecord(response.data) || response.data.success !== true) {
    throw new Error('服务器未确认 WhatsApp 已断开');
  }
}

export async function removeServerWhatsAppAccount(accountId: string): Promise<void> {
  await api.delete(`/whatsapp/accounts/${encodeURIComponent(accountId)}`);
}

export function parseBusinessEmailAccounts(value: unknown): BusinessEmailAccount[] {
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw new Error('邮件账号列表返回格式无效');
  }
  return value.data.map((item) => {
    if (!isRecord(item)) throw new Error('邮件账号返回格式无效');
    const id = optionalText(item.id);
    const senderName = optionalText(item.senderName);
    const senderEmail = optionalText(item.senderEmail);
    const status = optionalText(item.status);
    if (!id || !senderName || !senderEmail || !status) {
      throw new Error('邮件账号缺少必要字段');
    }
    return {
      id,
      senderName,
      senderEmail,
      replyToEmail: optionalText(item.replyToEmail),
      status,
    };
  });
}

export async function listBusinessEmailAccounts(): Promise<BusinessEmailAccount[]> {
  const response = await api.get<unknown>('/email-accounts', {
    params: { status: 'active', limit: 100 },
  });
  return parseBusinessEmailAccounts(response.data).filter(
    (account) => account.status.toLowerCase() === 'active',
  );
}

export function plainTextToSafeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\r?\n/g, '<br>');
}

export function replySubject(subject: string | null | undefined): string {
  const normalized = subject?.trim() || '(无主题)';
  return /^re\s*:/i.test(normalized) ? normalized : `Re: ${normalized}`;
}

export function parseEmailDeliveryReceipt(value: unknown): EmailDeliveryReceipt {
  if (!isRecord(value)) throw new Error('SMTP 未返回可核验回执');
  const messageId = optionalText(value.messageId);
  const accepted = Array.isArray(value.accepted)
    ? value.accepted.filter((item): item is string => typeof item === 'string' && !!item.trim())
    : [];
  if (!messageId || accepted.length === 0) {
    throw new Error('SMTP 未返回 messageId 与接收方回执');
  }
  return {
    status: 'SUCCEEDED',
    messageId,
    accepted,
    response: optionalText(value.response),
  };
}

export async function sendBusinessEmail(input: {
  emailAccountId: string;
  to: string;
  subject: string;
  text: string;
  leadId?: string;
  conversationId?: string;
}): Promise<EmailDeliveryReceipt> {
  const response = await api.post<unknown>('/business-mail/send', {
    emailAccountId: input.emailAccountId,
    to: input.to,
    subject: input.subject,
    html: plainTextToSafeHtml(input.text),
    ...(input.leadId ? { leadId: input.leadId } : {}),
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
  });
  return parseEmailDeliveryReceipt(response.data);
}

export function deliveryFailureFrom(error: unknown): MessagingDeliveryFailure {
  const payload = axios.isAxiosError(error) && isRecord(error.response?.data)
    ? error.response?.data
    : null;
  const nested = payload && isRecord(payload.message) ? payload.message : payload;
  const status = nested?.status === 'BLOCKED' ? 'BLOCKED' : 'FAILED';
  const code = optionalText(nested?.code)
    || (axios.isAxiosError(error) && optionalText(error.code))
    || 'DELIVERY_FAILED';
  const message = optionalText(nested?.message)
    || (error instanceof Error ? error.message : null)
    || '消息投递失败';
  return { status, code, message };
}

export function parseOwnerNotificationStatus(value: unknown): OwnerNotificationStatus {
  if (!isRecord(value) || !isRecord(value.counts)) {
    throw new Error('负责人通知状态返回格式无效');
  }
  const channelStatuses = new Set(['CONNECTED', 'UNBOUND', 'OFFLINE', 'ERROR']);
  const channelStatus = optionalText(value.channelStatus)?.toUpperCase();
  if (
    typeof value.enabled !== 'boolean'
    || value.channel !== 'openclaw-weixin'
    || !channelStatus
    || !channelStatuses.has(channelStatus)
  ) {
    throw new Error('负责人通知通道状态无效');
  }
  const counts = {
    pending: nonNegativeInteger(value.counts.pending),
    sending: nonNegativeInteger(value.counts.sending),
    sent: nonNegativeInteger(value.counts.sent),
    failed: nonNegativeInteger(value.counts.failed),
  };
  if (Object.values(counts).some((count) => count === null)) {
    throw new Error('负责人通知队列计数无效');
  }
  let lastDelivery: OwnerNotificationStatus['lastDelivery'] = null;
  if (value.lastDelivery !== null && value.lastDelivery !== undefined) {
    if (!isRecord(value.lastDelivery)) throw new Error('负责人通知末次投递状态无效');
    const deliveryStatus = optionalText(value.lastDelivery.status)?.toUpperCase();
    const eventType = optionalText(value.lastDelivery.eventType);
    const createdAt = isoOrNull(value.lastDelivery.createdAt);
    if (
      !deliveryStatus
      || !['PENDING', 'SENDING', 'SENT', 'FAILED'].includes(deliveryStatus)
      || !eventType
      || !createdAt
    ) throw new Error('负责人通知末次投递状态无效');
    lastDelivery = {
      status: deliveryStatus as OwnerNotificationStatus['lastDelivery'] extends infer T
        ? T extends { status: infer S } ? S : never
        : never,
      eventType,
      createdAt,
      sentAt: isoOrNull(value.lastDelivery.sentAt),
      errorCode: optionalText(value.lastDelivery.errorCode),
    };
  }
  return {
    available: true,
    enabled: value.enabled,
    channel: 'openclaw-weixin',
    channelStatus: channelStatus as OwnerNotificationStatus['channelStatus'],
    counts: counts as OwnerNotificationStatus['counts'],
    lastDelivery,
  };
}

export async function getOwnerNotificationStatus(
  companyId?: string,
): Promise<OwnerNotificationStatusResult> {
  try {
    const response = await api.get<unknown>('/owner-notifications/status', {
      params: companyId ? { companyId } : undefined,
    });
    return parseOwnerNotificationStatus(response.data);
  } catch (error) {
    if (axios.isAxiosError(error) && error.response?.status === 404) {
      return { available: false, reason: 'NOT_EXPOSED' };
    }
    return { available: false, reason: 'UNREACHABLE' };
  }
}
