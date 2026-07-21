'use client';

import { useEffect, useState } from 'react';
import { Copy, Minus, Square, X } from 'lucide-react';

/**
 * 扩展 CSSProperties 以支持 Electron 的 `-webkit-app-region` 拖拽区域。
 * React 内置类型未必包含该属性，这里用交集类型保证类型安全且不报错。
 */
type DragRegionStyle = React.CSSProperties & {
  WebkitAppRegion?: 'drag' | 'no-drag';
};

const dragStyle: DragRegionStyle = { WebkitAppRegion: 'drag' };
const noDragStyle: DragRegionStyle = { WebkitAppRegion: 'no-drag' };

const APP_NAME = 'Vaysen AI CRM';

/**
 * 无边框窗口的自定义标题栏。
 *
 * - 高度 36px（h-9），整体可拖拽（-webkit-app-region: drag）
 * - 左侧显示应用名称
 * - 右侧三个窗口控制按钮：最小化、最大化/还原、关闭
 * - 非 Electron 环境（window.electronAPI 不存在）不渲染
 */
export function TitleBar() {
  const [isElectron, setIsElectron] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
    if (!api) {
      setIsElectron(false);
      return;
    }
    setIsElectron(true);

    let active = true;

    const checkMaximized = async () => {
      try {
        const maximized = await api.window.isMaximized();
        if (active) setIsMaximized(!!maximized);
      } catch (error) {
        console.error('[TitleBar] maximize-state query failed:', error);
      }
    };

    checkMaximized();
    // 主进程目前未推送最大化状态变化事件，定期轮询以保持 UI 同步
    const timer = window.setInterval(checkMaximized, 1000);

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  // 非 Electron 环境（如纯浏览器访问）不显示自定义标题栏
  if (!isElectron) return null;

  const handleMinimize = () => window.electronAPI?.window.minimize();
  const handleMaximizeToggle = () => window.electronAPI?.window.maximizeToggle();
  const handleClose = () => window.electronAPI?.window.close();

  return (
    <div
      className="flex h-9 items-center justify-between border-b border-border bg-background px-3 select-none"
      style={dragStyle}
    >
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-foreground">{APP_NAME}</span>
      </div>

      <div className="flex items-center gap-0.5" style={noDragStyle}>
        <button
          type="button"
          onClick={handleMinimize}
          aria-label="最小化"
          title="最小化"
          className="flex h-7 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Minus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={handleMaximizeToggle}
          aria-label={isMaximized ? '还原' : '最大化'}
          title={isMaximized ? '还原' : '最大化'}
          className="flex h-7 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {isMaximized ? <Copy className="h-3 w-3" /> : <Square className="h-3 w-3" />}
        </button>
        <button
          type="button"
          onClick={handleClose}
          aria-label="关闭"
          title="关闭"
          className="flex h-7 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-red-600 hover:text-white"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
