'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getAssistantRuntime } from '@/lib/assistant-runtime-api';
import {
  FAST_WECHAT_OWNER_CHANNEL_STATUSES,
  type AssistantRuntimeSnapshot,
} from '@/types/assistant-runtime';
import { getApiErrorMessage } from '@/lib/api-error';

const NORMAL_POLL_MS = 15_000;
const PAIRING_POLL_MS = 2_000;

export interface UseAssistantRuntimeResult {
  snapshot: AssistantRuntimeSnapshot | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

export function useAssistantRuntime({
  companyId,
  enabled = true,
}: {
  companyId: string;
  enabled?: boolean;
}): UseAssistantRuntimeResult {
  const [snapshot, setSnapshot] = useState<AssistantRuntimeSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pageAvailable, setPageAvailable] = useState(() => (
    typeof document === 'undefined'
      ? true
      : document.visibilityState !== 'hidden' && navigator.onLine
  ));
  const sequenceRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled || !companyId || !pageAvailable) return;
    const sequence = ++sequenceRef.current;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    try {
      const next = await getAssistantRuntime(companyId, controller.signal);
      if (sequence === sequenceRef.current && !controller.signal.aborted) {
        setSnapshot(next);
        setError(null);
      }
    } catch (runtimeError: unknown) {
      if (controller.signal.aborted) return;
      if (sequence === sequenceRef.current) {
        // Never keep rendering READY/CONNECTED from an older successful
        // probe after the current truth can no longer be verified.
        setSnapshot(null);
        setError(getApiErrorMessage(runtimeError, 'AI 执行内核状态暂时无法读取'));
      }
    } finally {
      if (sequence === sequenceRef.current) setLoading(false);
    }
  }, [companyId, enabled, pageAvailable]);

  useEffect(() => {
    sequenceRef.current += 1;
    controllerRef.current?.abort();
    setSnapshot(null);
    setError(null);
    setLoading(false);
  }, [companyId, enabled]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const updateAvailability = () => {
      const available = document.visibilityState !== 'hidden' && navigator.onLine;
      if (!available) {
        sequenceRef.current += 1;
        controllerRef.current?.abort();
        controllerRef.current = null;
        setSnapshot(null);
        if (!navigator.onLine) setError('当前设备离线，AI 执行内核状态未知');
        setLoading(false);
      }
      setPageAvailable(available);
    };
    document.addEventListener('visibilitychange', updateAvailability);
    window.addEventListener('online', updateAvailability);
    window.addEventListener('offline', updateAvailability);
    return () => {
      document.removeEventListener('visibilitychange', updateAvailability);
      window.removeEventListener('online', updateAvailability);
      window.removeEventListener('offline', updateAvailability);
    };
  }, []);

  const fastPolling = snapshot
    ? FAST_WECHAT_OWNER_CHANNEL_STATUSES.has(snapshot.wechatOwnerChannel.status)
    : false;

  useEffect(() => {
    if (!enabled || !companyId || !pageAvailable) return undefined;
    let cancelled = false;
    let timer: number | undefined;
    const pollAfterCompletion = async () => {
      await refresh();
      if (!cancelled) {
        timer = window.setTimeout(
          () => void pollAfterCompletion(),
          fastPolling ? PAIRING_POLL_MS : NORMAL_POLL_MS,
        );
      }
    };
    void pollAfterCompletion();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      controllerRef.current?.abort();
    };
  }, [companyId, enabled, fastPolling, pageAvailable, refresh]);

  useEffect(() => () => {
    sequenceRef.current += 1;
    controllerRef.current?.abort();
  }, []);

  return { snapshot, loading, error, refresh };
}
