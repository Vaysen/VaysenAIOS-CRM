'use client';

import { cn } from '@/lib/utils';
import { useElectron } from '@/hooks/use-electron';

/**
 * 网络在线状态指示器。
 *
 * - 固定在右下角的小圆点
 * - 在线：绿色（带脉冲动画）
 * - 离线：红色
 * - 通过 useElectron 监听在线/离线状态变化，非 Electron 环境不渲染
 */
export function OnlineIndicator() {
  const { isElectron, isOnline } = useElectron();

  if (!isElectron) return null;

  return (
    <div
      className="fixed bottom-4 right-4 z-50 flex items-center gap-2 rounded-full bg-background/80 px-2.5 py-1 shadow-sm backdrop-blur"
      title={isOnline ? '网络在线' : '网络离线'}
    >
      <span className="relative flex h-2.5 w-2.5">
        {isOnline && (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-500 opacity-75" />
        )}
        <span
          className={cn(
            'relative inline-flex h-2.5 w-2.5 rounded-full',
            isOnline ? 'bg-green-500' : 'bg-red-500',
          )}
        />
      </span>
      <span className="text-xs text-muted-foreground">{isOnline ? '在线' : '离线'}</span>
    </div>
  );
}
