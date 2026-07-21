/**
 * 运行时配置（解耦部署方的真实局域网地址）
 *
 * TASK-111 v1.1 红线 5 复审后：将 API 与 updateFeedUrl 的校验策略**完全分离**。
 *
 * 策略 A（API）：公网必须 HTTPS；ZeroTier/RFC1918 私网无论 HTTP 或 HTTPS，
 *   都必须与 `APPROVED_ZEROTIER_API_ORIGINS` 的精确 origin 匹配。
 *   localhost、loopback 始终拒绝，allowlist 也不能放行。
 *
 * 策略 B（updateFeedUrl）：局域网发行版默认关闭自动更新；只有显式启用时才要求
 *   公网 HTTPS feed。API 校验与更新源校验互不连带。
 *
 * 凭据仍走 safeStorage，不在本文件落盘。
 *
 * 精度说明（红线 5）：使用**精确 origin**（scheme://host[:port]）作为 allowlist 单元，
 * 而非仅 host——避免“批准一个私网主机后放行同 IP 的任意端口”。
 *
 * 本模块为惰性读取（函数调用时才读 store），导入时不触碰 fs/electron，
 * 以便单测复用（electron-store 已被测试 setup 内存 mock）。
 */

import Store from 'electron-store';

export interface RuntimeConfig {
  /** 后端 API 基础地址，如 http(s)://host:port/api */
  apiBaseUrl: string;
  /** 自动更新 feed 地址（generic provider 的 latest.yml 所在目录） */
  updateFeedUrl: string;
}

export interface RuntimeConfigIssue {
  field: 'apiBaseUrl' | 'updateFeedUrl';
  value: string;
  reason: string;
}

export interface RuntimeConfigStatus {
  valid: boolean;
  /** 始终返回原始候选值，配置页可据此修复历史脏值。 */
  config: RuntimeConfig;
  errors: RuntimeConfigIssue[];
}

const CONFIG_STORE_NAME = 'runtime-config';
const CONFIG_KEY = 'config';

/** 开源演示用私网入口；部署时必须通过配置页或 API_BASE_URL 替换。 */
export const DEFAULT_API_BASE_URL = 'http://10.0.0.2/api';

/** 未批准真实发布源前保持空值，自动更新器保持禁用。 */
export const DEFAULT_UPDATE_FEED_URL = '';

const DEFAULTS: RuntimeConfig = {
  apiBaseUrl: DEFAULT_API_BASE_URL,
  updateFeedUrl: DEFAULT_UPDATE_FEED_URL,
};

/** 内置批准项仅包含无真实归属的开源演示入口，仍按精确 origin 校验。 */
const BUILTIN_LAN_API_ORIGINS = new Set(['http://10.0.0.2']);

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function parseIpv4(hostname: string): number[] | null {
  const parts = hostname.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return null;
  const values = parts.map(Number);
  return values.some((value) => value > 255) ? null : values;
}

function mappedIpv4(hostname: string): string | null {
  const dotted = hostname.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (dotted) return dotted[1];
  const hex = hostname.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (!hex) return null;
  const high = Number.parseInt(hex[1], 16);
  const low = Number.parseInt(hex[2], 16);
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

function isLocalHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (normalized === 'localhost' || normalized === '0.0.0.0' || normalized === '::1'
    || normalized.endsWith('.localhost')) return true;
  const mapped = mappedIpv4(normalized);
  if (mapped) return isLocalHostname(mapped);
  const ipv4 = parseIpv4(normalized);
  return Boolean(ipv4 && ipv4[0] === 127);
}

function isPrivateHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  if (isLocalHostname(normalized)) return true;
  const mapped = mappedIpv4(normalized);
  if (mapped) return isPrivateHostname(mapped);
  const ipv4 = parseIpv4(normalized);
  if (ipv4) {
    const [a, b] = ipv4;
    return a === 10 || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (/^(?:fc|fd)[0-9a-f:]*$/i.test(normalized) || /^fe[89ab][0-9a-f:]*$/i.test(normalized)) return true;
  return !normalized.includes('.') || normalized.endsWith('.local') || normalized.endsWith('.lan')
    || normalized.endsWith('.internal') || normalized.endsWith('.home');
}

