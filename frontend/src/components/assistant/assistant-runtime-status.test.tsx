import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssistantRuntimeSnapshot } from '@/types/assistant-runtime';
import { AssistantRuntimeStrip } from './assistant-runtime-strip';
import { WechatOwnerChannelCard } from './wechat-owner-channel-card';
import { startWechatOwnerPairing } from '@/lib/assistant-runtime-api';

const COMPANY_ID = '11111111-1111-4111-8111-111111111111';

vi.mock('@/lib/assistant-runtime-api', () => ({
  startWechatOwnerPairing: vi.fn(),
  waitWechatOwnerPairing: vi.fn(),
}));

afterEach(() => vi.clearAllMocks());

function snapshot(
  channelStatus: AssistantRuntimeSnapshot['wechatOwnerChannel']['status'],
  canManageChannel = false,
): AssistantRuntimeSnapshot {
  return {
    schemaVersion: 1,
    observedAt: '2026-07-14T14:00:00.000Z',
    runtime: {
      engine: 'openclaw', release: '2026.7.1', status: 'READY', gatewayReady: true,
      adapterReady: true, modelReady: true, lastHeartbeatAt: '2026-07-14T13:59:55.000Z',
      errorCode: null,
    },
    wechatOwnerChannel: {
      status: channelStatus,
      pluginReady: channelStatus !== 'NOT_INSTALLED',
      pairingExpiresAt: channelStatus === 'WAITING_SCAN' ? '2026-07-14T14:05:00.000Z' : null,
      binding: channelStatus === 'CONNECTED' ? {
        displayName: '茶茶', maskedAccount: 'wxid_***821',
        boundAt: '2026-07-14T13:30:00.000Z', lastSeenAt: '2026-07-14T13:59:50.000Z',
      } : undefined,
      errorCode: channelStatus === 'DISCONNECTED' ? 'CHANNEL_HEARTBEAT_STALE' : null,
    },
    permissions: {
      canUseAssistant: true,
      canIssueWechatCommands: channelStatus === 'CONNECTED',
      canAdminApprove: true,
      canManageChannel,
    },
    capabilities: [
      { id: 'crm.work_brief', status: 'ENABLED' },
      { id: 'crm.prepare_quote_delivery', status: 'APPROVAL_REQUIRED' },
      { id: 'external.confirmed_send', status: 'ENABLED' },
    ],
  };
}

