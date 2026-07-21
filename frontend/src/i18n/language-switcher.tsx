'use client';

import { useI18n } from './i18n-context';

export function LanguageSwitcher() {
  const { locale, setLocale } = useI18n();

  return (
    <button
      onClick={() => setLocale(locale === 'zh-CN' ? 'en' : 'zh-CN')}
      className="rounded-lg px-3 py-1.5 text-sm font-medium text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800 transition-colors"
      title={locale === 'zh-CN' ? 'Switch to English' : '切换到中文'}
    >
      {locale === 'zh-CN' ? 'EN' : '中'}
    </button>
  );
}