/** 解析 APPROVED_ZEROTIER_API_ORIGINS，逗号分隔；trim；空字符串丢弃。 */
function parseApprovedOrigins(): Set<string> {
  const raw = process.env.APPROVED_ZEROTIER_API_ORIGINS || '';
  const origins = new Set<string>(BUILTIN_LAN_API_ORIGINS);
  for (const entry of raw.split(',')) {
    const value = entry.trim();
    if (!value) continue;
    try {
      const parsed = new URL(value);
      if (!['http:', 'https:'].includes(parsed.protocol)) continue;
      if (parsed.username || parsed.password || parsed.search || parsed.hash) continue;
      if (parsed.pathname !== '/' && parsed.pathname !== '') continue;
      origins.add(parsed.origin);
    } catch {
      // 非法条目忽略，绝不扩大权限。
    }
  }
  return origins;
}

/**
 * 局域网安装包采用人工覆盖安装，自动更新默认关闭。
 * 仅在显式设置 ELECTRON_UPDATER_ENABLED=true/1/yes/on 时启用。
 */
export function isAutoUpdateEnabled(): boolean {
  const value = (process.env.ELECTRON_UPDATER_ENABLED || '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(value);
}

/** 解析 URL → origin（scheme://host:port，含显式默认端口） */
function getOrigin(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    // URL.origin 已含 scheme + host + port（https 用 443 时显式 443）；统一
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * 校验 API URL（策略 A）。
 *
 * 规则：
 *   - 非 http(s) 协议 → 拒绝
 *   - 公网 HTTPS → 通过；公网 HTTP → 拒绝
 *   - ZeroTier/RFC1918 私网 → HTTP/HTTPS 均须精确命中 allowlist
 *   - localhost/loopback → 始终拒绝
 *   - URL 含 userinfo、query 或 fragment → 拒绝
 */
export function validateApiUrl(url: unknown): string | null {
  if (typeof url !== 'string' || !url.trim()) return 'URL 必须为非空字符串';
  const trimmed = url.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return `URL 解析失败: ${trimmed}`;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `URL 协议必须为 http(s)，实际为 ${parsed.protocol}`;
  }
  if (parsed.username || parsed.password) {
    return `URL 不应包含 userinfo: ${trimmed}`;
  }
  if (parsed.search || parsed.hash) {
    return `API 基础地址不应包含 query 或 fragment: ${trimmed}`;
  }
  if (isLocalHostname(parsed.hostname)) {
    return `localhost/loopback 不允许用于发布 API: ${parsed.hostname}`;
  }
  const isPrivate = isPrivateHostname(parsed.hostname);

  // 策略：HTTPS 不再"无条件通过"。
  //   - 公网 HTTPS：通过（HTTPS 仅保证传输加密，跨网信任由公网 CA 体系承担）
  //   - 私网/本机 HTTPS：必须 origin 精确命中 APPROVED_ZEROTIER_API_ORIGINS
  //     （v1.2 复审红线 #4 修正："HTTPS 即可信"的例外完全删除）
  //   - 公网 HTTP：拒绝（必须 HTTPS）
  //   - 私网 HTTP：必须 origin 精确命中 allowlist
  if (isPrivate) {
    // 私网：必须 origin 命中 allowlist（无论 HTTP 还是 HTTPS）
    const origin = getOrigin(trimmed);
    if (!origin) return `URL 无法派生 origin: ${trimmed}`;
    const allowed = parseApprovedOrigins();
    if (!allowed.has(origin)) {
      return `私网 API origin 未在 APPROVED_ZEROTIER_API_ORIGINS 中: ${origin}（HTTPS 也不能绕过 allowlist）`;
    }
    return null;
  }
  // 公网 HTTP 拒绝；HTTPS 通过
  if (parsed.protocol === 'http:') {
    return `公网 API 必须使用 HTTPS: ${trimmed}`;
  }
  return null;
}

/**
 * 校验 updateFeedUrl（策略 B — 严格 HTTPS）。
 *
 * 规则：
 *   - 必须 HTTPS
 *   - 拒绝 localhost / 127. / 10. / 192.168. / 172.16-31. / ::1
 *   - 不允许 userinfo
 *   - 不允许 file: / data: / ftp:
 */
export function validateUpdateFeedUrl(url: unknown): string | null {
  if (typeof url !== 'string' || !url.trim()) return 'URL 必须为非空字符串';
  const trimmed = url.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return `URL 解析失败: ${trimmed}`;
  }
  if (parsed.protocol !== 'https:') {
    return `updateFeedUrl 必须使用 HTTPS: ${trimmed}（实际 ${parsed.protocol}）`;
  }
  if (parsed.username || parsed.password) {
    return `updateFeedUrl 不应包含 userinfo: ${trimmed}`;
  }
  if (isPrivateHostname(parsed.hostname)) {
    return `updateFeedUrl 不允许指向私网/本机: ${trimmed}`;
  }
  return null;
}

