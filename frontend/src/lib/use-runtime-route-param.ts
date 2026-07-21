'use client';

import { useParams, usePathname } from 'next/navigation';

/**
 * Electron 的静态导出会把动态详情页重写到 __static.html，Next useParams()
 * 因而只能读到占位值。浏览器地址栏仍保留真实业务 ID，本 hook 优先从
 * pathname 解析它，并兼容 /resource/:id/edit 两种路径。
 */
export function useRuntimeRouteParam(name: string): string {
  const params = useParams<Record<string, string | string[]>>();
  const pathname = usePathname();
  const segments = pathname.split('/').filter(Boolean);
  const tailOffset = segments.at(-1) === 'edit' ? 2 : 1;
  const pathValue = segments.at(-tailOffset) || '';
  const fallback = params?.[name];
  const paramValue = Array.isArray(fallback) ? fallback[0] : fallback || '';

  const value = pathValue && pathValue !== '__static' ? pathValue : paramValue;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
