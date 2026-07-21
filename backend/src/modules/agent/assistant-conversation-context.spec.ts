import { buildAssistantConversationContext } from './assistant-conversation-context';

describe('buildAssistantConversationContext', () => {
  it('keeps recent turns and compresses older business context', () => {
    const turns = Array.from({ length: 9 }, (_, index) => ({
      input: `客户任务 ${index + 1}`,
      output: `处理结果 ${index + 1}`,
      toolReceipts: index === 2
        ? [{ toolName: 'crm.customer_search', businessStatus: 'SUCCEEDED' }]
        : [],
    }));

    const context = buildAssistantConversationContext(turns, 4);

    expect(context.compressedTurnCount).toBe(5);
    expect(context.retainedTurnCount).toBe(4);
    expect(context.compressedSummary).toContain('已自动压缩 5 轮');
    expect(context.compressedSummary).toContain('crm.customer_search:SUCCEEDED');
    expect(context.recentContext).not.toContain('客户任务 5');
    expect(context.recentContext).toContain('客户任务 6');
    expect(context.recentContext).toContain('客户任务 9');
  });

  it('returns no compressed section for a short conversation', () => {
    const context = buildAssistantConversationContext([
      { input: '你好', output: '你好，有什么需要我处理？' },
    ]);

    expect(context.compressedSummary).toBe('无');
    expect(context.compressedTurnCount).toBe(0);
    expect(context.recentContext).toContain('用户：你好');
  });

  it('bounds oversized content before it reaches OpenClaw', () => {
    const turns = Array.from({ length: 20 }, (_, index) => ({
      input: `${index}-${'问'.repeat(1_000)}`,
      output: `${index}-${'答'.repeat(2_000)}`,
    }));

    const context = buildAssistantConversationContext(turns, 6);

    expect(context.compressedSummary.length).toBeLessThanOrEqual(1_500);
    expect(context.recentContext.length).toBeLessThan(9_000);
  });
});