let store: Store<{ config: RuntimeConfig }> | null = null;

function getStore(): Store<{ config: RuntimeConfig }> {
  if (!store) {
    store = new Store<{ config: RuntimeConfig }>({
      name: CONFIG_STORE_NAME,
      defaults: { config: { ...DEFAULTS } },
    });
  }
  return store;
}

/** 重置内存缓存（仅测试用）。 */
export function resetRuntimeConfigCache(): void {
  store = null;
}

/**
 * v1.2b 复审红线 #5：合并出最终配置 + 跑严格校验。
 *
 * 优先级：环境变量 > 持久化配置 > 经过精确 origin 批准的 ZeroTier 默认值。
 * API 候选值始终严格校验，非法值抛 RuntimeConfigError；更新源由独立读取函数校验，
 * 因此“自动更新关闭/未配置”不会再连带禁用局域网业务 API。
 */
export class RuntimeConfigError extends Error {
  readonly field: 'apiBaseUrl' | 'updateFeedUrl';
  readonly value: string;
  readonly reason: string;
  constructor(field: 'apiBaseUrl' | 'updateFeedUrl', value: string, reason: string) {
    super(`[${field}] ${reason}（值: ${value}）`);
    this.name = 'RuntimeConfigError';
    this.field = field;
    this.value = value;
    this.reason = reason;
  }
}

function _pickField(envKey: string, persistedValue: string, defaultValue: string): string {
  // 优先级：env > persisted > default
  return (
    process.env[envKey]?.trim() ||
    persistedValue ||
    defaultValue
  );
}

function resolveRuntimeConfigRaw(): RuntimeConfig {
  const persisted = getStore().get(CONFIG_KEY) || { ...DEFAULTS };
  return {
    apiBaseUrl: _pickField('API_BASE_URL', persisted.apiBaseUrl, DEFAULT_API_BASE_URL),
    updateFeedUrl: _pickField(
      'ELECTRON_UPDATER_URL',
      persisted.updateFeedUrl,
      DEFAULT_UPDATE_FEED_URL
    ),
  };
}

export function loadRuntimeConfig(): RuntimeConfig {
  const { apiBaseUrl, updateFeedUrl } = resolveRuntimeConfigRaw();

  // API 与更新源完全解耦：业务 API 可用性不得被空更新源连带禁用。
  const apiErr = validateApiUrl(apiBaseUrl);
  if (apiErr) throw new RuntimeConfigError('apiBaseUrl', apiBaseUrl, apiErr);

  return { apiBaseUrl, updateFeedUrl };
}

/**
 * 验证（不抛）版本：用于配置页显示当前值（容错渲染）。
 * 仍返回错误字符串（不抛），但**不**fallback 到 DEFAULT。
 */
