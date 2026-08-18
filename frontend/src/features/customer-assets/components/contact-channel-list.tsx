/**
 * TASK-102H: ContactChannelList
 *
 * 联系人渠道列表：渲染一个联系人下的所有联系点。
 * 使用 ChannelActionLink 进行安全跳转。
 */

'use client';

import type { ContactPoint } from '../types';
import { ChannelActionLink } from './channel-action-link';

export interface ContactChannelListProps {
  contactPoints: ContactPoint[];
  /** 内部通信基座路径前缀 */
  internalChatBase?: string;
}

export function ContactChannelList({
  contactPoints,
  internalChatBase,
}: ContactChannelListProps) {
  if (contactPoints.length === 0) {
    return (
      <p className="text-[10px] text-gray-400 italic py-1">暂无联系渠道</p>
    );
  }

  return (
    <div className="space-y-0.5" data-testid="contact-channel-list">
      {contactPoints.map((cp) => (
        <div key={cp.id} className="flex items-start gap-1">
          <ChannelActionLink
            contactPoint={cp}
            internalChatBase={internalChatBase}
          />
        </div>
      ))}
    </div>
  );
}
