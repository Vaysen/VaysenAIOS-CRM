'use client';

import { MessageCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useElectron, type WhatsAppLoginStatus } from '@/hooks/use-electron';

const STATUS_LABEL: Record<WhatsAppLoginStatus, string> = {
  waiting_scan: '等待扫码',
  logged_in: 'WhatsApp 已连接',
  unknown: 'WhatsApp 未连接',
};

/**
 * WhatsApp 连接状态指示器。
 *
 * - waiting_scan：黄色脉冲动画 + “等待扫码”
 * - logged_in：绿色圆点 + “WhatsApp 已连接”
 * - unknown：灰色圆点 + “WhatsApp 未连接”
 *
 * 通过 useElectron 监听登录状态变化，非 Electron 环境不渲染。
 */
export function WhatsAppStatus() {
  const { isElectron, whatsappStatus } = useElectron();

  if (!isElectron) return null;

  const label = STATUS_LABEL[whatsappStatus];

  return (
    <div className="flex items-center gap-2" title={label}>
      <MessageCircle className="h-4 w-4 text-muted-foreground" />

      {whatsappStatus === 'waiting_scan' && (
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-yellow-500 opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-yellow-500" />
        </span>
      )}
      {whatsappStatus === 'logged_in' && (
        <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
      )}
      {whatsappStatus === 'unknown' && (
        <span className="relative inline-flex h-2 w-2 rounded-full bg-gray-400" />
      )}

      <span
        className={cn(
          'text-xs',
          whatsappStatus === 'logged_in' && 'text-green-600 dark:text-green-400',
          whatsappStatus === 'waiting_scan' && 'text-yellow-600 dark:text-yellow-400',
          whatsappStatus === 'unknown' && 'text-muted-foreground',
        )}
      >
        {label}
      </span>
    </div>
  );
}
