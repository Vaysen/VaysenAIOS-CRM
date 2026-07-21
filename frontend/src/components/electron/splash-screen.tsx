'use client';

import { useEffect, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

interface SplashScreenProps {
  /** 应用版本号；未传时尝试从 Electron 读取，再退回到 1.0.0 */
  version?: string;
  /** 底部加载状态文字 */
  statusText?: string;
  /** 自动淡出前的停留毫秒数，默认 3000（3 秒） */
  duration?: number;
}

const DEFAULT_VERSION = '1.0.0';

/**
 * 应用启动时的全屏加载画面。
 *
 * - 深色背景 (#0f172a)
 * - 中央显示 “Vaysen AI CRM” logo 文字 + 旋转加载圈
 * - 底部显示版本号与加载状态文字
 * - duration（默认 3 秒）后自动淡出并卸载
 */
export function SplashScreen({
  version,
  statusText = '正在加载…',
  duration = 3000,
}: SplashScreenProps) {
  const [visible, setVisible] = useState(true);
  const [fading, setFading] = useState(false);
  const [resolvedVersion, setResolvedVersion] = useState(version ?? DEFAULT_VERSION);

  useEffect(() => {
    if (version) {
      setResolvedVersion(version);
    } else if (typeof window !== 'undefined' && window.electronAPI) {
      window.electronAPI.app
        .getVersion()
        .then((v) => setResolvedVersion(v || DEFAULT_VERSION))
        .catch((error) => { console.error('[Frontend] background operation failed:', error); });
    }

    const fadeTimer = window.setTimeout(() => setFading(true), duration);
    // 淡出动画 500ms 后再卸载，避免突兀消失
    const removeTimer = window.setTimeout(() => setVisible(false), duration + 500);

    return () => {
      window.clearTimeout(fadeTimer);
      window.clearTimeout(removeTimer);
    };
  }, [version, duration]);

  if (!visible) return null;

  return (
    <div
      className={cn(
        'fixed inset-0 z-[9999] flex flex-col items-center justify-center transition-opacity duration-500',
        fading ? 'opacity-0' : 'opacity-100',
      )}
      style={{ backgroundColor: '#0f172a' }}
    >
      <div className="flex flex-col items-center gap-5">
        <h1 className="text-5xl font-bold tracking-tight text-white">Vaysen AI CRM</h1>
        <p className="text-sm font-medium text-slate-400">外贸系统</p>
        <LoaderCircle className="h-8 w-8 animate-spin text-sky-400" />
      </div>

      <div className="absolute bottom-10 flex flex-col items-center gap-1">
        <p className="text-xs text-slate-500">v{resolvedVersion}</p>
        <p className="text-xs text-slate-500">{statusText}</p>
      </div>
    </div>
  );
}
