/**
 * TASK-102H: MergeDiffDialog
 *
 * 合并审核弹窗，三个动作：
 * 1. "合并并保留差异" — 直接合并，保留两方所有非冲突字段
 * 2. "逐项选择" — 用户勾选要采用候选值的字段
 * 3. "不是同一客户" — 拒绝合并
 *
 * 受控组件：open / preview / pendingAction 由父层传入。
 */

'use client';

import { useState, useEffect, useCallback } from 'react';
import { GitMerge, Check, X, Loader2, ShieldX } from 'lucide-react';
import type { MergePreview } from '../types';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';

export interface MergeDiffDialogProps {
  open: boolean;
  preview: MergePreview | null;
  /** 正在执行的操作类型 */
  pendingAction: 'merge' | 'reject' | 'preview' | null;
  /** 合并并保留差异 */
  onMergeAll: () => void;
  /** 逐项选择后合并（传入选中的字段列表） */
  onMergeWithChoices: (adoptFields: string[]) => void;
  /** 不是同一客户（拒绝） */
  onReject: () => void;
  /** 关闭弹窗 */
  onClose: () => void;
}

export function MergeDiffDialog({
  open,
  preview,
  pendingAction,
  onMergeAll,
  onMergeWithChoices,
  onReject,
  onClose,
}: MergeDiffDialogProps) {
  const [choiceMode, setChoiceMode] = useState(false);
  const [selectedFields, setSelectedFields] = useState<Set<string>>(new Set());

  // 预览变化时重置选择模式
  useEffect(() => {
    setChoiceMode(false);
    setSelectedFields(new Set());
  }, [preview?.candidateId]);

  const toggleField = useCallback((field: string) => {
    setSelectedFields((prev) => {
      const next = new Set(prev);
      if (next.has(field)) {
        next.delete(field);
      } else {
        next.add(field);
      }
      return next;
    });
  }, []);

  const handleMergeChoices = useCallback(() => {
    onMergeWithChoices(Array.from(selectedFields));
  }, [onMergeWithChoices, selectedFields]);

  if (!open || !preview) return null;

  const isBusy = pendingAction !== null;

  return (
    <Dialog open={open}>
      <DialogContent
        onClose={isBusy ? undefined : onClose}
        className="max-w-xl"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5">
            <GitMerge className="w-4 h-4 text-blue-500" />
            客户合并审核
          </DialogTitle>
          <DialogDescription>
            请确认以下候选项是否为同一客户，并选择合并方式。
            合并后可通过审计 ID 撤销。
          </DialogDescription>
        </DialogHeader>

        {/* 差异预览 */}
        <div
          className="border rounded p-3 space-y-2 max-h-60 overflow-y-auto"
          data-testid="merge-diff-list"
        >
          {preview.diffs.length === 0 ? (
            <p className="text-xs text-gray-400 text-center py-4">
              无差异字段，可直接合并
            </p>
          ) : (
            preview.diffs.map((diff) => (
              <div
                key={diff.field}
                className="flex items-start gap-2 text-[12px]"
              >
                {choiceMode && (
                  <input
                    type="checkbox"
                    checked={selectedFields.has(diff.field)}
                    onChange={() => toggleField(diff.field)}
                    className="mt-0.5"
                    data-testid={`diff-checkbox-${diff.field}`}
                  />
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-[10px] text-gray-400">{diff.field}</p>
                  <div className="flex items-center gap-2">
                    <span className="text-gray-600 truncate">
                      当前: {diff.currentValue || '—'}
                    </span>
                    <span className="text-gray-300">→</span>
                    <span
                      className={`truncate ${
                        diff.recommendCandidate
                          ? 'text-blue-600 font-medium'
                          : 'text-gray-600'
                      }`}
                    >
                      候选: {diff.candidateValue || '—'}
                    </span>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>

        {/* 汇总信息 */}
        <div className="flex items-center gap-3 text-[10px] text-gray-400">
          <span>合并后联系人: {preview.mergedContactCount}</span>
          <span>合并后渠道: {preview.mergedChannelCount}</span>
        </div>

        {/* 选择模式切换 */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setChoiceMode((v) => !v)}
            disabled={isBusy}
            className={`text-[10px] px-2 py-1 rounded border transition-colors ${
              choiceMode
                ? 'bg-blue-50 border-blue-200 text-blue-700'
                : 'border-gray-200 text-gray-500 hover:bg-gray-50'
            }`}
            data-testid="toggle-choice-mode"
          >
            {choiceMode ? '取消逐项选择' : '逐项选择字段'}
          </button>
          {choiceMode && (
            <span className="text-[10px] text-gray-400">
              已选 {selectedFields.size} 项采用候选值
            </span>
          )}
        </div>

        {/* 动作按钮 */}
        <DialogFooter>
          {/* 不是同一客户 */}
          <button
            onClick={onReject}
            disabled={isBusy}
            className="flex items-center gap-1 text-[11px] px-3 py-1.5 rounded border border-red-200 bg-red-50 text-red-700 hover:bg-red-100 disabled:opacity-40"
            data-testid="merge-action-reject"
          >
            {pendingAction === 'reject' ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <ShieldX className="w-3 h-3" />
            )}
            不是同一客户
          </button>

          {/* 逐项选择合并 */}
          {choiceMode && (
            <button
              onClick={handleMergeChoices}
              disabled={isBusy || selectedFields.size === 0}
              className="flex items-center gap-1 text-[11px] px-3 py-1.5 rounded border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 disabled:opacity-40"
              data-testid="merge-action-choices"
            >
              {pendingAction === 'merge' ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <Check className="w-3 h-3" />
              )}
              合并所选 ({selectedFields.size})
            </button>
          )}

          {/* 合并并保留差异 */}
          <button
            onClick={onMergeAll}
            disabled={isBusy || choiceMode}
            className="flex items-center gap-1 text-[11px] px-3 py-1.5 rounded border border-green-200 bg-green-50 text-green-700 hover:bg-green-100 disabled:opacity-40"
            data-testid="merge-action-all"
          >
            {pendingAction === 'merge' ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <GitMerge className="w-3 h-3" />
            )}
            合并并保留差异
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
