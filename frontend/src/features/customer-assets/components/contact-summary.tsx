/**
 * TASK-102H: ContactSummary
 *
 * 联系人摘要：展示联系人名称、是否主联系人、更新时间。
 * 使用 formatContactName 确保名称缺失时有占位符。
 */

'use client';

import { Star } from 'lucide-react';
import type { CustomerContact } from '../types';
import { formatContactName } from '../domain/customer-links';

export interface ContactSummaryProps {
  contact: CustomerContact;
  /** 是否选中态 */
  isSelected?: boolean;
}

export function ContactSummary({ contact, isSelected }: ContactSummaryProps) {
  const name = formatContactName(contact);

  return (
    <div
      className={`flex items-center gap-1.5 ${
        isSelected ? 'text-blue-700' : 'text-gray-700'
      }`}
      data-testid="contact-summary"
    >
      <span className="text-[12px] font-medium truncate">{name}</span>
      {contact.isPrimary && (
        <Star className="w-2.5 h-2.5 text-amber-400 fill-amber-400 shrink-0" />
      )}
      {contact.updatedAt && (
        <span className="text-[9px] text-gray-400 ml-auto shrink-0">
          {new Date(contact.updatedAt).toLocaleDateString('zh-CN', {
            month: 'short',
            day: 'numeric',
          })}
        </span>
      )}
    </div>
  );
}
