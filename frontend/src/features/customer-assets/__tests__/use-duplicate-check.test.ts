import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Mock the API module so we can control fetch behavior and signal handling
vi.mock('../api/customer-asset-api', () => ({
  duplicateCheck: vi.fn(),
}));

// Import after mock is set up
import { useDuplicateCheck } from '../hooks/use-duplicate-check';
import { duplicateCheck } from '../api/customer-asset-api';

const mockedDuplicateCheck = vi.mocked(duplicateCheck);

async function advanceTimers(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('useDuplicateCheck', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('空查询不发起请求', () => {
    const { result } = renderHook(() => useDuplicateCheck(''));

    expect(mockedDuplicateCheck).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
    expect(result.current.result).toBeNull();
  });

  it('300ms 防抖后才发起请求', async () => {
    mockedDuplicateCheck.mockImplementation(() => new Promise(() => {}));

    const { unmount } = renderHook(() => useDuplicateCheck('Acme'));

    // 299ms 时不应调用
    await advanceTimers(299);
    expect(mockedDuplicateCheck).not.toHaveBeenCalled();

    // 300ms 时应调用
    await advanceTimers(1);
    expect(mockedDuplicateCheck).toHaveBeenCalledTimes(1);
    expect(mockedDuplicateCheck).toHaveBeenCalledWith(
      { query: 'Acme' },
      expect.any(AbortSignal),
    );

    unmount();
  });

  it('新查询取消旧请求（AbortController）', async () => {
    const signals: AbortSignal[] = [];
    mockedDuplicateCheck.mockImplementation((_cmd, signal) => {
      if (!signal) throw new Error('duplicate check must receive an AbortSignal');
      signals.push(signal);
      return new Promise(() => {}); // never resolves
    });

    const { rerender, unmount } = renderHook(
      ({ query }) => useDuplicateCheck(query),
      { initialProps: { query: 'Acme' } },
    );

    // 触发第一个请求
    await advanceTimers(300);
    expect(mockedDuplicateCheck).toHaveBeenCalledTimes(1);
    expect(signals[0]?.aborted).toBe(false);

    // 改变查询
    act(() => rerender({ query: 'Beta' }));
    expect(signals[0]?.aborted).toBe(true);

    await advanceTimers(300);
    expect(mockedDuplicateCheck).toHaveBeenCalledTimes(2);
    expect(mockedDuplicateCheck).toHaveBeenLastCalledWith(
      { query: 'Beta' },
      expect.any(AbortSignal),
    );
    expect(signals[1]?.aborted).toBe(false);

    unmount();
    expect(signals[1]?.aborted).toBe(true);
  });

  it('快速连续输入只发起最后一次请求', async () => {
    mockedDuplicateCheck.mockImplementation(() => new Promise(() => {}));

    const { rerender, unmount } = renderHook(
      ({ query }) => useDuplicateCheck(query),
      { initialProps: { query: 'A' } },
    );

    // 100ms 后改变查询
    await advanceTimers(100);
    act(() => rerender({ query: 'Ac' }));

    // 100ms 后再改变
    await advanceTimers(100);
    act(() => rerender({ query: 'Acm' }));

    // 100ms 后再改变
    await advanceTimers(100);
    act(() => rerender({ query: 'Acme' }));

    // 此时不应有任何调用（每次输入都重置了防抖）
    expect(mockedDuplicateCheck).not.toHaveBeenCalled();

    // 等待防抖结束
    await advanceTimers(300);

    // 只调用一次，使用最后的查询
    expect(mockedDuplicateCheck).toHaveBeenCalledTimes(1);
    expect(mockedDuplicateCheck).toHaveBeenCalledWith(
      { query: 'Acme' },
      expect.any(AbortSignal),
    );

    unmount();
  });

  it('卸载时取消防抖定时器和进行中的请求', async () => {
    let abortSignal: AbortSignal | undefined;
    mockedDuplicateCheck.mockImplementation((_cmd, signal) => {
      abortSignal = signal;
      return new Promise(() => {}); // never resolves
    });

    const { unmount } = renderHook(() => useDuplicateCheck('Acme'));

    // 触发请求
    await act(async () => {
      vi.advanceTimersByTime(300);
      await vi.runAllTicks();
    });

    expect(mockedDuplicateCheck).toHaveBeenCalledTimes(1);
    expect(abortSignal?.aborted).toBe(false);

    // 卸载
    unmount();

    // 卸载后 signal 应被 abort
    expect(abortSignal?.aborted).toBe(true);
  });

  it('请求成功后更新 result', async () => {
    const mockResult = {
      hasDuplicates: true,
      matches: [
        {
          id: 'dup-001',
          companyName: 'Acme Dup',
          displayName: 'Acme Dup',
          countryIso2: 'US',
          confidence: 0.95,
          matchedField: 'companyName' as const,
        },
      ],
    };
    mockedDuplicateCheck.mockResolvedValue(mockResult);

    const { result } = renderHook(() => useDuplicateCheck('Acme'));

    // 触发请求
    await act(async () => {
      vi.advanceTimersByTime(300);
      await vi.runAllTicks();
    });

    expect(result.current.result).toEqual(mockResult);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('请求失败后更新 error', async () => {
    mockedDuplicateCheck.mockRejectedValue(new Error('网络错误'));

    const { result } = renderHook(() => useDuplicateCheck('Acme'));

    // 触发请求
    await act(async () => {
      vi.advanceTimersByTime(300);
      await vi.runAllTicks();
    });

    expect(result.current.error).toBe('网络错误');
    expect(result.current.loading).toBe(false);
    expect(result.current.result).toBeNull();
  });
});
