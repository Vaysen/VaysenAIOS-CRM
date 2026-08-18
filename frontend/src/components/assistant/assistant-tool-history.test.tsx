import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantToolHistory } from './assistant-tool-history';
import { cancelAssistantTool, confirmAssistantTool, listAssistantToolHistory } from '@/lib/assistant-tool-api';

vi.mock('@/lib/assistant-tool-api', () => ({
  cancelAssistantTool: vi.fn(),
  confirmAssistantTool: vi.fn(),
  listAssistantToolHistory: vi.fn(),
}));

const item = (state: 'AWAITING_CONFIRMATION' | 'SUCCEEDED' | 'FAILED', id: string, errorCode?: string) => ({
  id,
  toolName: state === 'FAILED' ? 'quote_draft_create' : state === 'SUCCEEDED' ? 'task_follow_up_create' : 'message_draft_prepare',
  state,
  confirmationRequired: state !== 'SUCCEEDED',
  parameterSummary: { leadId: '00000000-0000-0000-0000-000000000001' },
  result: null,
  resultRef: state === 'SUCCEEDED' ? { id: 'follow-up-1' } : null,
  errorCode: errorCode ?? null,
  createdAt: '2026-07-29T00:00:00.000Z',
  completedAt: state === 'SUCCEEDED' || state === 'FAILED' ? '2026-07-29T00:01:00.000Z' : null,
});

describe('assistant tool history UI', () => {
  beforeEach(() => vi.mocked(listAssistantToolHistory).mockResolvedValue([
    item('AWAITING_CONFIRMATION', 'awaiting-1'),
    item('SUCCEEDED', 'success-1'),
    item('FAILED', 'failed-1', 'QUOTE_CREATE_FAILED'),
  ]));

  it('distinguishes confirmation, success, and failure without a fake success', async () => {
    render(<AssistantToolHistory companyId="company-1" />);

    expect(await screen.findByText('message_draft_prepare')).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(2);
    expect(screen.getByText('QUOTE_CREATE_FAILED')).toBeInTheDocument();
    expect(screen.getByText('task_follow_up_create')).toBeInTheDocument();
    expect(screen.getByRole('link')).toHaveAttribute('href', '/follow-ups/follow-up-1');
    expect(confirmAssistantTool).not.toHaveBeenCalled();
    expect(cancelAssistantTool).not.toHaveBeenCalled();
  });
});
