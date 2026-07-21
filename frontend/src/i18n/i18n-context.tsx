'use client';

import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';
import zhCNMessages from './translations/zh-CN.json';
import enMessages from './translations/en.json';

type Locale = 'zh-CN' | 'en';
type Messages = Record<string, unknown>;

const dictionaries: Record<Locale, Messages> = {
  'zh-CN': zhCNMessages,
  en: enMessages,
};

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  messages: Messages;
}

const I18nContext = createContext<I18nContextValue>({
  locale: 'zh-CN',
  setLocale: () => {},
  messages: {},
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>('zh-CN');
  const messages = dictionaries[locale] || dictionaries['zh-CN'];

  useEffect(() => {
    const stored = localStorage.getItem('locale');
    if (stored === 'en' || stored === 'zh-CN') {
      setLocaleState(stored);
    }
  }, []);

  const setLocale = useCallback((newLocale: Locale) => {
    setLocaleState(newLocale);
    localStorage.setItem('locale', newLocale);
  }, []);

  return (
    <I18nContext.Provider value={{ locale, setLocale, messages }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  return useContext(I18nContext);
}
