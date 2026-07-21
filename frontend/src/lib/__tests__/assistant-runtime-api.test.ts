import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@/lib/api', () => ({ default: mocks }));

import {
  getAssistantRuntime,
  parseAssistantRuntimeSnapshot,
  startWechatOwnerPairing,
  waitWechatOwnerPairing,
} from '@/lib/assistant-runtime-api';

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    observedAt: '2026-07-14T14:00:00.000Z',
    runtime: {
      engine: 'openclaw',
      release: '2026.7.1',
      status: 'READY',
      gatewayReady: true,
      adapterReady: true,
      modelReady: true,
      lastHeartbeatAt: '2026-07-14T13:59:55.000Z',
      errorCode: null,
    },
    wechatOwnerChannel: {
      status: 'CONNECTED',
      pluginReady: true,
      pairingExpiresAt: null,
      binding: {
        displayName: '茶茶',
        maskedAccount: 'wxid_***821',
        boundAt: '2026-07-14T13:30:00.000Z',
        lastSeenAt: '2026-07-14T13:59:50.000Z',
      },
      errorCode: null,
    },
    permissions: {
      canUseAssistant: true,
      canIssueWechatCommands: true,
      canAdminApprove: true,
      canManageChannel: true,
    },
    capabilities: [
      { id: 'crm.work_brief', status: 'ENABLED' },
      { id: 'crm.prepare_quote_delivery', status: 'APPROVAL_REQUIRED' },
      { id: 'external.confirmed_send', status: 'ENABLED' },
    ],
    ...overrides,
  };
}

describe('assistant runtime API contract', () => {
  beforeEach(() => {
    mocks.get.mockReset();
    mocks.post.mockReset();
  });

  it('starts and polls an authenticated in-page WeChat QR session', async () => {
    const qrDataUrl = `data:image/png;base64,${'A'.repeat(128)}`;
    mocks.post
      .mockResolvedValueOnce({
        data: {
          pairingId: '11111111-1111-4111-8111-111111111111',
          status: 'WAITING_SCAN',
          qrDataUrl,
          expiresAt: '2026-07-17T12:02:00.000Z',
        },
      })
      .mockResolvedValueOnce({
        data: {
          pairingId: '11111111-1111-4111-8111-111111111111',
          status: 'CONNECTED_PENDING_MESSAGE',
          expiresAt: '2026-07-17T12:10:00.000Z',
        },
      });

    await expect(startWechatOwnerPairing('company-1')).resolves.toMatchObject({ qrDataUrl });
    await expect(waitWechatOwnerPairing(
      'company-1',
      '11111111-1111-4111-8111-111111111111',
    )).resolves.toMatchObject({ status: 'CONNECTED_PENDING_MESSAGE' });
    expect(mocks.post).toHaveBeenNthCalledWith(1, '/agent-runs/assistant/wechat-owner/pairing/start', {
      companyId: 'company-1',
    });
    expect(mocks.post).toHaveBeenNthCalledWith(2, '/agent-runs/assistant/wechat-owner/pairing/wait', {
      companyId: 'company-1',
      pairingId: '11111111-1111-4111-8111-111111111111',
    });
  });

  it.each([
    ['start', { userId: 'raw-owner@im.wechat' }],
    ['start', { ownerPeerDigest: 'a'.repeat(64) }],
    ['wait', { accountId: 'raw-bot@im.bot' }],
    ['wait', { token: 'raw-token' }],
  ])('rejects an unexpected sensitive field in the pairing %s response', async (kind, extra) => {
    const base = kind === 'start'
      ? {
          pairingId: '11111111-1111-4111-8111-111111111111',
          status: 'WAITING_SCAN',
          qrDataUrl: `data:image/png;base64,${'A'.repeat(128)}`,
          expiresAt: '2026-07-17T12:02:00.000Z',
        }
      : {
          pairingId: '11111111-1111-4111-8111-111111111111',
          status: 'CONNECTED_PENDING_MESSAGE',
          expiresAt: '2026-07-17T12:10:00.000Z',
        };
    mocks.post.mockResolvedValue({ data: { ...base, ...extra } });

    const promise = kind === 'start'
      ? startWechatOwnerPairing('company-1')
      : waitWechatOwnerPairing('company-1', '11111111-1111-4111-8111-111111111111');
    await expect(promise).rejects.toThrow(/未返回有效数据/);
  });

  it('accepts the audited status contract and scopes the GET to the active company', async () => {
    const value = snapshot();
    mocks.get.mockResolvedValue({ data: value });
    const controller = new AbortController();

    await expect(getAssistantRuntime('company-1', controller.signal)).resolves.toEqual(value);
    expect(mocks.get).toHaveBeenCalledWith('/agent-runs/assistant/runtime', {
      params: { companyId: 'company-1' },
      signal: controller.signal,
    });
  });

  it('fails closed for unknown states or an unmasked owner identity', () => {
    const unknown = snapshot();
    (unknown.runtime as Record<string, unknown>).status = 'MAGIC';
    expect(() => parseAssistantRuntimeSnapshot(unknown)).toThrow(/状态格式无效/);

    const rawIdentity = snapshot();
    (rawIdentity.wechatOwnerChannel.binding as Record<string, unknown>).maskedAccount = 'wxid_complete';
    expect(() => parseAssistantRuntimeSnapshot(rawIdentity)).toThrow(/脱敏契约/);
  });

  it.each([
    ['gatewayToken', 'secret-value'],
    ['gatewayUrl', 'ws://internal.invalid'],
    ['qrCode', 'sensitive-pairing-material'],
    ['serverCommand', 'not-allowed'],
    ['filePath', '/not-allowed'],
  ])('rejects sensitive or operational field %s anywhere in the payload', (key, value) => {
    const unsafe = snapshot({ diagnostics: { [key]: value } });
    expect(() => parseAssistantRuntimeSnapshot(unsafe)).toThrow(/停止展示|未审核字段/);
  });

  it('requires an active company before making a request', async () => {
    await expect(getAssistantRuntime('')).rejects.toThrow('未选择当前公司');
    expect(mocks.get).not.toHaveBeenCalled();
  });
});
