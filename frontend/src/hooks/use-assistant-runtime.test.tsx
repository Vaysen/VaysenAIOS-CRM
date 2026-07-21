import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantRuntimeSnapshot } from '@/types/assistant-runtime';

const mocks = vi.hoisted(() => ({ getAssistantRuntime: vi.fn() }));
vi.mock('@/lib/assistant-runtime-api', () => ({
  getAssistantRuntime: mocks.getAssistantRuntime,
}));

import { useAssistantRuntime } from './use-assistant-runtime';

function runtime(release: string, status: AssistantRuntimeSnapshot['wechatOwnerChannel']['status'] = 'CONNECTED'): AssistantRuntimeSnapshot {
  return {
    schemaVersion: 1,
    observedAt: '2026-07-14T14:00:00.000Z',
    runtime: {
      engine: 'openclaw', release, status: 'READY', gatewayReady: true,
      adapterReady: true, modelReady: true, lastHeartbeatAt: '2026-07-14T13:59:55.000Z',
      errorCode: null,
    },
    wechatOwnerChannel: { status, pluginReady: true, errorCode: null },
    permissions: {
      canUseAssistant: true, canIssueWechatCommands: true,
      canAdminApprove: false, canManageChannel: false,
    },
    capabilities: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('useAssistantRuntime', () => {
  beforeEach(() => {
    mocks.getAssistantRuntime.mockReset();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('clears the old company and ignores its late response after a company switch', async () => {
    const first = deferred<AssistantRuntimeSnapshot>();
    const second = deferred<AssistantRuntimeSnapshot>();
    mocks.getAssistantRuntime.mockImplementation((companyId: string) => (
      companyId === 'company-a' ? first.promise : second.promise
    ));

    const { result, rerender } = renderHook(
      ({ companyId }) => useAssistantRuntime({ companyId }),
      { initialProps: { companyId: 'company-a' } },
    );
    await waitFor(() => expect(mocks.getAssistantRuntime).toHaveBeenCalledWith('company-a', expect.any(AbortSignal)));

    rerender({ companyId: 'company-b' });
    expect(result.current.snapshot).toBeNull();
    await waitFor(() => expect(mocks.getAssistantRuntime).toHaveBeenCalledWith('company-b', expect.any(AbortSignal)));

    await act(async () => second.resolve(runtime('company-b-release')));
    await waitFor(() => expect(result.current.snapshot?.runtime.release).toBe('company-b-release'));

    await act(async () => first.resolve(runtime('stale-company-a-release')));
    expect(result.current.snapshot?.runtime.release).toBe('company-b-release');
  });

  it('does not poll while logged out, hidden, or offline', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    const { rerender } = renderHook(
      ({ enabled }) => useAssistantRuntime({ companyId: 'company-1', enabled }),
      { initialProps: { enabled: false } },
    );
    await act(async () => Promise.resolve());
    expect(mocks.getAssistantRuntime).not.toHaveBeenCalled();

    rerender({ enabled: true });
    await act(async () => Promise.resolve());
    expect(mocks.getAssistantRuntime).not.toHaveBeenCalled();

    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    mocks.getAssistantRuntime.mockResolvedValue(runtime('online'));
    act(() => window.dispatchEvent(new Event('online')));
    await waitFor(() => expect(mocks.getAssistantRuntime).toHaveBeenCalledTimes(1));
  });

  it('switches to a two-second poll while the controlled terminal is waiting for a scan', async () => {
    vi.useFakeTimers();
    mocks.getAssistantRuntime.mockResolvedValue(runtime('pairing', 'WAITING_SCAN'));
    renderHook(() => useAssistantRuntime({ companyId: 'company-1' }));

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(mocks.getAssistantRuntime).toHaveBeenCalled();
    const afterInitialStatus = mocks.getAssistantRuntime.mock.calls.length;

    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(mocks.getAssistantRuntime.mock.calls.length).toBeGreaterThan(afterInitialStatus);
  });

  it('waits for a slow pairing probe to finish before scheduling the next poll', async () => {
    vi.useFakeTimers();
    const slowProbe = deferred<AssistantRuntimeSnapshot>();
    mocks.getAssistantRuntime
      .mockResolvedValueOnce(runtime('pairing-initial', 'WAITING_SCAN'))
      .mockImplementationOnce(() => slowProbe.promise)
      .mockResolvedValue(runtime('pairing-next', 'WAITING_SCAN'));

    renderHook(() => useAssistantRuntime({ companyId: 'company-1' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(mocks.getAssistantRuntime).toHaveBeenCalledTimes(2);

    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(mocks.getAssistantRuntime).toHaveBeenCalledTimes(2);

    await act(async () => { slowProbe.resolve(runtime('pairing-slow', 'WAITING_SCAN')); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1_999); });
    expect(mocks.getAssistantRuntime).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(mocks.getAssistantRuntime).toHaveBeenCalledTimes(3);
  });

  it('aborts an in-flight probe as soon as the page becomes hidden', async () => {
    const pending = deferred<AssistantRuntimeSnapshot>();
    let signal: AbortSignal | undefined;
    mocks.getAssistantRuntime.mockImplementation((_companyId: string, currentSignal: AbortSignal) => {
      signal = currentSignal;
      return pending.promise;
    });
    const { result } = renderHook(() => useAssistantRuntime({ companyId: 'company-1' }));
    await waitFor(() => expect(signal).toBeDefined());
    expect(signal?.aborted).toBe(false);

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    act(() => document.dispatchEvent(new Event('visibilitychange')));

    expect(signal?.aborted).toBe(true);
    expect(result.current.loading).toBe(false);
  });

  it('clears a previously ready snapshot after a failed refresh', async () => {
    mocks.getAssistantRuntime.mockResolvedValueOnce(runtime('ready'));
    const { result } = renderHook(() => useAssistantRuntime({ companyId: 'company-1' }));
    await waitFor(() => expect(result.current.snapshot?.runtime.status).toBe('READY'));

    mocks.getAssistantRuntime.mockRejectedValueOnce(new Error('gateway unavailable'));
    await act(async () => result.current.refresh());

    expect(result.current.snapshot).toBeNull();
    expect(result.current.error).toContain('gateway unavailable');
  });

  it('clears a connected snapshot immediately when the browser goes offline', async () => {
    mocks.getAssistantRuntime.mockResolvedValue(runtime('ready'));
    const { result } = renderHook(() => useAssistantRuntime({ companyId: 'company-1' }));
    await waitFor(() => expect(result.current.snapshot?.wechatOwnerChannel.status).toBe('CONNECTED'));

    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    act(() => window.dispatchEvent(new Event('offline')));

    expect(result.current.snapshot).toBeNull();
    expect(result.current.error).toContain('离线');
  });
});
