'use client';

import { useCallback, useEffect, useState } from 'react';
import { Bell, BellOff, Loader2, RefreshCw, TriangleAlert } from 'lucide-react';
import {
  getOwnerNotificationStatus,
  type OwnerNotificationStatusResult,
} from '@/lib/messaging-control-api';
import { useAuthStore } from '@/store/authStore';
import { cn } from '@/lib/utils';

function statusText(status: OwnerNotificationStatusResult | null): string {
  if (!status) return '微信通知状态读取中';
  if (!status.available) {
    return status.reason === 'NOT_EXPOSED'
      ? '微信通知队列状态尚未开放'
      : '微信通知状态暂时不可达';
  }
  if (!status.enabled) return '微信通知未启用';
  if (status.channelStatus !== 'CONNECTED') {
    return status.channelStatus === 'UNBOUND' ? '微信通知未绑定' : '微信通知通道离线';
  }
  if (status.counts.failed > 0) return `微信通知失败 ${status.counts.failed} 条`;
  if (status.counts.pending + status.counts.sending > 0) {
    return `微信通知待投递 ${status.counts.pending + status.counts.sending} 条`;
  }
  return '微信新消息通知在线';
}

export function OwnerNotificationStatusPill({
  companyId,
  compact = false,
  className,
}: {
  companyId?: string;
  compact?: boolean;
  className?: string;
}) {
  const activeCompanyId = useAuthStore((state) => state.activeCompanyId);
  const firstCompanyId = useAuthStore((state) => state.user?.companies?.[0]?.id);
  const resolvedCompanyId = companyId || activeCompanyId || firstCompanyId || '';
  const [status, setStatus] = useState<OwnerNotificationStatusResult | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!resolvedCompanyId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      setStatus(await getOwnerNotificationStatus(resolvedCompanyId));
    } finally {
      setLoading(false);
    }
  }, [resolvedCompanyId]);

  useEffect(() => {
    if (!resolvedCompanyId) return undefined;
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && navigator.onLine) void refresh();
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [refresh, resolvedCompanyId]);

  const unavailable = status?.available === false;
  const ready = status?.available === true
    && status.enabled
    && status.channelStatus === 'CONNECTED'
    && status.counts.failed === 0;
  const failed = status?.available === true && status.counts.failed > 0;
  const Icon = unavailable || status?.available === true && !status.enabled
    ? BellOff
    : failed
      ? TriangleAlert
      : Bell;
  const label = resolvedCompanyId ? statusText(status) : '等待公司信息';

  return (
    <span
      className={cn(
        'inline-flex min-w-0 items-center gap-1.5 rounded-full border px-2 py-1 text-[10px] font-medium',
        ready
          ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
          : failed
            ? 'border-red-200 bg-red-50 text-red-700'
            : 'border-amber-200 bg-amber-50 text-amber-700',
        className,
      )}
      role="status"
      data-testid="owner-notification-status"
      title={label}
    >
      {loading && !status ? <Loader2 className="h-3 w-3 animate-spin" /> : <Icon className="h-3 w-3" />}
      <span className={cn('truncate', compact && 'max-w-36')}>{label}</span>
      {!compact && (
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          className="ml-0.5 rounded p-0.5 hover:bg-black/5 disabled:opacity-50"
          aria-label="刷新微信通知状态"
        >
          <RefreshCw className={cn('h-2.5 w-2.5', loading && 'animate-spin')} />
        </button>
      )}
    </span>
  );
}

export { statusText as ownerNotificationStatusText };
