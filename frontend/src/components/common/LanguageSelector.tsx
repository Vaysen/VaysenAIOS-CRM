'use client';

import { LANGUAGE_OPTIONS, getLanguageDisplay } from '@/lib/language-constants';

interface Props {
  value?: string | null;
  onChange?: (language: string) => void;
  className?: string;
  size?: 'sm' | 'md';
  allowEmpty?: boolean;
}

/**
 * 语言选择器组件
 * 用于手动设置客户偏好语言
 */
export function LanguageSelector({ value, onChange, className = '', size = 'sm', allowEmpty = true }: Props) {
  const current = getLanguageDisplay(value);
  const sizeClass = size === 'sm' ? 'text-[11px] py-1' : 'text-sm py-1.5';

  return (
    <select
      value={value || ''}
      onChange={(e) => onChange?.(e.target.value)}
      className={`border rounded px-2 ${sizeClass} bg-white outline-none focus:border-blue-400 transition-colors ${className}`}
    >
      {allowEmpty && <option value="">未设置</option>}
      {LANGUAGE_OPTIONS.map((opt) => (
        <option key={opt.code} value={opt.code}>
          {opt.flag} {opt.name}
        </option>
      ))}
      {/* 如果当前值不在选项中，显示它 */}
      {value && !LANGUAGE_OPTIONS.find((o) => o.code === value) && current && (
        <option value={value}>{current.flag} {current.name}</option>
      )}
    </select>
  );
}
