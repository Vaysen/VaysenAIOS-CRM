/**
 * TASK-102H: IdentityMergeReviewBanner
 *
 * 待审核候选横幅：当 pendingMatchCount > 0 时展示。
 * 点击候选项触发 onReview 回调。
 */

'use client';

import { AlertCircle, ChevronRight } from 'lucide-react';
import type { PendingCandidate } from '../types';

export interface IdentityMergeReviewBannerProps {
  pendingMatchCount: number;
  pendingCandidates: PendingCandidate[];
  onReview: (candidateId: string) => void;
}

export function IdentityMergeReviewBanner({
  pendingMatchCount,
  pendingCandidates,
  onReview,
}: IdentityMergeReviewBannerProps) {
  if (pendingMatchCount === 0) return null;

  return (
    <div
      className="px-3 py-2 border-b bg-amber-50"
      data-testid="merge-review-banner"
    >
      <div className="flex items-center gap-1.5 mb-1">
        <AlertCircle className="w-3.5 h-3.5 text-amber-500 shrink-0" />
        <p className="text-[11px] font-medium text-amber-700">
          发现 {pendingMatchCount} 个疑似重复客户，待审核
        </p>
      </div>
      <div className="space-y-1">
        {pendingCandidates.map((candidate) => (
          <button
            key={candidate.id}
            onClick={() => onReview(candidate.id)}
            className="w-full flex items-center gap-1 px-2 py-1 rounded border border-amber-200 bg-white hover:bg-amber-50 transition-colors text-left"
            data-testid={`merge-candidate-${candidate.id}`}
          >
            <div className="flex-1 min-w-0">
              <p className="text-[11px] font-medium text-gray-700 truncate">
                {candidate.displayName}
              </p>
              <p className="text-[9px] text-gray-400 truncate">
                {candidate.contactPointPreview}
              </p>
            </div>
            <span className="text-[9px] px-1 py-0.5 rounded bg-amber-100 text-amber-700 shrink-0">
              {Math.round(candidate.confidence * 100)}%
            </span>
            <ChevronRight className="w-3 h-3 text-gray-400 shrink-0" />
          </button>
        ))}
      </div>
    </div>
  );
}
