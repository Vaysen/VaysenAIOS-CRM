import api from '@/lib/api';
import {
  ASSISTANT_RUNTIME_STATUSES,
  WECHAT_OWNER_CHANNEL_STATUSES,
  type AssistantCapabilityStatus,
  type AssistantRuntimeSnapshot,
} from '@/types/assistant-runtime';

const CAPABILITY_STATUSES = new Set<AssistantCapabilityStatus>([
  'ENABLED',
  'APPROVAL_REQUIRED',
  'DISABLED',
]);

const FORBIDDEN_KEYS = new Set([
  'qr',
  'qrcode',
  'qrpayload',
  'token',
  'gatewaytoken',
  'gatewayurl',
  'credential',
  'credentials',
  'secret',
  'command',
  'servercommand',
  'path',
  'filepath',
  'wechatid',
  'rawwechatid',
  'accountid',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]) {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function containsForbiddenKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenKey);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, nested]) => (
    FORBIDDEN_KEYS.has(key.replace(/[-_]/g, '').toLowerCase()) || containsForbiddenKey(nested)
  ));
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function isNullableIsoDate(value: unknown): value is string | null {
  return value === null || isIsoDate(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

export function parseAssistantRuntimeSnapshot(value: unknown): AssistantRuntimeSnapshot {
  if (!isRecord(value) || containsForbiddenKey(value)) {
    throw new Error('AI 执行内核运行状态格式无效，已停止展示');
  }
  if (!hasOnlyKeys(value, [
    'schemaVersion',
    'observedAt',
    'runtime',
    'wechatOwnerChannel',
    'permissions',
    'capabilities',
  ])) {
    throw new Error('AI 执行内核运行状态包含未审核字段，已停止展示');
  }

  const runtime = value.runtime;
  const channel = value.wechatOwnerChannel;
  const permissions = value.permissions;
  const capabilities = value.capabilities;
  if (
    value.schemaVersion !== 1
    || !isIsoDate(value.observedAt)
    || !isRecord(runtime)
    || !isRecord(channel)
    || !isRecord(permissions)
    || !Array.isArray(capabilities)
  ) {
    throw new Error('AI 执行内核运行状态格式无效，已停止展示');
  }

  if (
    !hasOnlyKeys(runtime, [
      'engine',
      'release',
      'status',
      'gatewayReady',
      'adapterReady',
      'modelReady',
      'lastHeartbeatAt',
      'errorCode',
    ])
    || runtime.engine !== 'openclaw'
    || typeof runtime.release !== 'string'
    || !ASSISTANT_RUNTIME_STATUSES.includes(runtime.status as never)
    || typeof runtime.gatewayReady !== 'boolean'
    || typeof runtime.adapterReady !== 'boolean'
    || typeof runtime.modelReady !== 'boolean'
    || !isNullableIsoDate(runtime.lastHeartbeatAt)
    || !isNullableString(runtime.errorCode)
  ) {
    throw new Error('OpenClaw 执行内核状态格式无效，已停止展示');
  }

  if (
    !hasOnlyKeys(channel, [
      'status',
      'pluginReady',
      'pairingExpiresAt',
      'binding',
      'errorCode',
    ])
    || !WECHAT_OWNER_CHANNEL_STATUSES.includes(channel.status as never)
    || typeof channel.pluginReady !== 'boolean'
    || (channel.pairingExpiresAt !== undefined && !isNullableIsoDate(channel.pairingExpiresAt))
    || (channel.errorCode !== undefined && !isNullableString(channel.errorCode))
  ) {
    throw new Error('负责人微信连接状态格式无效，已停止展示');
  }

  if (channel.binding !== undefined) {
    const binding = channel.binding;
    if (
      !isRecord(binding)
      || !hasOnlyKeys(binding, ['displayName', 'maskedAccount', 'boundAt', 'lastSeenAt'])
      || typeof binding.displayName !== 'string'
      || typeof binding.maskedAccount !== 'string'
      || !isIsoDate(binding.boundAt)
      || !isNullableIsoDate(binding.lastSeenAt)
      || !binding.maskedAccount.includes('*')
    ) {
      throw new Error('负责人微信绑定信息未按脱敏契约返回，已停止展示');
    }
  }

  if (
    !hasOnlyKeys(permissions, [
      'canUseAssistant',
      'canIssueWechatCommands',
      'canAdminApprove',
      'canManageChannel',
    ])
    || Object.values(permissions).some((permission) => typeof permission !== 'boolean')
  ) {
    throw new Error('AI 业务助理权限状态格式无效，已停止展示');
  }

  for (const capability of capabilities) {
    if (
      !isRecord(capability)
      || !hasOnlyKeys(capability, ['id', 'status'])
      || typeof capability.id !== 'string'
      || !CAPABILITY_STATUSES.has(capability.status as AssistantCapabilityStatus)
    ) {
      throw new Error('AI 业务助理能力状态格式无效，已停止展示');
    }
  }

  return value as unknown as AssistantRuntimeSnapshot;
}

export async function getAssistantRuntime(
  companyId: string,
  signal?: AbortSignal,
): Promise<AssistantRuntimeSnapshot> {
  if (!companyId) throw new Error('未选择当前公司，无法读取 AI 执行内核状态');
  const response = await api.get<unknown>('/agent-runs/assistant/runtime', {
    params: { companyId },
    signal,
  });
  return parseAssistantRuntimeSnapshot(response.data);
}

export interface WechatPairingStartResult {
  pairingId: string;
  status: 'WAITING_SCAN' | 'AUTHENTICATING' | 'CONNECTED_PENDING_MESSAGE';
  qrDataUrl: string | null;
  expiresAt: string;
}

export interface WechatPairingWaitResult {
  pairingId: string;
  status: 'WAITING_SCAN' | 'AUTHENTICATING' | 'CONNECTED_PENDING_MESSAGE' | 'EXPIRED';
  expiresAt: string;
}

function assertPairingId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/i.test(value)) {
    throw new Error('微信扫码会话编号无效');
  }
}

