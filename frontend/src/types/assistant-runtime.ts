export const ASSISTANT_RUNTIME_STATUSES = [
  'DISABLED',
  'STARTING',
  'READY',
  'DEGRADED',
  'OFFLINE',
] as const;

export type AssistantRuntimeStatus = (typeof ASSISTANT_RUNTIME_STATUSES)[number];

export const WECHAT_OWNER_CHANNEL_STATUSES = [
  'NOT_INSTALLED',
  'UNBOUND',
  'PAIRING',
  'WAITING_SCAN',
  'AUTHENTICATING',
  'CONNECTED',
  'DISCONNECTED',
  'EXPIRED',
  'ERROR',
] as const;

export type WechatOwnerChannelStatus = (typeof WECHAT_OWNER_CHANNEL_STATUSES)[number];

export type AssistantCapabilityStatus = 'ENABLED' | 'APPROVAL_REQUIRED' | 'DISABLED';

export interface AssistantRuntimeSnapshot {
  schemaVersion: 1;
  observedAt: string;
  runtime: {
    engine: 'openclaw';
    release: string;
    status: AssistantRuntimeStatus;
    gatewayReady: boolean;
    adapterReady: boolean;
    modelReady: boolean;
    lastHeartbeatAt: string | null;
    errorCode: string | null;
  };
  wechatOwnerChannel: {
    status: WechatOwnerChannelStatus;
    pluginReady: boolean;
    pairingExpiresAt?: string | null;
    binding?: {
      displayName: string;
      maskedAccount: string;
      boundAt: string;
      lastSeenAt: string | null;
    };
    errorCode?: string | null;
  };
  permissions: {
    canUseAssistant: boolean;
    canIssueWechatCommands: boolean;
    canAdminApprove: boolean;
    canManageChannel: boolean;
  };
  capabilities: Array<{
    id: string;
    status: AssistantCapabilityStatus;
  }>;
}

export const FAST_WECHAT_OWNER_CHANNEL_STATUSES = new Set<WechatOwnerChannelStatus>([
  'PAIRING',
  'WAITING_SCAN',
  'AUTHENTICATING',
]);
