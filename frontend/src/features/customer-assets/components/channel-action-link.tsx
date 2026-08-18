/**
 * TASK-102H: ChannelActionLink
 *
 * 安全跳转链接组件。
 * - 内部会话优先：若有 conversationId，跳转到内部通信页面
 * - wa.me 降级：仅对合法 E.164 号码生成 wa.me 链接
 * - mailto 降级：仅对合法邮箱生成 mailto 链接
 * - 无合法链接时仅展示文本（不渲染危险 href）
 */

'use client';

import { MessageCircle, Mail, Phone, Globe } from 'lucide-react';
import type { ContactPoint, ContactPointType } from '../types';
import {
  buildWhatsAppLink,
  buildEmailLink,
} from '../domain/customer-links';

export interface ChannelActionLinkProps {
  contactPoint: ContactPoint;
  /** 内部通信基座路径前缀，默认 /whatsapp/chat */
  internalChatBase?: string;
}

/** 渠道图标映射 */
function ChannelIcon({ type }: { type: ContactPointType }) {
  switch (type) {
    case 'whatsapp':
      return <MessageCircle className="w-3 h-3 shrink-0" />;
    case 'email':
    case 'business_email':
    case 'marketing_email':
      return <Mail className="w-3 h-3 shrink-0" />;
    case 'phone':
      return <Phone className="w-3 h-3 shrink-0" />;
    default:
      return <Globe className="w-3 h-3 shrink-0" />;
  }
}

/** 渠道标签 */
function channelLabel(type: ContactPointType): string {
  switch (type) {
    case 'whatsapp':
      return 'WhatsApp';
    case 'email':
    case 'business_email':
    case 'marketing_email':
      return '邮箱';
    case 'phone':
      return '电话';
    case 'website_inquiry':
      return '网站询盘';
    default:
      return type;
  }
}

export function ChannelActionLink({
  contactPoint,
  internalChatBase = '/whatsapp/chat',
}: ChannelActionLinkProps) {
  const { type, originalValue, normalizedValue, conversationId, isAvailable } =
    contactPoint;

  const label = channelLabel(type);
  const displayValue = originalValue || normalizedValue;

  // 不可用的渠道点仅展示文本
  if (!isAvailable) {
    return (
      <div
        className="flex items-center gap-1 text-gray-300"
        data-testid="channel-link-unavailable"
      >
        <ChannelIcon type={type} />
        <span className="text-[11px]">{displayValue}</span>
        <span className="text-[9px] text-gray-300">（不可用）</span>
      </div>
    );
  }

  // 1. 内部会话优先
  if (conversationId) {
    const href = `${internalChatBase}?conversationId=${encodeURIComponent(
      conversationId,
    )}`;
    return (
      <a
        href={href}
        className="flex items-center gap-1 text-blue-600 hover:underline"
        data-testid="channel-link-internal"
      >
        <ChannelIcon type={type} />
        <span className="text-[11px] truncate">{displayValue}</span>
      </a>
    );
  }

  // 2. 根据类型生成安全链接
  let safeHref: string | null = null;

  if (
    type === 'whatsapp' ||
    type === 'phone'
  ) {
    // WhatsApp 渠道：尝试 wa.me（仅合法 E.164）
    safeHref = buildWhatsAppLink(normalizedValue) ?? buildWhatsAppLink(originalValue);
  }

  if (
    type === 'email' ||
    type === 'business_email' ||
    type === 'marketing_email'
  ) {
    // 邮箱渠道：尝试 mailto
    safeHref = buildEmailLink(normalizedValue) ?? buildEmailLink(originalValue);
  }

  // 有合法链接 → 渲染 <a>
  if (safeHref) {
    const isWhatsApp = safeHref.startsWith('https://wa.me/');
    return (
      <a
        href={safeHref}
        target={isWhatsApp ? '_blank' : undefined}
        rel={isWhatsApp ? 'noopener noreferrer' : undefined}
        className="flex items-center gap-1 text-blue-600 hover:underline"
        data-testid={
          isWhatsApp ? 'channel-link-whatsapp' : 'channel-link-email'
        }
      >
        <ChannelIcon type={type} />
        <span className="text-[11px] truncate">{displayValue}</span>
      </a>
    );
  }

  // 3. 无合法链接 → 仅展示文本（不渲染 href）
  return (
    <div
      className="flex items-center gap-1 text-gray-500"
      data-testid="channel-link-plain"
    >
      <ChannelIcon type={type} />
      <span className="text-[11px] truncate">{displayValue}</span>
    </div>
  );
}
