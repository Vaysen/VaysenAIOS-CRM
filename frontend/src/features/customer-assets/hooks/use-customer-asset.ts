/**
 * TASK-102H: useCustomerAsset
 *
 * 加载客户资产，管理 loading / error / data 状态。
 * 卸载时取消进行中的请求（AbortController）。
 */

'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { CustomerAsset } from '../types';
import { getCustomerAsset } from '../api/customer-asset-api';

export interface UseCustomerAssetReturn {
  data: CustomerAsset | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useCustomerAsset(
  assetId: string | null,
): UseCustomerAssetReturn {
  const [data, setData] = useState<CustomerAsset | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refetchTrigger, setRefetchTrigger] = useState(0);
  const abortRef = useRef<AbortController | null>(null);

  const refetch = useCallback(() => {
    setRefetchTrigger((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!assetId) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }

    // 取消上一个请求
    abortRef.current?.abort();

    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);

    getCustomerAsset(assetId, controller.signal)
      .then((asset) => {
        if (!controller.signal.aborted) {
          setData(asset);
        }
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) {
          const message =
            err instanceof Error ? err.message : '加载客户资产失败';
          setError(message);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      });

    return () => {
      controller.abort();
    };
  }, [assetId, refetchTrigger]);

  return { data, loading, error, refetch };
}
