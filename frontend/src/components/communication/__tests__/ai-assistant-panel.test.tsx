import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import api from '@/lib/api';
import { AiAssistantPanel } from '../ai-assistant-panel';

vi.mock('@/lib/api', () => ({
  default: { post: vi.fn() },
}));

const inboundMessage = {
  id: 'message-1',
  direction: 'inbound' as const,
  content: 'Please quote 10,000 bags',
  contentType: 'text',
  fromAddress: null,
  toAddress: null,
  subject: null,
  sentAt: null,
  receivedAt: '2026-06-30T00:00:00.000Z',
  attachmentsMeta: null,
  createdAt: '2026-06-30T00:00:00.000Z',
};

const replyButtonName = 'AI回复建议(EN)';

describe('AiAssistantPanel', () => {
  beforeEach(() => {
    vi.mocked(api.post).mockReset();
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('renders the AI reply action as a prominent blue-white button', () => {
    render(
      <AiAssistantPanel
        conversationId="conversation-1"
        lastMessage={inboundMessage}
        leadLanguage="en"
        onUseDraft={vi.fn()}
      />,
    );

    const button = screen.getByRole('button', { name: replyButtonName });
    expect(button.className).toContain('bg-blue-600');
    expect(button.className).toContain('text-white');
    expect(button.className).toContain('border-blue-300');
    expect(button.className).toContain('hover:bg-blue-700');
  });

  it('keeps the existing suggestion request behavior', async () => {
    vi.mocked(api.post).mockResolvedValue({ data: { replies: ['Draft'] } });
    render(
      <AiAssistantPanel
        conversationId="conversation-1"
        lastMessage={inboundMessage}
        leadLanguage="en"
        onUseDraft={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: replyButtonName }));
    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith('/ai-communications/suggest-replies/message-1', {
        targetLanguage: 'en',
      });
    });
  });

  it('T112-003: surfaces a diagnostic error (401) instead of a generic message', async () => {
    vi.mocked(api.post).mockRejectedValue({
      response: { status: 401 },
      message: 'Unauthorized',
    });
    render(
      <AiAssistantPanel
        conversationId="conversation-1"
        lastMessage={inboundMessage}
        leadLanguage="en"
        onUseDraft={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: replyButtonName }));
    await waitFor(() => {
      expect(screen.getByText(/登录已失效/)).toBeInTheDocument();
    });
    expect(screen.queryByText('AI 服务暂不可用')).not.toBeInTheDocument();
  });

  it('T112-003: offers a retry button and retries on click', async () => {
    vi.mocked(api.post)
      .mockRejectedValueOnce({ response: { status: 500 }, message: 'Server Error' })
      .mockResolvedValueOnce({ data: { replies: ['Retry Draft'] } });

    render(
      <AiAssistantPanel
        conversationId="conversation-1"
        lastMessage={inboundMessage}
        leadLanguage="en"
        onUseDraft={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: replyButtonName }));
    const retry = await screen.findByRole('button', { name: /重试/ });
    fireEvent.click(retry);

    await waitFor(() => {
      expect(api.post).toHaveBeenCalledTimes(2);
    });
    await waitFor(() => {
      expect(screen.getByText('Retry Draft')).toBeInTheDocument();
    });
  });

  it('T112-003: diagnoses network/offline errors distinctly', async () => {
    vi.mocked(api.post).mockRejectedValue({ code: 'ERR_NETWORK', message: 'Network Error' });
    render(
      <AiAssistantPanel
        conversationId="conversation-1"
        lastMessage={inboundMessage}
        leadLanguage="en"
        onUseDraft={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: replyButtonName }));
    await waitFor(() => {
      expect(screen.getByText(/网络超时或后端离线/)).toBeInTheDocument();
    });
  });
});
