type AssistantContextReceipt = {
  toolName?: string | null;
  businessStatus?: string | null;
};

export type AssistantContextTurn = {
  input: string;
  output: string;
  toolReceipts?: readonly AssistantContextReceipt[];
};

export type AssistantConversationContext = {
  compressedSummary: string;
  recentContext: string;
  compressedTurnCount: number;
  retainedTurnCount: number;
};

const DEFAULT_RECENT_TURNS = 6;
const MAX_SUMMARY_TOPICS = 6;
const MAX_SUMMARY_RECEIPTS = 8;

function compact(value: string, maxLength: number) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(1, maxLength - 1))}…`;
}

/**
 * Build a bounded, deterministic context packet for OpenClaw. Recent turns
 * remain verbatim while older turns become a compact business summary. This
 * keeps long-running CRM threads useful without sending an ever-growing prompt
 * or relying on an unauditable hidden model summary.
 */
export function buildAssistantConversationContext(
  turns: readonly AssistantContextTurn[],
  recentTurnLimit = DEFAULT_RECENT_TURNS,
): AssistantConversationContext {
  const safeLimit = Number.isInteger(recentTurnLimit) && recentTurnLimit > 0
    ? recentTurnLimit
    : DEFAULT_RECENT_TURNS;
  const splitAt = Math.max(0, turns.length - safeLimit);
  const older = turns.slice(0, splitAt);
  const recent = turns.slice(splitAt);
  const recentContext = recent
    .map((turn) => `用户：${compact(turn.input, 500)}\n助理：${compact(turn.output, 900)}`)
    .join('\n');

  if (older.length === 0) {
    return {
      compressedSummary: '无',
      recentContext,
      compressedTurnCount: 0,
      retainedTurnCount: recent.length,
    };
  }

  const topics = older
    .slice(-MAX_SUMMARY_TOPICS)
    .map((turn) => compact(turn.input, 90))
    .filter(Boolean);
  const receipts = older
    .flatMap((turn) => turn.toolReceipts || [])
    .filter((receipt) => receipt.toolName)
    .slice(-MAX_SUMMARY_RECEIPTS)
    .map((receipt) => `${compact(receipt.toolName || '', 64)}:${compact(receipt.businessStatus || 'UNKNOWN', 24)}`);
  const lastConclusion = compact(older.at(-1)?.output || '', 220);
  const summaryParts = [
    `已自动压缩 ${older.length} 轮较早对话。`,
    topics.length ? `近期主题：${topics.join('；')}` : '',
    receipts.length ? `已记录工具回执：${receipts.join('，')}` : '',
    lastConclusion ? `压缩段最后结论：${lastConclusion}` : '',
  ].filter(Boolean);

  return {
    compressedSummary: compact(summaryParts.join('\n'), 1_500),
    recentContext,
    compressedTurnCount: older.length,
    retainedTurnCount: recent.length,
  };
}
