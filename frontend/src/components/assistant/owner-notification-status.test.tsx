import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '@/store/authStore';
import { getOwnerNotificationStatus } from '@/lib/messaging-control-api';
import { OwnerNotificationStatusPill } from './owner-notification-status';

vi.mock('@/lib/messaging-control-api', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/messaging-control-api')>();
  return {
    ...original,
    getOwnerNotificationStatus: vi.fn(),
  };
});

const mockedGetOwnerNotificationStatus = vi.mocked(getOwnerNotificationStatus);

describe('OwnerNotificationStatusPill tenant scope', () => {
  beforeEach(() => {
    mockedGetOwnerNotificationStatus.mockReset();
    act(() => {
      useAuthStore.setState({ user: null, activeCompanyId: null });
    });
  });

  it('does not call the tenant-protected endpoint until a company is resolved', () => {
    render(<OwnerNotificationStatusPill />);

    expect(screen.getByText('等待公司信息')).toBeInTheDocument();
    expect(mockedGetOwnerNotificationStatus).not.toHaveBeenCalled();
  });

  it('prefers the active company and sends it to the status endpoint', async () => {
    mockedGetOwnerNotificationStatus.mockResolvedValue({
      available: true,
      enabled: true,
      channel: 'openclaw-weixin',
      channelStatus: 'CONNECTED',
      counts: { pending: 0, sending: 0, sent: 2, failed: 0 },
      lastDelivery: null,
    });
    act(() => {
      useAuthStore.setState({
        activeCompanyId: 'company-active',
        user: {
          id: 'user-1',
          email: 'admin@example.com',
          firstName: 'Admin',
          lastName: 'User',
          companies: [{
            id: 'company-first',
            name: 'First company',
            slug: 'first-company',
            role: 'company_admin',
            isDefault: true,
          }],
        },
      });
    });

    render(<OwnerNotificationStatusPill />);

    await waitFor(() => {
      expect(mockedGetOwnerNotificationStatus).toHaveBeenCalledWith('company-active');
    });
    expect(await screen.findByText('微信新消息通知在线')).toBeInTheDocument();
  });

  it('falls back to the first user company when no active company is set', async () => {
    mockedGetOwnerNotificationStatus.mockResolvedValue({
      available: true,
      enabled: true,
      channel: 'openclaw-weixin',
      channelStatus: 'UNBOUND',
      counts: { pending: 0, sending: 0, sent: 0, failed: 0 },
      lastDelivery: null,
    });
    act(() => {
      useAuthStore.setState({
        activeCompanyId: null,
        user: {
          id: 'user-1',
          email: 'admin@example.com',
          firstName: 'Admin',
          lastName: 'User',
          companies: [{
            id: 'company-first',
            name: 'First company',
            slug: 'first-company',
            role: 'company_admin',
            isDefault: true,
          }],
        },
      });
    });

    render(<OwnerNotificationStatusPill />);

    await waitFor(() => {
      expect(mockedGetOwnerNotificationStatus).toHaveBeenCalledWith('company-first');
    });
    expect(await screen.findByText('微信通知未绑定')).toBeInTheDocument();
  });
});
