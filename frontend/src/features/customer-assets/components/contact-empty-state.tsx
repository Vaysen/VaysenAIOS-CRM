/**
 * TASK-102H: ContactEmptyState
 *
 * 无联系人时的空状态展示。
 */

'use client';

import { Users } from 'lucide-react';

export interface ContactEmptyStateProps {
  /** 可选的创建联系人回调 */
  onCreateContact?: () => void;
}

export function ContactEmptyState({ onCreateContact }: ContactEmptyStateProps) {
  return (
    <div
      className="text-center py-8 px-4"
      data-testid="contact-empty-state"
    >
      <Users className="w-8 h-8 mx-auto text-gray-300 mb-2" />
      <p className="text-sm text-gray-500">暂无联系人</p>
      <p className="text-xs text-gray-400 mt-1">
        该客户尚未关联任何联系人
      </p>
      {onCreateContact && (
        <button
          onClick={onCreateContact}
          className="mt-3 text-xs text-blue-600 hover:underline"
        >
          + 添加联系人
        </button>
      )}
    </div>
  );
}
