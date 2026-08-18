/**
 * TASK-102H: useCustomerMerge
 *
 * 合并/拒绝/撤销操作 hook。
 * - merge / reject / undo 三个操作
 * - submitLockRef 防止重复提交
 * - AbortController：卸载时自动 abort 进行中的请求
 */

'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import type { MergePreview, MergeResult } from '../types';
import {
  mergePreview as apiMergePreview,
  merge as apiMerge,
  reject as apiReject,
  undoMerge as apiUndoMerge,
} from '../api/customer-asset-api';

export type MergeAction = 'merge' | 'reject' | 'undo' | 'preview' | null;

export interface UseCustomerMergeReturn {
  /** 当前操作的预览数据 */
  preview: MergePreview | null;
  /** 最近的合并结果（含 auditId，用于撤销） */
  lastMergeResult: MergeResult | null;
  /** 正在执行的操作类型 */
  pendingAction: MergeAction;
  /** 操作错误信息 */
  error: string | null;
  /** 加载合并预览 */
  loadPreview: (candidateId: string) => Promise<void>;
  /** 执行合并 */
  doMerge: (candidateId: string, adoptFields?: string[]) => Promise<MergeResult | null>;
  /** 拒绝候选 */
  doReject: (candidateId: string) => Promise<boolean>;
  /** 撤销合并 */
  doUndo: (auditId: string) => Promise<boolean>;
  /** 清除预览和错误 */
  reset: () => void;
}

export function useCustomerMerge(): UseCustomerMergeReturn {
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [lastMergeResult, setLastMergeResult] = useState<MergeResult | null>(
    null,
  );
  const [pendingAction, setPendingAction] = useState<MergeAction>(null);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const submitLockRef = useRef(false);

  // 卸载时中止进行中的请求
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const loadPreview = useCallback(async (candidateId: string): Promise<void> => {
    if (submitLockRef.current) return;
    submitLockRef.current = true;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setPendingAction('preview');
    setError(null);

    try {
      const res = await apiMergePreview(candidateId, controller.signal);
      if (!controller.signal.aborted) {
        setPreview(res);
      }
    } catch (err: unknown) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : '加载合并预览失败');
      }
    } finally {
      if (!controller.signal.aborted) {
        setPendingAction(null);
      }
      submitLockRef.current = false;
    }
  }, []);

  const doMerge = useCallback(
    async (
      candidateId: string,
      adoptFields?: string[],
    ): Promise<MergeResult | null> => {
      if (submitLockRef.current) return null;
      submitLockRef.current = true;

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setPendingAction('merge');
      setError(null);

      try {
        const targetUpdatedAt = preview?.targetUpdatedAt;
        if (!targetUpdatedAt) {
          throw new Error('merge preview version is required; refresh the preview');
        }
        const res = await apiMerge(
          { candidateId, adoptFields, targetUpdatedAt },
          controller.signal,
        );
        if (!controller.signal.aborted) {
          setLastMergeResult(res);
          setPreview(null);
        }
        return res;
      } catch (err: unknown) {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : '合并失败');
        }
        return null;
      } finally {
        if (!controller.signal.aborted) {
          setPendingAction(null);
        }
        submitLockRef.current = false;
      }
    },
    [preview],
  );

  const doReject = useCallback(
    async (candidateId: string): Promise<boolean> => {
      if (submitLockRef.current) return false;
      submitLockRef.current = true;

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setPendingAction('reject');
      setError(null);

      try {
        await apiReject(candidateId, controller.signal);
        if (!controller.signal.aborted) {
          setPreview(null);
        }
        return true;
      } catch (err: unknown) {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : '拒绝失败');
        }
        return false;
      } finally {
        if (!controller.signal.aborted) {
          setPendingAction(null);
        }
        submitLockRef.current = false;
      }
    },
    [],
  );

  const doUndo = useCallback(async (auditId: string): Promise<boolean> => {
    if (submitLockRef.current) return false;
    submitLockRef.current = true;

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setPendingAction('undo');
    setError(null);

    try {
      await apiUndoMerge(auditId, controller.signal);
      if (!controller.signal.aborted) {
        setLastMergeResult(null);
      }
      return true;
    } catch (err: unknown) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : '撤销失败');
      }
      return false;
    } finally {
      if (!controller.signal.aborted) {
        setPendingAction(null);
      }
      submitLockRef.current = false;
    }
  }, []);

  const reset = useCallback(() => {
    setPreview(null);
    setError(null);
    setPendingAction(null);
  }, []);

  return {
    preview,
    lastMergeResult,
    pendingAction,
    error,
    loadPreview,
    doMerge,
    doReject,
    doUndo,
    reset,
  };
}
