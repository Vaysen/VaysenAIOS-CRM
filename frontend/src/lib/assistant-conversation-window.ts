export const ASSISTANT_COLLAPSED_TURN_LIMIT = 8;

export function selectAssistantConversationTurns<T>(
  turns: readonly T[],
  expanded: boolean,
  limit = ASSISTANT_COLLAPSED_TURN_LIMIT,
): { visible: readonly T[]; hiddenCount: number } {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error('assistant conversation window limit must be a positive integer');
  }
  if (expanded || turns.length <= limit) {
    return { visible: turns, hiddenCount: 0 };
  }
  return {
    visible: turns.slice(-limit),
    hiddenCount: turns.length - limit,
  };
}
