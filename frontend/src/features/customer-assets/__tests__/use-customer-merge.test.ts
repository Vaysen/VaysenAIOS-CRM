import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MergePreview } from '../types';

vi.mock('../api/customer-asset-api', () => ({
  mergePreview: vi.fn(),
  merge: vi.fn(),
  reject: vi.fn(),
  undoMerge: vi.fn(),
}));

import {
  merge as apiMerge,
  mergePreview as apiMergePreview,
} from '../api/customer-asset-api';
import { useCustomerMerge } from '../hooks/use-customer-merge';

const preview: MergePreview = {
  candidateId: 'candidate-1',
  targetAssetId: 'target-1',
  targetUpdatedAt: '2026-07-29T00:00:00.000Z',
  diffs: [],
  mergedContactCount: 0,
  mergedChannelCount: 0,
};

describe('useCustomerMerge optimistic version contract', () => {
  beforeEach(() => vi.clearAllMocks());

  it('passes the preview targetUpdatedAt to merge confirmation', async () => {
    vi.mocked(apiMergePreview).mockResolvedValue(preview);
    vi.mocked(apiMerge).mockResolvedValue({ auditId: 'audit-1', mergedAssetId: 'target-1' });
    const { result } = renderHook(() => useCustomerMerge());

    await act(async () => { await result.current.loadPreview('candidate-1'); });
    await act(async () => { await result.current.doMerge('candidate-1'); });

    expect(apiMerge).toHaveBeenCalledWith({
      candidateId: 'candidate-1', adoptFields: undefined, targetUpdatedAt: preview.targetUpdatedAt,
    }, expect.any(AbortSignal));
  });
});