export async function startWechatOwnerPairing(
  companyId: string,
): Promise<WechatPairingStartResult> {
  const response = await api.post<unknown>('/agent-runs/assistant/wechat-owner/pairing/start', {
    companyId,
  });
  const value = response.data;
  if (
    !isRecord(value)
    || containsForbiddenKey(value)
    || !hasOnlyKeys(value, ['pairingId', 'status', 'qrDataUrl', 'expiresAt'])
  ) throw new Error('微信扫码入口未返回有效数据');
  assertPairingId(value.pairingId);
  const qrDataUrl = value.qrDataUrl;
  if (
    value.status !== 'WAITING_SCAN'
    && value.status !== 'AUTHENTICATING'
    && value.status !== 'CONNECTED_PENDING_MESSAGE'
  ) throw new Error('微信扫码状态无效');
  if (
    qrDataUrl !== null
    && (typeof qrDataUrl !== 'string'
      || !/^data:image\/(?:png|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(qrDataUrl)
      || qrDataUrl.length > 900_000)
  ) throw new Error('微信二维码格式无效');
  if (!isIsoDate(value.expiresAt)) throw new Error('微信二维码有效期无效');
  return value as unknown as WechatPairingStartResult;
}

export async function waitWechatOwnerPairing(
  companyId: string,
  pairingId: string,
): Promise<WechatPairingWaitResult> {
  assertPairingId(pairingId);
  const response = await api.post<unknown>('/agent-runs/assistant/wechat-owner/pairing/wait', {
    companyId,
    pairingId,
  });
  const value = response.data;
  if (
    !isRecord(value)
    || containsForbiddenKey(value)
    || !hasOnlyKeys(value, ['pairingId', 'status', 'expiresAt'])
  ) throw new Error('微信扫码状态未返回有效数据');
  assertPairingId(value.pairingId);
  if (!['WAITING_SCAN', 'AUTHENTICATING', 'CONNECTED_PENDING_MESSAGE', 'EXPIRED'].includes(String(value.status))) {
    throw new Error('微信扫码状态无效');
  }
  if (!isIsoDate(value.expiresAt)) throw new Error('微信扫码有效期无效');
  return value as unknown as WechatPairingWaitResult;
}
