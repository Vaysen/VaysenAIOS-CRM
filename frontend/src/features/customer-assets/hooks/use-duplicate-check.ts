/**
 * TASK-102H: useDuplicateCheck
 *
 * 300ms 防抖查重 hook。
 * - 新请求时取消旧请求（AbortController）
 * - 卸载时取消进行中的请求并清除防抖定时器
 * - query 为空字符串时不发起请求
 */

'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import type { DuplicateCheckResult } from '../types';
import { duplicateCheck } from '../api/customer-asset-api';

const DEBOUNCE_MS = 300;

export interface UseDuplicateCheckReturn {
  result: DuplicateCheckResult | null;
  loading: boolean;
  error: string | null;
}

export function useDuplicateCheck(
  query: string,
  excludeId?: string,
): UseDuplicateCheckReturn {
  const [result, setResult] = useState<DuplicateCheckResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const cleanup = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    abortRef.current?.abort();
  }, []);

  useEffect(() => {
    const trimmed = query.trim();

    // 空查询：清除结果，不发起请求
    if (trimmed === '') {
      cleanup();
      setResult(null);
      setLoading(false);
      setError(null);
      return;
    }

    // 清除上一个防抖定时器
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
    }

    // 取消上一个进行中的请求
    abortRef.current?.abort();

    // 防抖延迟
    timerRef.current = setTimeout(() => {
      const controller = new AbortController();
      abortRef.current = controller;

      setLoading(true);
      setError(null);

      duplicateCheck({ query: trimmed, excludeId }, controller.signal)
        .then((res) => {
          if (!controller.signal.aborted) {
            setResult(res);
          }
        })
        .catch((err: unknown) => {
          if (!controller.signal.aborted) {
            const message =
              err instanceof Error ? err.message : '查重请求失败';
            setError(message);
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) {
            setLoading(false);
          }
        });
    }, DEBOUNCE_MS);

    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, excludeId]);

  // 卸载时清理
  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup]);

  return { result, loading, error };
}
