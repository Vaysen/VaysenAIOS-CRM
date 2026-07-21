'use client';

import { useI18n } from './i18n-context';

type Params = Record<string, string | number>;

export function useT() {
  const { messages } = useI18n();

  function t(key: string, params?: Params): string {
    const keys = key.split('.');
    let value: any = messages;
    for (const k of keys) {
      value = value?.[k];
    }
    if (typeof value !== 'string') return key;
    if (!params) return value;
    return value.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? `{${k}}`));
  }

  return { t };
}
