import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { CommunicationWorkbench } from '../communication-workbench';

const conversationsUrl = '/communications/conversations';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => ({ get: () => null }),
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
});
