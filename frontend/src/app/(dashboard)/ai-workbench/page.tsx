'use client';

import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  ArrowDown,
  Bot,
  CheckCircle2,
  Clock3,
  ChevronsDown,
  ChevronsUp,
  FileText,
  Loader2,
  MessageCircle,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
  UserRoundCheck,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { useAuthStore } from '@/store/authStore';
import {
  getAssistantBrief,
  getAssistantChatHistory,
  getAssistantPendingActions,
  listAgentRuns,
  cancelAgentRun,
  sendAssistantChat,
  type AssistantBrief,
  type AssistantChatTurn,
  type AssistantPendingAction,
  type AssistantQuoteDeliveryProposal,
} from '@/lib/agent-api';
import type { AgentRun } from '@/types/agent';
import { cn } from '@/lib/utils';
import toast from 'react-hot-toast';
import { getApiErrorMessage } from '@/lib/api-error';
import { useAssistantRuntime } from '@/hooks/use-assistant-runtime';
import { WechatOwnerChannelCard } from '@/components/assistant/wechat-owner-channel-card';
import {
  AssistantRunStatusCard,
  OpenClawToolReceiptList,
  QuoteDeliveryCard,
} from '@/components/assistant/business-assistant-orb';
import {
  PendingAssistantContextChangedError,
  PendingAssistantRequestConflictError,
  assistantPendingStorageKey,
  assistantRequestContextFingerprint,
  assistantThreadIdFor,
  markAssistantRequestCompleted,
  readPendingAssistantRequest,
  reconcilePendingAssistantRequest,
  reserveStoredAssistantRequest,
  subscribePendingAssistantRequest,
  withAssistantRequestLock,
  type PendingAssistantRequest,
} from '@/lib/assistant-chat-outbox';
import { selectAssistantConversationTurns } from '@/lib/assistant-conversation-window';
import { AssistantToolHistory } from '@/components/assistant/assistant-tool-history';
import { AssistantToolComposer } from '@/components/assistant/assistant-tool-composer';

const starterPrompts = [
  '根据真实 CRM 数据，安排我今天的工作顺序',
  '有哪些逾期事项和业务风险？',
  '生成一份今日工作汇报，包含待办、进展和建议',
  '告诉我哪些客户阶段最需要关注',
];

type PreparedQuoteDelivery = {
  preparedFileId: string;
  quoteId: string;
  filename: string;
  size: number;
  sha256: string;
  targetPhone: string;
};

