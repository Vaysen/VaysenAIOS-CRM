import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MergeDiffDialog } from '../components/merge-diff-dialog';
import type { MergePreview } from '../types';

const mockPreview: MergePreview = {
  candidateId: 'cand-001',
  targetAssetId: 'asset-001',
  targetUpdatedAt: '2026-07-29T00:00:00.000Z',
  diffs: [
    {
      field: 'companyName',
      currentValue: 'Acme Packaging',
      candidateValue: 'Acme Corp',
      recommendCandidate: false,
    },
    {
      field: 'countryIso2',
      currentValue: 'US',
      candidateValue: 'CN',
      recommendCandidate: true,
    },
  ],
  mergedContactCount: 2,
  mergedChannelCount: 3,
};

describe('MergeDiffDialog', () => {
  it('open=false 时不渲染', () => {
    const { container } = render(
      <MergeDiffDialog
        open={false}
        preview={mockPreview}
        pendingAction={null}
        onMergeAll={vi.fn()}
        onMergeWithChoices={vi.fn()}
        onReject={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(container.firstChild).toBeNull();
  });

  it('渲染差异列表和三个动作按钮', () => {
    render(
      <MergeDiffDialog
        open={true}
        preview={mockPreview}
        pendingAction={null}
        onMergeAll={vi.fn()}
        onMergeWithChoices={vi.fn()}
        onReject={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    // 差异列表
    expect(screen.getByTestId('merge-diff-list')).toBeInTheDocument();
    expect(screen.getByText('companyName')).toBeInTheDocument();
    expect(screen.getByText('countryIso2')).toBeInTheDocument();

    // 三个动作按钮
    expect(screen.getByTestId('merge-action-all')).toBeInTheDocument();
    expect(screen.getByTestId('merge-action-reject')).toBeInTheDocument();
  });

  it('点击"合并并保留差异"触发 onMergeAll', () => {
    const onMergeAll = vi.fn();
    render(
      <MergeDiffDialog
        open={true}
        preview={mockPreview}
        pendingAction={null}
        onMergeAll={onMergeAll}
        onMergeWithChoices={vi.fn()}
        onReject={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('merge-action-all'));
    expect(onMergeAll).toHaveBeenCalledTimes(1);
  });

  it('点击"不是同一客户"触发 onReject', () => {
    const onReject = vi.fn();
    render(
      <MergeDiffDialog
        open={true}
        preview={mockPreview}
        pendingAction={null}
        onMergeAll={vi.fn()}
        onMergeWithChoices={vi.fn()}
        onReject={onReject}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('merge-action-reject'));
    expect(onReject).toHaveBeenCalledTimes(1);
  });

  it('逐项选择模式 — 勾选字段后触发 onMergeWithChoices', () => {
    const onMergeWithChoices = vi.fn();
    render(
      <MergeDiffDialog
        open={true}
        preview={mockPreview}
        pendingAction={null}
        onMergeAll={vi.fn()}
        onMergeWithChoices={onMergeWithChoices}
        onReject={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    // 进入逐项选择模式
    fireEvent.click(screen.getByTestId('toggle-choice-mode'));

    // 勾选 companyName 字段
    const checkbox = screen.getByTestId('diff-checkbox-companyName');
    fireEvent.click(checkbox);

    // 点击"合并所选"
    fireEvent.click(screen.getByTestId('merge-action-choices'));

    expect(onMergeWithChoices).toHaveBeenCalledWith(['companyName']);
  });

  it('逐项选择模式 — 未勾选任何字段时"合并所选"按钮禁用', () => {
    render(
      <MergeDiffDialog
        open={true}
        preview={mockPreview}
        pendingAction={null}
        onMergeAll={vi.fn()}
        onMergeWithChoices={vi.fn()}
        onReject={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    // 进入逐项选择模式
    fireEvent.click(screen.getByTestId('toggle-choice-mode'));

    // "合并所选"按钮应禁用
    const choicesBtn = screen.getByTestId('merge-action-choices');
    expect(choicesBtn).toBeDisabled();
  });

  it('逐项选择模式激活时"合并并保留差异"按钮禁用', () => {
    render(
      <MergeDiffDialog
        open={true}
        preview={mockPreview}
        pendingAction={null}
        onMergeAll={vi.fn()}
        onMergeWithChoices={vi.fn()}
        onReject={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    // 进入逐项选择模式
    fireEvent.click(screen.getByTestId('toggle-choice-mode'));

    // "合并并保留差异"按钮应禁用
    const allBtn = screen.getByTestId('merge-action-all');
    expect(allBtn).toBeDisabled();
  });

  it('pendingAction 不为 null 时所有按钮禁用', () => {
    render(
      <MergeDiffDialog
        open={true}
        preview={mockPreview}
        pendingAction="merge"
        onMergeAll={vi.fn()}
        onMergeWithChoices={vi.fn()}
        onReject={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByTestId('merge-action-all')).toBeDisabled();
    expect(screen.getByTestId('merge-action-reject')).toBeDisabled();
  });

  it('汇总信息正确显示', () => {
    render(
      <MergeDiffDialog
        open={true}
        preview={mockPreview}
        pendingAction={null}
        onMergeAll={vi.fn()}
        onMergeWithChoices={vi.fn()}
        onReject={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText(/合并后联系人: 2/)).toBeInTheDocument();
    expect(screen.getByText(/合并后渠道: 3/)).toBeInTheDocument();
  });
});
