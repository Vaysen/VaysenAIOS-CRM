import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { CommunicationWorkbench } from '../communication-workbench';
import { getMockConversationDetail, mockConversations } from '../mock-data';

const conversationsUrl = '/communications/conversations';
let searchValues: Record<string, string | null> = {};

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => ({ get: (key: string) => searchValues[key] ?? null }),
}));

vi.mock('@/store/authStore', () => ({
  useAuthStore: () => ({
    user: { id: 'u1', firstName: 'Tea' },
    isLoading: false,
    error: null,
    clearError: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
  }),
}));

const apiGet = vi.fn();
vi.mock('@/lib/api', () => ({
  default: {
    get: (...args: any[]) => (vi.mocked((globalThis as any).__apiGet) as any)(...args),
    post: vi.fn(),
    patch: vi.fn(),
  },
}));

beforeEach(() => {
  (globalThis as any).__apiGet = apiGet;
  searchValues = {};
  apiGet.mockReset();
  apiGet.mockImplementation((url: string) =>
    Promise.resolve({ data: url.includes('conversations') ? { data: [] } : { data: { data: [] } } }),
  );
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function conversationsCalls() {
  return apiGet.mock.calls.filter((c: any[]) => String(c[0]).includes(conversationsUrl)).length;
}

describe('CommunicationWorkbench polling (T112-002)', () => {
  it('polls at 10s interval, not 2s', async () => {
    await act(async () => {
      render(<CommunicationWorkbench />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const initial = conversationsCalls();
    expect(initial).toBeGreaterThanOrEqual(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(conversationsCalls()).toBe(initial);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000);
    });
    expect(conversationsCalls()).toBe(initial + 1);
  });

  it('T112-005: pauses polling while the browser is offline', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
    await act(async () => {
      render(<CommunicationWorkbench />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const before = conversationsCalls();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });

    expect(screen.getByText(/网络已离线/)).toBeInTheDocument();
    expect(conversationsCalls()).toBe(before);
  });

  it('surfaces (logs) polling errors instead of silently swallowing them', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    apiGet.mockImplementation((url: string) => {
      if (String(url).includes(conversationsUrl)) {
        return Promise.reject(new Error('boom'));
      }
      return Promise.resolve({ data: { data: [] } });
    });

    await act(async () => {
      render(<CommunicationWorkbench />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // 轮询顶层 catch 现在记录错误（不再静默吞掉）
    expect(spy).toHaveBeenCalled();
    expect(
      spy.mock.calls.some((c) => String(c[0]).includes('[Poll')),
    ).toBe(true);
    spy.mockRestore();
  });

  it('opens customer details as a mobile drawer after selecting a conversation', async () => {
    const summary = mockConversations[0];
    apiGet.mockImplementation((url: string) => {
      if (String(url).includes('/communications/conversations/') && !String(url).includes('/messages')) {
        return Promise.resolve({ data: getMockConversationDetail(summary.id) });
      }
      if (String(url).includes(conversationsUrl)) {
        return Promise.resolve({ data: { data: [summary] } });
      }
      return Promise.resolve({ data: { data: [] } });
    });

    await act(async () => {
      render(<CommunicationWorkbench />);
      await vi.advanceTimersByTimeAsync(0);
    });

    fireEvent.click(screen.getByRole('button', { name: /Glow Beauty/ }));
    await act(async () => {
      await Promise.resolve();
    });

    fireEvent.click(screen.getByRole('button', { name: '打开客户资料抽屉' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole('dialog', { name: '客户资料' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: '关闭客户资料抽屉' })).toHaveLength(2);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '打开客户资料抽屉' }));
  });

  it('shows an actionable API error without injecting development conversations', async () => {
    apiGet.mockRejectedValue(new Error('offline'));

    await act(async () => {
      render(<CommunicationWorkbench />);
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(screen.queryByText(/Glow Beauty/)).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
  });

  it('consumes deep-link filters and selects only the requested conversation', async () => {
    const summary = {
      ...mockConversations[0],
      channel: 'whatsapp' as const,
      whatsappSessionId: 'provider-session-target',
      lead: { ...mockConversations[0].lead!, contactPhone: '+15550001111', whatsapp: '+15550001111' },
      contactPoint: { id: 'cp-target', type: 'whatsapp', originalValue: '+15550001111', normalizedValue: '+15550001111' },
    };
    const detail = { ...getMockConversationDetail(mockConversations[0].id)!, ...summary };
    searchValues = { leadId: summary.lead.id, phone: '+1 (555) 000-1111', channel: 'whatsapp', sessionId: 'provider-session-target' };
    apiGet.mockImplementation((url: string) => {
      if (String(url).includes('/communications/conversations/') && !String(url).includes('/messages')) {
        return Promise.resolve({ data: detail });
      }
      if (String(url).includes(conversationsUrl)) {
        return Promise.resolve({ data: { data: [summary] } });
      }
      return Promise.resolve({ data: { data: [] } });
    });

    await act(async () => {
      render(<CommunicationWorkbench />);
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
    });

    expect(screen.getByRole('button', { name: /Glow Beauty/ })).toBeInTheDocument();
    expect(apiGet.mock.calls.some(([url, options]) =>
      String(url).includes(conversationsUrl)
      && options?.params?.leadId === summary.lead.id
      && options?.params?.phone === '+1 (555) 000-1111'
      && options?.params?.channel === 'whatsapp',
    )).toBe(true);
    expect(apiGet.mock.calls.some(([url]) => String(url).endsWith(`/${summary.id}`))).toBe(true);
    expect(apiGet.mock.calls.some(([url]) => String(url).endsWith('/provider-session-target'))).toBe(false);
  });

  it('shows an honest empty state when the phone does not match the lead conversation', async () => {
    const summary = {
      ...mockConversations[0],
      channel: 'whatsapp' as const,
      lead: { ...mockConversations[0].lead!, contactPhone: '+15550001111', whatsapp: '+15550001111' },
      contactPoint: { id: 'cp-target', type: 'whatsapp', originalValue: '+15550001111', normalizedValue: '+15550001111' },
    };
    searchValues = { leadId: summary.lead.id, phone: '+15550009999', channel: 'whatsapp', sessionId: null };
    apiGet.mockImplementation((url: string) => {
      if (String(url).includes(conversationsUrl)) return Promise.resolve({ data: { data: [summary] } });
      return Promise.resolve({ data: { ...getMockConversationDetail(summary.id), ...summary } });
    });

    await act(async () => {
      render(<CommunicationWorkbench />);
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
    });

    expect(screen.getByRole('alert')).toHaveTextContent(/未找到匹配会话/);
    expect(screen.queryByRole('button', { name: /Glow Beauty/ })).not.toBeInTheDocument();
  });

  it('rejects a session detail that belongs to another lead, channel, or phone', async () => {
    const detail = {
      ...getMockConversationDetail(mockConversations[0].id)!,
      channel: 'whatsapp' as const,
      whatsappSessionId: 'session-other',
      lead: { ...mockConversations[0].lead!, id: 'lead-other', contactPhone: '+15550009999', whatsapp: '+15550009999' },
      contactPoint: { id: 'cp-other', type: 'whatsapp', originalValue: '+15550009999', normalizedValue: '+15550009999' },
    };
    searchValues = { leadId: 'lead-target', phone: '+15550001111', channel: 'whatsapp', sessionId: 'session-target' };
    apiGet.mockImplementation((url: string) => {
      if (String(url).includes('/communications/conversations/') && !String(url).includes('/messages')) {
        return Promise.resolve({ data: detail });
      }
      if (String(url).includes(conversationsUrl)) return Promise.resolve({ data: { data: [detail] } });
      return Promise.resolve({ data: { data: [] } });
    });

    await act(async () => {
      render(<CommunicationWorkbench />);
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
    });

    expect(screen.getByRole('alert')).toHaveTextContent(/未找到匹配会话/);
    expect(screen.queryByRole('button', { name: /Glow Beauty/ })).not.toBeInTheDocument();
  });

  it.each([
    ['leadId', { leadId: 'lead-1' }],
    ['phone', { phone: '+15550001111' }],
    ['channel', { channel: 'website_inquiry' }],
    ['sessionId', { sessionId: 'provider-session-target' }],
  ])('keeps a single valid %s deep-link parameter compatible', async (_label, values) => {
    const summary = {
      ...mockConversations[0],
      whatsappSessionId: 'provider-session-target',
      lead: { ...mockConversations[0].lead!, contactPhone: '+15550001111', whatsapp: '+15550001111' },
      contactPoint: { id: 'cp-target', type: 'website', originalValue: '+15550001111', normalizedValue: '+15550001111' },
    };
    searchValues = { leadId: null, phone: null, channel: null, sessionId: null, ...values };
    apiGet.mockImplementation((url: string) => {
      if (String(url).includes('/communications/conversations/') && !String(url).includes('/messages')) {
        return Promise.resolve({ data: { ...getMockConversationDetail(summary.id), ...summary } });
      }
      if (String(url).includes(conversationsUrl)) return Promise.resolve({ data: { data: [summary] } });
      return Promise.resolve({ data: { data: [] } });
    });

    await act(async () => {
      render(<CommunicationWorkbench />);
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
    });

    expect(screen.getByRole('button', { name: /Glow Beauty/ })).toBeInTheDocument();
  });
});
