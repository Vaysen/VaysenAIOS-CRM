export const BROWSER_API_BASE_KEY = 'vaysen-crm.api-base-url';

export type RuntimeApiConfig = { apiBaseUrl: string };

export function defaultApiBaseUrl(): string {
  const configured = process.env.NEXT_PUBLIC_API_URL || '/api';
  try {
    return normalizeRuntimeApiBaseUrl(configured);
  } catch {
    return '/api';
  }
}

export function isElectronRenderer(): boolean {
  return typeof window !== 'undefined' && !!window.electronAPI;
}

export function getRuntimeApiBaseUrl(): string {
  // Electron always uses the stable same-origin proxy. The real LAN target is
  // deliberately kept in the main process store and never shipped in static JS.
  if (isElectronRenderer()) return '/api';
  if (typeof window !== 'undefined') {
    const saved = window.localStorage.getItem(BROWSER_API_BASE_KEY)?.trim();
    if (saved) {
      try {
        return normalizeRuntimeApiBaseUrl(saved);
      } catch {
        window.localStorage.removeItem(BROWSER_API_BASE_KEY);
      }
    }
  }
  return defaultApiBaseUrl();
}

export function validateRuntimeApiBaseUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return '请输入服务器地址。';
  if (/^\/api\/?$/.test(trimmed)) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return '地址必须是 http(s)://主机:端口，例如 http://your-lan-host:4000。';
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return '服务器地址必须使用 http 或 https。';
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    return '服务器地址不能包含账号、密码、查询参数或片段。';
  }
  return null;
}

/** Normalize a user-entered server root or API base to the actual /api base. */
export function normalizeRuntimeApiBaseUrl(value: string): string {
  const trimmed = value.trim();
  if (/^\/api\/?$/.test(trimmed)) return '/api';
  const validationError = validateRuntimeApiBaseUrl(trimmed);
  if (validationError) throw new Error(validationError);
  const parsed = new URL(trimmed);
  const pathname = parsed.pathname.replace(/\/+$/, '');
  if (pathname && pathname !== '/api') {
    throw new Error('server address path must be empty or /api');
  }
  return `${parsed.origin}/api`;
}

export function readBrowserApiBaseUrl(): RuntimeApiConfig {
  return { apiBaseUrl: getRuntimeApiBaseUrl() };
}

export function saveBrowserApiBaseUrl(apiBaseUrl: string): string | undefined {
  if (typeof window === 'undefined') return;
  const normalized = normalizeRuntimeApiBaseUrl(apiBaseUrl);
  if (normalized === '/api' || normalized === defaultApiBaseUrl()) {
    window.localStorage.removeItem(BROWSER_API_BASE_KEY);
  } else {
    window.localStorage.setItem(BROWSER_API_BASE_KEY, normalized);
  }
  return normalized;
}

export function healthUrlForApiBase(apiBaseUrl: string): string {
  const normalized = normalizeRuntimeApiBaseUrl(apiBaseUrl);
  if (normalized === '/api' || normalized.startsWith('/')) return '/health';
  const url = new URL(normalized);
  url.pathname = '/health';
  url.search = '';
  url.hash = '';
  return url.toString();
}