export function tryLoadRuntimeConfig(): RuntimeConfigStatus {
  const config = resolveRuntimeConfigRaw();
  const { apiBaseUrl, updateFeedUrl } = config;
  const errors: RuntimeConfigIssue[] = [];
  const apiErr = validateApiUrl(apiBaseUrl);
  if (apiErr) errors.push({ field: 'apiBaseUrl', value: apiBaseUrl, reason: apiErr });
  // 自动更新关闭时空 feed 是合法状态；若用户填了值，仍严格校验并展示错误。
  if (updateFeedUrl || isAutoUpdateEnabled()) {
    const updErr = validateUpdateFeedUrl(updateFeedUrl);
    if (updErr) errors.push({ field: 'updateFeedUrl', value: updateFeedUrl, reason: updErr });
  }
  return { valid: errors.length === 0, config, errors };
}

/**
 * API 请求调用：取已校验的 apiBaseUrl，失败抛 RuntimeConfigError。
 * （v1.2 之前：getApiBaseUrl() 不校验，危险旧值会被使用 → API 发往私网/HTTP）
 */
export function getValidatedApiBaseUrl(): string {
  return loadRuntimeConfig().apiBaseUrl;
}

/**
 * 更新器调用：取已校验的 updateFeedUrl，失败抛 RuntimeConfigError。
 * （v1.2 之前：getUpdateFeedUrl() 不校验 → 更新器指向私网/HTTP）
 */
export function getValidatedUpdateFeedUrl(): string {
  const updateFeedUrl = resolveRuntimeConfigRaw().updateFeedUrl;
  const err = validateUpdateFeedUrl(updateFeedUrl);
  if (err) throw new RuntimeConfigError('updateFeedUrl', updateFeedUrl, err);
  return updateFeedUrl;
}

/**
 * @deprecated 使用 getValidatedApiBaseUrl() 替代。本函数保留仅为兼容 v1.2 之前
 * 调 getApiBaseUrl() 不校验的代码路径；v1.2b 起**禁止**在生产路径使用
 * （必须改为 getValidatedApiBaseUrl() 触发 fail-closed 校验）。
 * 单测用，生产 API/更新器禁止调用。
 *
 * 本函数仍走 loadRuntimeConfig()，会触发 API 严格校验。
 */
export function getApiBaseUrl(): string {
  return loadRuntimeConfig().apiBaseUrl;
}

/**
 * @deprecated 使用 getValidatedUpdateFeedUrl() 替代。
 * v1.2b 起本函数也走 loadRuntimeConfig()，会触发严格校验。
 */
export function getUpdateFeedUrl(): string {
  return getValidatedUpdateFeedUrl();
}

/**
 * 持久化写入（供 app:config-set IPC 调用）。返回合并后的结果。
 *
 * 校验语义（TASK-111 v1.1 红线 2 + 红线 5 复审后）：
 *   - apiBaseUrl → validateApiUrl（策略 A）
 *   - updateFeedUrl → validateUpdateFeedUrl（策略 B 严格 HTTPS）
 *   - 非空新值才校验，非法抛 Error 由 IPC handler 转为 { success: false, error }
 *   - 空字符串/undefined 表示"保留当前值"，跳过校验
 *   - 校验通过才落盘并返回新值；否则配置完全不变
 */
export function saveRuntimeConfig(partial: Partial<RuntimeConfig>): RuntimeConfig {
  // 不能先调用严格 load：历史脏值正是配置页需要修复的对象。
  const current = resolveRuntimeConfigRaw();
  const next: RuntimeConfig = { ...current };

  if (partial.apiBaseUrl !== undefined) {
    const trimmed = partial.apiBaseUrl.trim();
    if (trimmed) {
      const err = validateApiUrl(trimmed);
      if (err) throw new Error(`apiBaseUrl ${err}`);
      next.apiBaseUrl = trimmed;
    }
  }

  if (partial.updateFeedUrl !== undefined) {
    const trimmed = partial.updateFeedUrl.trim();
    if (trimmed) {
      const err = validateUpdateFeedUrl(trimmed);
      if (err) throw new Error(`updateFeedUrl ${err}`);
    }
    // 允许清空 feed，从而明确恢复“局域网人工更新”模式。
    next.updateFeedUrl = trimmed;
  }

  getStore().set(CONFIG_KEY, next);
  return next;
}
