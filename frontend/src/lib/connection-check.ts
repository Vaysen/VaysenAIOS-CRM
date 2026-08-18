import { healthUrlForApiBase, validateRuntimeApiBaseUrl } from './electron/runtime-config';

export type ConnectionCheckCode =
  | 'ok'
  | 'not_configured'
  | 'invalid_url'
  | 'dns'
  | 'timeout'
  | 'http_status'
  | 'version_mismatch'
  | 'invalid_response'
  | 'unreachable'
  | 'network_error';

export interface ConnectionCheckResult {
  ok: boolean;
  code: ConnectionCheckCode;
  url: string;
  status?: number;
  latencyMs?: number;
  message: string;
  serverVersion?: string;
  release?: { tag?: string; commit?: string };
}

function connectionErrorMessage(code: ConnectionCheckCode, status?: number): string {
  switch (code) {
    case 'not_configured': return '尚未配置服务器地址。';
    case 'invalid_url': return '服务器地址格式不正确，请填写 http(s)://主机:端口。';
    case 'dns': return '找不到服务器主机名，请检查 DNS、主机名或局域网连接。';
    case 'timeout': return '连接超时，请确认服务器已启动、防火墙允许访问且端口正确。';
    case 'http_status': return `服务器返回 HTTP ${status ?? '错误'}，请确认地址指向 Vaysen Pilot 后端。`;
    case 'version_mismatch': return '服务器版本与桌面客户端不兼容，请让客户端和后端保持同一发布版本。';
    case 'invalid_response': return '服务器已响应，但健康检查格式不正确，可能连接到了错误的服务。';
    case 'unreachable': return '无法连接服务器，请检查服务器进程、IP 地址和局域网连通性。';
    case 'network_error': return '网络连接失败，请检查网卡、VPN/ZeroTier 和服务器状态。';
    default: return '连接失败，请检查服务器地址后重试。';
  }
}

function releaseVersionFromHealth(payload: any): string | undefined {
  const value = payload?.version
    ?? payload?.serverVersion
    ?? payload?.release?.version;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isHealthyPayload(payload: any): boolean {
  return payload?.status === 'ok' || payload?.healthy === true;
}

export async function checkWebApiConnection(apiBaseUrl: string): Promise<ConnectionCheckResult> {
  const startedAt = Date.now();
  const value = apiBaseUrl.trim();
  const invalid = validateRuntimeApiBaseUrl(value);
  if (invalid) return { ok: false, code: 'invalid_url', url: value, latencyMs: 0, message: invalid };
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(healthUrlForApiBase(value), {
      method: 'GET',
      headers: { accept: 'application/json' },
      cache: 'no-store',
      signal: controller.signal,
    });
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      return { ok: false, code: 'http_status', url: value, status: response.status, latencyMs, message: connectionErrorMessage('http_status', response.status) };
    }
    let payload: any;
    try {
      payload = await response.json();
    } catch {
      return { ok: false, code: 'invalid_response', url: value, status: response.status, latencyMs, message: connectionErrorMessage('invalid_response', response.status) };
    }
    if (!isHealthyPayload(payload)) {
      return { ok: false, code: 'invalid_response', url: value, status: response.status, latencyMs, message: connectionErrorMessage('invalid_response', response.status) };
    }
    return {
      ok: true,
      code: 'ok',
      url: value,
      status: response.status,
      latencyMs,
      serverVersion: releaseVersionFromHealth(payload),
      release: payload?.release,
      message: '服务器连接正常。',
    };
  } catch (error: any) {
    const code = error?.name === 'AbortError' ? 'timeout' : 'unreachable';
    return { ok: false, code, url: value, latencyMs: Date.now() - startedAt, message: connectionErrorMessage(code) };
  } finally {
    window.clearTimeout(timer);
  }
}
