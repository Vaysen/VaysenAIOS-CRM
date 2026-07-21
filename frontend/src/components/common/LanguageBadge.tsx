'use client';

import { getLanguageDisplay } from '@/lib/language-constants';

interface Props {
  language?: string | null;
  size?: 'sm' | 'md' | 'lg';
  showName?: boolean;
  showNative?: boolean;
  className?: string;
}

/**
 * 语言徽章组件
 * 显示客户偏好语言的旗帜 + 名称
 */
export function LanguageBadge({ language, size = 'sm', showName = true, showNative = false, className = '' }: Props) {
  const display = getLanguageDisplay(language);
  if (!display) {
    return showName ? (
      <span className={`inline-flex items-center gap-1 text-gray-400 ${className}`}>
        <span className="text-[10px]">🌐</span>
        {size === 'sm' && <span className="text-[10px]">未设置</span>}
      </span>
    ) : null;
  }

  const sizeClasses = {
    sm: 'text-[10px] px-1.5 py-0.5 gap-0.5',
    md: 'text-xs px-2 py-1 gap-1',
    lg: 'text-sm px-2.5 py-1.5 gap-1.5',
  };

  const flagSizes = {
    sm: 'text-[11px]',
    md: 'text-sm',
    lg: 'text-base',
  };

  return (
    <span
      className={`inline-flex items-center rounded-full font-medium ${display.color} ${sizeClasses[size]} ${className}`}
      title={`${display.name} (${display.nativeName})`}
    >
      <span className={flagSizes[size]}>{display.flag}</span>
      {showName && <span>{showNative ? display.nativeName : display.name}</span>}
    </span>
  );
}