describe('assistant runtime status UI', () => {
  it('shows model, execution engine and disconnected owner channel as three distinct states', () => {
    render(<AssistantRuntimeStrip snapshot={snapshot('DISCONNECTED')} loading={false} error={null} />);
    expect(screen.getByTestId('assistant-model-status')).toHaveTextContent('OpenClaw 智谱链路可用');
    expect(screen.getByTestId('assistant-runtime-status')).toHaveTextContent('OpenClaw 执行在线');
    expect(screen.getByTestId('assistant-wechat-status')).toHaveTextContent('负责人微信已断线');
  });

  it('does not claim generation is available when the adapter is degraded', () => {
    const value = snapshot('CONNECTED');
    value.runtime.adapterReady = false;
    render(<AssistantRuntimeStrip snapshot={value} loading={false} error={null} />);
    expect(screen.getByTestId('assistant-model-status')).toHaveTextContent('OpenClaw 智谱链路未就绪');
  });

  it('prioritizes channel authorization and renders it as a muted state everywhere', () => {
    const value = snapshot('CONNECTED', false);
    value.wechatOwnerChannel.errorCode = 'CHANNEL_NOT_AUTHORIZED';

    const { rerender } = render(
      <AssistantRuntimeStrip snapshot={value} loading={false} error={null} />,
    );
    const status = screen.getByTestId('assistant-wechat-status');
    expect(status).toHaveTextContent('无权限查看负责人微信');
    expect(status.className).toContain('text-slate');

    rerender(
      <WechatOwnerChannelCard snapshot={value} loading={false} error={null} />,
    );
    expect(screen.getByText('无权限查看负责人微信', { selector: 'p' })).toHaveClass('text-slate-500');
    expect(screen.getByTestId('wechat-channel-not-authorized')).toHaveTextContent(
      '微信绑定信息仅负责人和通道管理员可见',
    );
    expect(screen.queryByText(/wxid_/)).not.toBeInTheDocument();
    expect(screen.queryByText(/身份已由后端确认/)).not.toBeInTheDocument();
  });

  it('shows the in-page scan state without leaking operational details', () => {
    render(
      <WechatOwnerChannelCard
        snapshot={snapshot('WAITING_SCAN', true)}
        loading={false}
        error={null}
      />,
    );
    expect(screen.getByText('请在当前页面扫描二维码')).toBeInTheDocument();
    expect(screen.getByText(/不写入浏览器存储或业务日志/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/gatewayToken|gatewayUrl|ws:\/\/|二维码内容/);
    expect(screen.queryByRole('img', { name: /二维码/ })).not.toBeInTheDocument();
  });

  it('uses backend permissions for channel guidance and labels approval-required capabilities', () => {
    const { rerender } = render(
      <WechatOwnerChannelCard snapshot={snapshot('UNBOUND', false)} loading={false} error={null} />,
    );
    expect(screen.getByText(/联系有通道管理权限的管理员/)).toBeInTheDocument();
    expect(screen.getByText('准备报价交付 · 需确认')).toBeInTheDocument();

    rerender(<WechatOwnerChannelCard companyId={COMPANY_ID} snapshot={snapshot('UNBOUND', true)} loading={false} error={null} />);
    expect(screen.getByText(/管理员可直接在当前页面生成二维码/)).toBeInTheDocument();
    expect(screen.getByTestId('wechat-binding-entry')).toHaveTextContent('负责人微信扫码绑定');
    expect(screen.getByRole('button', { name: '生成负责人微信二维码' })).toBeInTheDocument();
  });

  it('starts pairing and displays the QR code directly in the compact assistant', async () => {
    vi.mocked(startWechatOwnerPairing).mockResolvedValue({
      pairingId: '11111111-1111-4111-8111-111111111111',
      status: 'WAITING_SCAN',
      qrDataUrl: 'data:image/png;base64,Y29tcGFjdA==',
      expiresAt: '2026-07-14T14:05:00.000Z',
    });
    render(
      <WechatOwnerChannelCard
        companyId={COMPANY_ID}
        snapshot={snapshot('UNBOUND', true)}
        loading={false}
        error={null}
        compact
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '生成负责人微信二维码' }));
    const qr = await screen.findByTestId('wechat-owner-qr-code-compact');
    expect(qr).toHaveAttribute('src', 'data:image/png;base64,Y29tcGFjdA==');
  });

  it('starts in-page pairing and renders the backend QR code for the administrator', async () => {
    vi.mocked(startWechatOwnerPairing).mockResolvedValue({
      pairingId: '11111111-1111-4111-8111-111111111111',
      status: 'WAITING_SCAN',
      qrDataUrl: 'data:image/png;base64,aGVsbG8=',
      expiresAt: '2026-07-14T14:05:00.000Z',
    });
    render(
      <WechatOwnerChannelCard
        companyId={COMPANY_ID}
        snapshot={snapshot('UNBOUND', true)}
        loading={false}
        error={null}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '生成负责人微信二维码' }));
    const qr = await screen.findByRole('img', { name: '负责人微信登录二维码' });
    expect(qr).toHaveAttribute('src', 'data:image/png;base64,aGVsbG8=');
    expect(startWechatOwnerPairing).toHaveBeenCalledWith(COMPANY_ID);
  });

  it('renders every backend capability and makes confirmed sending explicit', () => {
    const value = snapshot('CONNECTED', true);
    value.capabilities = [
      { id: 'openclaw.crm_chat', status: 'ENABLED' },
      { id: 'crm.work_brief', status: 'ENABLED' },
      { id: 'crm.customer_search', status: 'ENABLED' },
      { id: 'crm.start_background_research', status: 'ENABLED' },
      { id: 'crm.prepare_quote_delivery', status: 'APPROVAL_REQUIRED' },
      { id: 'wechat.owner_control', status: 'ENABLED' },
      { id: 'external.confirmed_send', status: 'ENABLED' },
    ];

    render(<WechatOwnerChannelCard snapshot={value} loading={false} error={null} />);

    expect(screen.getByText('CRM 对话协作')).toBeInTheDocument();
    expect(screen.getByText('工作简报')).toBeInTheDocument();
    expect(screen.getByText('客户检索（只读）')).toBeInTheDocument();
    expect(screen.getByText('客户背调')).toBeInTheDocument();
    expect(screen.getByText('准备报价交付 · 需确认')).toBeInTheDocument();
    expect(screen.getByText('负责人微信受控操作')).toBeInTheDocument();
    expect(screen.getByText('单次确认外发')).toBeInTheDocument();
    expect(screen.getByText(/已启用主管执行模式/)).toBeInTheDocument();
    expect(screen.getByText(/当前操作者单次确认后真实发送/)).toBeInTheDocument();
  });

  it('refreshes status without exposing a pairing action', () => {
    const onRefresh = vi.fn();
    render(
      <WechatOwnerChannelCard
        snapshot={snapshot('CONNECTED', true)}
        loading={false}
        error={null}
        onRefresh={onRefresh}
      />,
    );
    expect(screen.getByText(/茶茶/)).toHaveTextContent('wxid_***821');
    fireEvent.click(screen.getByRole('button', { name: '刷新 AI 执行内核状态' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: /绑定|解绑|扫码/ })).not.toBeInTheDocument();
  });
});