function formatTime(value?: string | null) {
  if (!value) return '—';
  return new Date(value).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function turnReceiptLabel(turn: AssistantChatTurn) {
  if (turn.actionStatus === 'PREPARATION_CONFIRMED') {
    return '已确认准备报价 PDF · 仍需人工发送';
  }
  if (turn.responseKind === 'TASK_CREATED') return '已创建真实任务';
  if (turn.responseKind === 'TASK_STATUS') return '真实任务状态';
  if (turn.responseKind === 'TASK_RESERVATION') return '正在预留真实任务';
  if (turn.responseKind === 'OPENCLAW_TOOL_RESULT') return 'OpenClaw 真实工具回执';
  if (turn.responseKind === 'ACTION_BLOCKED') return '安全阻止 · 未执行';
  if (turn.actionProposal) return '待人工确认 · 未执行外部操作';
  return '建议/草稿';
}

export default function AiWorkbenchPage() {
  const pathname = usePathname();
  const { user, activeCompanyId } = useAuthStore();
  const companyId = activeCompanyId || user?.companies?.[0]?.id || '';
  const threadId = assistantThreadIdFor(companyId, user?.id);
  const [turns, setTurns] = useState<AssistantChatTurn[]>([]);
  const [pendingActions, setPendingActions] = useState<AssistantPendingAction[]>([]);
  const [brief, setBrief] = useState<AssistantBrief | null>(null);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [message, setMessage] = useState('');
  const [pendingRequest, setPendingRequest] = useState<PendingAssistantRequest | null>(null);
  const [historyBaselineReady, setHistoryBaselineReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [preparingActionId, setPreparingActionId] = useState<string | null>(null);
  const [preparedDeliveries, setPreparedDeliveries] = useState<
    Record<string, PreparedQuoteDelivery>
  >({});
  const [cancellingRunId, setCancellingRunId] = useState<string | null>(null);
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const loadSequenceRef = useRef(0);
  const conversationScrollRef = useRef<HTMLDivElement | null>(null);
  const initialConversationScrollRef = useRef(false);
  const pendingStorageKey = assistantPendingStorageKey('workbench', companyId, threadId);
  const assistantRuntime = useAssistantRuntime({
    companyId,
    enabled: !!user && !!companyId,
  });

  useEffect(() => {
    loadSequenceRef.current += 1;
    setTurns([]);
    setPendingActions([]);
    setRuns([]);
    setBrief(null);
    setLoadError(null);
    setPreparedDeliveries({});
    setPendingRequest(null);
    setHistoryBaselineReady(false);
    setHistoryExpanded(false);
    setShowJumpToLatest(false);
    initialConversationScrollRef.current = false;
    setLoading(true);
  }, [companyId, user?.id]);

  const scrollToLatest = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const container = conversationScrollRef.current;
    if (!container) return;
    if (typeof container.scrollTo === 'function') {
      container.scrollTo({ top: container.scrollHeight, behavior });
    } else {
      container.scrollTop = container.scrollHeight;
    }
    setShowJumpToLatest(false);
  }, []);

  useEffect(() => {
    if (!historyBaselineReady) return undefined;
    const frame = window.requestAnimationFrame(() => {
      const container = conversationScrollRef.current;
      if (!container) return;
      const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
      const shouldFollow = !initialConversationScrollRef.current || distanceFromBottom < 120;
      if (shouldFollow) {
        scrollToLatest(initialConversationScrollRef.current ? 'smooth' : 'auto');
        initialConversationScrollRef.current = true;
      } else {
        setShowJumpToLatest(true);
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [historyBaselineReady, scrollToLatest, sending, turns.length]);

  useEffect(() => {
    const stored = readPendingAssistantRequest(pendingStorageKey);
    setPendingRequest(stored);
    if (stored) setMessage((current) => (current.trim() ? current : stored.text));
    return subscribePendingAssistantRequest(pendingStorageKey, (request, previous) => {
      setPendingRequest(request);
      if (request) setMessage((current) => (current.trim() ? current : request.text));
      else if (previous) setMessage((current) => (current === previous.text ? '' : current));
    });
  }, [pendingStorageKey]);

  const load = useCallback(async () => {
    if (!companyId) return;
    const sequence = ++loadSequenceRef.current;
    setLoading(true);
    const [history, pendingActionList, workBrief, runList] = await Promise.allSettled([
      getAssistantChatHistory(companyId, threadId),
      getAssistantPendingActions(companyId),
      getAssistantBrief(companyId),
      listAgentRuns(companyId),
    ]);
    if (sequence !== loadSequenceRef.current) return;
    if (history.status === 'fulfilled') {
      setTurns(history.value);
      const beforeReconcile = readPendingAssistantRequest(pendingStorageKey);
      const reconciledPending = reconcilePendingAssistantRequest(
        pendingStorageKey,
        history.value,
      );
      setPendingRequest(reconciledPending);
      if (beforeReconcile && !reconciledPending) {
        setMessage((current) => (current === beforeReconcile.text ? '' : current));
      }
      setHistoryBaselineReady(true);
    }
    if (pendingActionList.status === 'fulfilled') setPendingActions(pendingActionList.value);
    if (workBrief.status === 'fulfilled') setBrief(workBrief.value);
    if (runList.status === 'fulfilled') setRuns(runList.value);
    const failed = [history, pendingActionList, workBrief, runList].filter(
      (item) => item.status === 'rejected',
    ).length;
    setLoadError(failed ? `有 ${failed} 项助理数据读取失败，当前状态可能不是最新` : null);
    if (sequence === loadSequenceRef.current) setLoading(false);
  }, [companyId, pendingStorageKey, threadId]);

  useEffect(() => {
    void load();
  }, [load]);

  const hasActiveRuns = runs.some((run) =>
    ['PENDING', 'RUNNING', 'AWAITING_APPROVAL'].includes(run.status),
  );

  useEffect(() => {
    if (!hasActiveRuns) return undefined;
    const refreshActiveRuns = () => {
      if (document.visibilityState !== 'hidden' && navigator.onLine) void load();
    };
    const timer = window.setInterval(refreshActiveRuns, 5_000);
    document.addEventListener('visibilitychange', refreshActiveRuns);
    window.addEventListener('online', refreshActiveRuns);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshActiveRuns);
      window.removeEventListener('online', refreshActiveRuns);
    };
  }, [hasActiveRuns, load]);

  const submit = async (preset?: string) => {
    const text = preset ?? message;
    if (!text.trim() || sending) return;
    let retryText = text;
    const contextFingerprint = assistantRequestContextFingerprint({
      companyId,
      threadId,
      pathname,
    });
    setSending(true);
    try {
      await withAssistantRequestLock(pendingStorageKey, async () => {
        const request = reserveStoredAssistantRequest(
          pendingStorageKey,
          text,
          turns,
          historyBaselineReady,
          contextFingerprint,
        );
        retryText = request.text;
        setPendingRequest(request);
        setMessage('');
        const turn = await sendAssistantChat({
          requestId: request.requestId,
          companyId,
          threadId,
          message: request.text,
          pathname,
        });
        setTurns((items) => (items.some((item) => item.id === turn.id) ? items : [...items, turn]));
        markAssistantRequestCompleted(pendingStorageKey, request);
        setPendingRequest(null);
      });
      void load();
    } catch (error: unknown) {
      if (
        error instanceof PendingAssistantRequestConflictError ||
        error instanceof PendingAssistantContextChangedError
      ) {
        toast.error(error.message);
        return;
      }
      toast.error(getApiErrorMessage(error, 'AI 业务助理暂时不可用'));
      setMessage(retryText);
      void load();
    } finally {
      setSending(false);
    }
  };

  const prepareQuoteDelivery = async (turnId: string, proposal: AssistantQuoteDeliveryProposal) => {
    if (
      proposal.status !== 'REQUIRES_CONFIRMATION' ||
      !proposal.quote ||
      !proposal.target ||
      preparingActionId
    )
      return;
    const bridge = window.electronAPI?.agentBridge;
    if (!bridge?.prepareQuoteDelivery) {
      toast.error('当前版本不支持安全报价准备，请安装最新版桌面客户端');
      return;
    }
    setPreparingActionId(turnId);
    try {
      const result = await bridge.prepareQuoteDelivery({ proposalId: turnId });
      if (!result.success || !result.data) throw new Error(result.error || '报价 PDF 准备失败');
      setPreparedDeliveries((current) => ({ ...current, [turnId]: result.data! }));
      setTurns((current) =>
        current.map((turn) =>
          turn.id === turnId
            ? { ...turn, accepted: true, actionStatus: 'PREPARATION_CONFIRMED' }
            : turn,
        ),
      );
      setPendingActions((current) => current.filter((action) => action.id !== turnId));
      toast.success('报价 PDF 已准备，请拖入目标 WhatsApp 聊天并人工点击发送');
    } catch (error: unknown) {
      toast.error(
        getApiErrorMessage(error, error instanceof Error ? error.message : '报价准备失败'),
      );
    } finally {
      setPreparingActionId(null);
    }
  };

  const startQuoteDeliveryDrag = (event: DragEvent<HTMLDivElement>, turnId: string) => {
    const prepared = preparedDeliveries[turnId];
    const quoteFiles = window.electronAPI?.quoteFiles;
    if (!prepared || !quoteFiles) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    void quoteFiles
      .startDrag(prepared.preparedFileId)
      .then((result) => {
        setPreparedDeliveries((current) => {
          const next = { ...current };
          delete next[turnId];
          return next;
        });
        if (!result.success) toast.error(result.error || '无法开始报价文件拖拽，请重新准备');
      })
      .catch((error: unknown) => {
        setPreparedDeliveries((current) => {
          const next = { ...current };
          delete next[turnId];
          return next;
        });
        toast.error(error instanceof Error ? error.message : '无法开始报价文件拖拽');
      });
  };

  const cancelRun = async (runId: string) => {
    if (cancellingRunId) return;
    setCancellingRunId(runId);
    try {
      const cancelled = await cancelAgentRun(runId);
      setRuns((items) =>
        items.map((item) => (item.id === runId ? { ...item, ...cancelled } : item)),
      );
      toast.success('任务已取消');
      void load();
    } catch (error: unknown) {
      toast.error(getApiErrorMessage(error, '任务取消失败，状态可能已经变化'));
    } finally {
      setCancellingRunId(null);
    }
  };

  const activeRuns = runs.filter((run) =>
    ['PENDING', 'RUNNING', 'AWAITING_APPROVAL'].includes(run.status),
  );
  const m = brief?.metrics;
  const visiblePendingActions = pendingActions.filter(
    (action) => !turns.some((turn) => turn.id === action.id),
  );
  const conversationWindow = selectAssistantConversationTurns(turns, historyExpanded);

  return (
    <div className="mx-auto max-w-[1600px] space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-600 to-violet-600 text-white">
              <Bot className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-slate-950">AI 业务助理工作台</h1>
              <p className="text-xs text-slate-500">
                像真人助理一样接收工作、反馈进度、整理待办和汇报结果
              </p>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span
            className="rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-xs font-semibold text-emerald-800"
            data-testid="assistant-supervisor-mode"
          >
            业务主管模式
          </span>
          <button
            onClick={() => {
              void load();
              void assistantRuntime.refresh();
            }}
            className="inline-flex items-center gap-1.5 rounded-lg border bg-white px-3 py-2 text-xs"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            刷新
          </button>
        </div>
      </header>

      {loadError && (
        <div
          className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
          role="status"
        >
          {loadError}
        </div>
      )}

      <div
        className="grid gap-4 xl:h-[calc(100dvh-190px)] xl:min-h-[640px] xl:grid-cols-[minmax(0,1fr)_320px] xl:overflow-hidden 2xl:grid-cols-[240px_minmax(520px,1fr)_340px]"
        data-testid="assistant-workbench-grid"
      >
        <aside className="hidden min-h-0 space-y-4 overflow-y-auto pr-1 2xl:block">
          <Card className="overflow-hidden border-slate-200">
            <div className="bg-gradient-to-br from-slate-950 to-indigo-950 p-4 text-white">
              <div className="flex items-center gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/10">
                  <Sparkles className="h-6 w-6" />
                </div>
                <div>
                  <p className="font-semibold">JY 助理</p>
                  <p className="text-[10px] text-emerald-300">● 在线 · 业务主管权限</p>
                </div>
              </div>
              <p className="mt-3 text-xs leading-5 text-slate-300">
                我会管理客户、订单、待办与报价；涉及对外发送或承诺时会请你确认。
              </p>
            </div>
            <div className="p-3">
              <p className="px-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
                对话快捷入口
              </p>
              <div className="mt-2 space-y-1">
                {starterPrompts.map((prompt) => (
                  <button
                    key={prompt}
                    onClick={() => void submit(prompt)}
                    className="w-full rounded-lg px-2.5 py-2 text-left text-xs leading-4 text-slate-600 hover:bg-indigo-50 hover:text-indigo-800"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>
          </Card>
          <WechatOwnerChannelCard
            companyId={companyId}
            snapshot={assistantRuntime.snapshot}
            loading={assistantRuntime.loading}
            error={assistantRuntime.error}
            onRefresh={() => void assistantRuntime.refresh()}
            compact
          />
          <Card className="border-slate-200 p-3">
            <div className="flex items-start gap-2">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-indigo-600" />
              <div>
                <p className="text-xs font-semibold text-slate-800">权限边界</p>
                <p className="mt-1 text-[10px] leading-4 text-slate-500">
                  可管理客户、订单、待办、报价草稿和客户阶段。WhatsApp 外发、
                  价格承诺及删除类操作仍需当前操作者确认。
                </p>
              </div>
            </div>
          </Card>
        </aside>

        <Card className="flex min-h-[640px] min-w-0 flex-col overflow-hidden border-slate-200 xl:h-full xl:min-h-0">
          <div className="flex items-center justify-between border-b px-5 py-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">与业务助理对话</h2>
              <p className="text-[10px] text-slate-400">对话记录保存在公司数据中，可追溯</p>
            </div>
            <div className="flex items-center gap-2">
              {turns.length > 8 && (
                <button
                  type="button"
                  onClick={() => {
                    const nextExpanded = !historyExpanded;
                    setHistoryExpanded(nextExpanded);
                    window.requestAnimationFrame(() => {
                      const container = conversationScrollRef.current;
                      if (!container) return;
                      if (nextExpanded) container.scrollTop = 0;
                      else scrollToLatest('auto');
                    });
                  }}
                  className="inline-flex items-center gap-1.5 rounded-full border bg-white px-3 py-1.5 text-[11px] font-medium text-slate-600 hover:border-indigo-300 hover:text-indigo-700"
                  data-testid="assistant-history-toggle"
                >
                  {historyExpanded ? (
                    <><ChevronsUp className="h-3.5 w-3.5" /> 收起较早对话</>
                  ) : (
                    <><ChevronsDown className="h-3.5 w-3.5" /> 已自动压缩较早 {conversationWindow.hiddenCount} 轮 · 展开</>
                  )}
                </button>
              )}
              <MessageCircle className="h-4 w-4 text-indigo-500" />
            </div>
          </div>
          <div className="relative min-h-0 flex-1">
          <div
            ref={conversationScrollRef}
            onScroll={(event) => {
              const element = event.currentTarget;
              const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
              setShowJumpToLatest(distance >= 120);
            }}
            className="h-full overflow-y-auto bg-slate-50/60 p-5"
            data-testid="assistant-conversation-scroll"
          >
            {loading && turns.length === 0 && visiblePendingActions.length === 0 ? (
              <div className="flex h-full items-center justify-center gap-2 text-sm text-slate-400">
                <Loader2 className="h-5 w-5 animate-spin" />
                正在准备工作上下文……
              </div>
            ) : turns.length === 0 && visiblePendingActions.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center px-8 text-center">
                <div className="flex h-16 w-16 items-center justify-center rounded-3xl bg-indigo-100 text-indigo-700">
                  <Bot className="h-8 w-8" />
                </div>
                <h3 className="mt-4 text-lg font-semibold text-slate-900">有什么需要我处理？</h3>
                <p className="mt-2 max-w-md text-sm leading-6 text-slate-500">
                  你可以像给真人助理交代工作一样说话。例如：“看一下今天有哪些客户需要跟进，并按优先级安排。”
                </p>
              </div>
            ) : (
              <div className="space-y-5">
                {visiblePendingActions.length > 0 && (
                  <section
                    className="space-y-3 rounded-xl border border-amber-200 bg-amber-50/70 p-4"
                    data-testid="assistant-workbench-pending-actions"
                  >
                    <div>
                      <p className="text-sm font-semibold text-amber-950">跨渠道待确认操作</p>
                      <p className="mt-1 text-xs leading-5 text-amber-800">
                        负责人微信或其他 CRM 对话已生成报价提案。核对后只会准备
                        PDF，不会自动发送给客户。
                      </p>
                    </div>
                    {visiblePendingActions.map((action) => (
                      <div key={action.id} className="space-y-1.5">
                        <p className="text-[10px] font-medium text-amber-800">
                          {action.source === 'WECHAT_OWNER'
                            ? '来自负责人微信'
                            : '来自其他 CRM 对话'}{' '}
                          · {formatTime(action.createdAt)}
                        </p>
                        <QuoteDeliveryCard
                          turnId={action.id}
                          proposal={action.actionProposal}
                          accepted={false}
                          preparing={preparingActionId === action.id}
                          prepared={preparedDeliveries[action.id]}
                          onPrepare={(turnId, proposal) =>
                            void prepareQuoteDelivery(turnId, proposal)
                          }
                          onDragStart={startQuoteDeliveryDrag}
                        />
                      </div>
                    ))}
                  </section>
                )}
                {conversationWindow.visible.map((turn) => {
                  const relatedRun = turn.agentRunId
                    ? runs.find((run) => run.id === turn.agentRunId)
                    : undefined;
                  return (
                    <div key={turn.id} className="space-y-2">
                      <div className="ml-auto max-w-[80%] rounded-2xl rounded-br-md bg-indigo-600 px-4 py-3 text-sm leading-6 text-white">
                        {turn.input}
                      </div>
                      <div className="max-w-[88%] rounded-2xl rounded-bl-md border bg-white px-4 py-3 text-sm leading-7 text-slate-700 shadow-sm">
                        <div className="whitespace-pre-wrap">{turn.output}</div>
                        <div className="mt-2 flex items-center justify-between text-[9px] text-slate-400">
                          <span>{formatTime(turn.createdAt)}</span>
                          <span>{turnReceiptLabel(turn)}</span>
                        </div>
                        {turn.toolReceipts.length > 0 && (
                          <OpenClawToolReceiptList receipts={turn.toolReceipts} />
                        )}
                        {turn.agentRunId &&
                          ['TASK_CREATED', 'TASK_STATUS', 'OPENCLAW_TOOL_RESULT'].includes(
                            turn.responseKind,
                          ) && (
                            <AssistantRunStatusCard
                              run={relatedRun}
                              runId={turn.agentRunId}
                              cancelling={cancellingRunId === turn.agentRunId}
                              onCancel={(runId) => void cancelRun(runId)}
                              compact
                            />
                          )}
                      </div>
                      {turn.actionProposal?.kind === 'PREPARE_QUOTE_DELIVERY' && (
                        <QuoteDeliveryCard
                          turnId={turn.id}
                          proposal={turn.actionProposal}
                          accepted={turn.accepted === true}
                          preparing={preparingActionId === turn.id}
                          prepared={preparedDeliveries[turn.id]}
                          onPrepare={(turnId, proposal) =>
                            void prepareQuoteDelivery(turnId, proposal)
                          }
                          onDragStart={startQuoteDeliveryDrag}
                        />
                      )}
                    </div>
                  );
                })}
                {sending && (
                  <div className="flex max-w-[60%] items-center gap-2 rounded-xl border bg-white px-4 py-3 text-xs text-slate-500">
                    <Loader2 className="h-4 w-4 animate-spin text-indigo-600" />
                    正在识别业务对象、匹配主管权限工具，并等待真实执行回执……
                  </div>
                )}
              </div>
            )}
          </div>
          {showJumpToLatest && (
            <button
              type="button"
              onClick={() => scrollToLatest()}
              className="absolute bottom-4 right-4 z-20 inline-flex items-center gap-1.5 rounded-full bg-slate-900 px-3 py-2 text-[11px] font-semibold text-white shadow-lg"
              data-testid="assistant-jump-to-latest"
            >
              <ArrowDown className="h-3.5 w-3.5" /> 回到最新消息
            </button>
          )}
          </div>
          <div className="border-t bg-white p-4">
            {pendingRequest && (
              <div
                className="mb-2 flex items-center justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800"
                role="status"
                data-testid="assistant-pending-retry"
              >
                <span>上次消息的结果尚未确认；为避免重复执行，请复用原请求重试。</span>
                <button
                  type="button"
                  onClick={() => void submit(pendingRequest.text)}
                  disabled={sending}
                  className="shrink-0 rounded-md border border-amber-300 bg-white px-2 py-1 font-semibold hover:bg-amber-100 disabled:opacity-50"
                >
                  重试上次消息
                </button>
              </div>
            )}
            <div className="flex items-end gap-2 rounded-xl border p-2 focus-within:border-indigo-400 focus-within:ring-2 focus-within:ring-indigo-100">
              <textarea
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    void submit();
                  }
                }}
                rows={2}
                placeholder="交代一项工作，或询问当前业务情况……"
                className="max-h-36 min-h-12 flex-1 resize-none bg-transparent px-2 py-2 text-sm outline-none"
              />
              <button
                type="button"
                aria-label="发送给 AI 业务助理"
                onClick={() => void submit()}
                disabled={
                  !message.trim() ||
                  sending ||
                  (!!pendingRequest && message !== pendingRequest.text)
                }
                className="flex h-10 w-10 items-center justify-center rounded-lg bg-indigo-600 text-white disabled:opacity-40"
              >
                {sending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
              </button>
            </div>
            <p className="mt-2 text-center text-[10px] text-slate-400">
              Enter 发送 · Shift + Enter 换行 · 对话内容原样发送与显示
            </p>
          </div>
        </Card>

        <aside className="min-h-0 space-y-4 overflow-y-auto pr-1">
          <Card className="border-slate-200 p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-slate-400">今日工作概览</p>
                <h2 className="mt-1 font-semibold text-slate-900">业务简报</h2>
              </div>
              <FileText className="h-5 w-5 text-indigo-500" />
            </div>
            <div className="mt-4 grid grid-cols-2 gap-2">
              {[
                [m?.todayReminders || 0, '今日待办'],
                [m?.overdueReminders || 0, '已逾期'],
                [m?.draftQuotes || 0, '待处理报价'],
                [m?.leads || 0, '客户总数'],
              ].map(([value, label]) => (
                <div key={String(label)} className="rounded-lg bg-slate-50 p-2.5">
                  <p className="text-lg font-bold text-slate-900">{value}</p>
                  <p className="text-[10px] text-slate-500">{label}</p>
                </div>
              ))}
            </div>
            <button
              onClick={() =>
                void submit(
                  '请根据当前 CRM 真实数据生成今日工作汇报，包括已完成、待办、风险和下一步建议',
                )
              }
              className="mt-3 w-full rounded-lg bg-indigo-600 px-3 py-2 text-xs font-semibold text-white"
            >
              生成完整工作汇报
            </button>
          </Card>

          <AssistantToolHistory companyId={companyId} />
          <AssistantToolComposer companyId={companyId} />

          <Card className="overflow-hidden border-slate-200">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <div>
                <h2 className="text-sm font-semibold text-slate-900">正在工作的事务</h2>
                <p className="text-[10px] text-slate-400">{activeRuns.length} 项进行中</p>
              </div>
              <Clock3 className="h-4 w-4 text-amber-500" />
            </div>
            {activeRuns.length ? (
              activeRuns.map((run) => (
                <AssistantRunStatusCard
                  key={run.id}
                  run={run}
                  runId={run.id}
                  cancelling={cancellingRunId === run.id}
                  onCancel={(runId) => void cancelRun(runId)}
                />
              ))
            ) : (
              <div className="px-4 py-7 text-center">
                <CheckCircle2 className="mx-auto h-7 w-7 text-emerald-300" />
                <p className="mt-2 text-xs text-slate-400">目前没有执行中的后台任务</p>
              </div>
            )}
          </Card>

          <Card className="overflow-hidden border-slate-200">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <h2 className="text-sm font-semibold text-slate-900">待办事务</h2>
              <Link href="/follow-ups" className="text-[10px] text-indigo-700">
                全部
              </Link>
            </div>
            {brief?.reminders?.length ? (
              brief.reminders.slice(0, 6).map((item) => (
                <Link
                  href={`/follow-ups/${item.id}`}
                  key={item.id}
                  className="flex items-start gap-2 border-b px-4 py-2.5 last:border-0 hover:bg-slate-50"
                >
                  <span
                    className={cn(
                      'mt-1 h-2 w-2 rounded-full',
                      item.priority === 'High' ? 'bg-red-500' : 'bg-amber-400',
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-slate-700">{item.title}</p>
                    <p className="mt-0.5 text-[10px] text-slate-400">{formatTime(item.dueAt)}</p>
                  </div>
                </Link>
              ))
            ) : (
              <p className="px-4 py-6 text-center text-xs text-slate-400">暂无待办</p>
            )}
          </Card>

          <Card className="border-slate-200 p-4">
            <div className="flex items-start gap-2">
              <UserRoundCheck className="mt-0.5 h-4 w-4 text-emerald-600" />
              <div>
                <p className="text-xs font-semibold text-slate-800">专业客户工具仍然保留</p>
                <p className="mt-1 text-[10px] leading-4 text-slate-500">
                  在客户详情页可让助理读取客户摘要、生成跟进草稿；WhatsApp
                  翻译和回复已并入全局悬浮球。
                </p>
                <Link
                  href="/customers"
                  prefetch={false}
                  className="mt-2 inline-block text-[10px] font-medium text-indigo-700"
                >
                  进入客户资产 →
                </Link>
              </div>
            </div>
          </Card>
        </aside>
      </div>
    </div>
  );
}
