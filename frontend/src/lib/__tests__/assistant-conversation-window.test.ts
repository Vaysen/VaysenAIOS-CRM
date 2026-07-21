import { describe, expect, it } from 'vitest';
import { selectAssistantConversationTurns } from '@/lib/assistant-conversation-window';

describe('selectAssistantConversationTurns', () => {
  it('keeps only the latest turns when history is collapsed', () => {
    const turns = Array.from({ length: 12 }, (_, index) => index + 1);
    expect(selectAssistantConversationTurns(turns, false)).toEqual({
      visible: [5, 6, 7, 8, 9, 10, 11, 12],
      hiddenCount: 4,
    });
  });

  it('returns the complete trace when the operator expands history', () => {
    const turns = [1, 2, 3];
    expect(selectAssistantConversationTurns(turns, true, 2)).toEqual({
      visible: turns,
      hiddenCount: 0,
    });
  });

  it('rejects invalid window limits instead of silently hiding everything', () => {
    expect(() => selectAssistantConversationTurns([1], false, 0)).toThrow(/positive integer/);
  });
});
