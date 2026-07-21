/**
 * 客户语言显示常量
 * 用于前端展示客户偏好语言（非界面 i18n，界面始终中文）
 */

/** 语言代码 → 显示信息映射 */
export const LANGUAGE_DISPLAY: Record<string, { name: string; nativeName: string; flag: string; color: string }> = {
  en: { name: '英语', nativeName: 'English', flag: '🇬🇧', color: 'bg-blue-100 text-blue-700' },
  ja: { name: '日语', nativeName: '日本語', flag: '🇯🇵', color: 'bg-red-100 text-red-700' },
  ko: { name: '韩语', nativeName: '한국어', flag: '🇰🇷', color: 'bg-purple-100 text-purple-700' },
  es: { name: '西班牙语', nativeName: 'Español', flag: '🇪🇸', color: 'bg-yellow-100 text-yellow-700' },
  fr: { name: '法语', nativeName: 'Français', flag: '🇫🇷', color: 'bg-indigo-100 text-indigo-700' },
  de: { name: '德语', nativeName: 'Deutsch', flag: '🇩🇪', color: 'bg-gray-100 text-gray-700' },
  it: { name: '意大利语', nativeName: 'Italiano', flag: '🇮🇹', color: 'bg-green-100 text-green-700' },
  zh: { name: '中文', nativeName: '中文', flag: '🇨🇳', color: 'bg-red-100 text-red-700' },
  'zh-CN': { name: '中文', nativeName: '中文', flag: '🇨🇳', color: 'bg-red-100 text-red-700' },
};

/** 支持的语言选项（用于下拉选择器） */
export const LANGUAGE_OPTIONS = [
  { code: 'en', name: '英语 English', flag: '🇬🇧' },
  { code: 'ja', name: '日语 日本語', flag: '🇯🇵' },
  { code: 'ko', name: '韩语 한국어', flag: '🇰🇷' },
  { code: 'es', name: '西班牙语 Español', flag: '🇪🇸' },
  { code: 'fr', name: '法语 Français', flag: '🇫🇷' },
  { code: 'de', name: '德语 Deutsch', flag: '🇩🇪' },
  { code: 'it', name: '意大利语 Italiano', flag: '🇮🇹' },
  { code: 'zh', name: '中文', flag: '🇨🇳' },
];

/** 获取语言显示信息，未知语言返回默认值 */
export function getLanguageDisplay(code?: string | null) {
  if (!code) return null;
  return LANGUAGE_DISPLAY[code] || LANGUAGE_DISPLAY['en'];
}

/** 获取语言中文名称 */
export function getLanguageName(code?: string | null): string {
  const display = getLanguageDisplay(code);
  return display?.name || '未设置';
}

/** 获取语言旗帜 emoji */
export function getLanguageFlag(code?: string | null): string {
  const display = getLanguageDisplay(code);
  return display?.flag || '🌐';
}
