'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronRight,
  ChevronsDown,
  ChevronsUp,
  Clipboard,
  FileText,
  ExternalLink,
  GripVertical,
  Languages,
  ListTodo,
  Loader2,
  MessageCircle,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
  WandSparkles,
  X,
} from 'lucide-react';
import toast from 'react-hot-toast';
import api from '@/lib/api';
import {
  getAssistantBrief,
  getAssistantChatHistory,
  getAssistantPendingActions,
  listAgentRuns,
  cancelAgentRun,
  sendAssistantChat,
  type AssistantBrief,
  type AssistantChatTurn,
  type AssistantOpenClawToolReceipt,
  type AssistantPendingAction,
  type AssistantQuoteDeliveryProposal,
  type AssistantWhatsappTextProposal,
} from '@/lib/agent-api';
import { AGENT_KIND_LABELS, AGENT_STATUS_LABELS, type AgentRun } from '@/types/agent';
import { useAuthStore } from '@/store/authStore';
import { useAssistantContextStore } from '@/store/assistant-context-store';
import { cn } from '@/lib/utils';
import { getApiErrorMessage } from '@/lib/api-error';
import { dispatchAssistantEmailDraft } from '@/lib/assistant-draft-events';
import { OwnerNotificationStatusPill } from '@/components/assistant/owner-notification-status';
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

type Tab = 'chat' | 'tasks' | 'tools' | 'report';

type PreparedQuoteDelivery = {
  preparedFileId: string;
  quoteId: string;
  filename: string;
  size: number;
  sha256: string;
  targetPhone: string;
};

const tabs: Array<{ id: Tab; label: string; icon: typeof Bot }> = [
  { id: 'chat', label: '对话', icon: MessageCircle },
  { id: 'tasks', label: '事务', icon: ListTodo },
  { id: 'tools', label: '翻译/回复', icon: Languages },
  { id: 'report', label: '汇报', icon: Clipboard },
];

const quickPrompts = ['今天我先做什么？', '汇总当前待办和逾期事项', '根据真实数据给我一份工作建议'];

export function smartTranslationTarget(text: string): 'zh' | 'en' {
  const compact = text.replace(/\s/g, '');
  if (!compact) return 'zh';
  const hanCount = (compact.match(/[\u3400-\u9fff]/g) || []).length;
  const letterCount = (compact.match(/[A-Za-z]/g) || []).length;
  return hanCount > 0 && hanCount >= letterCount * 0.35 ? 'en' : 'zh';
}

const OPENCLAW_TOOL_LABELS: Record<AssistantOpenClawToolReceipt['toolName'], string> = {
  'crm.work_brief': '读取工作简报',
  'crm.customer_search': '检索客户',
  'crm.customer_get': '读取客户详情',
  'crm.customer_add_note': '新增客户备注',
  'crm.customer_update': '更新客户资料',
  'crm.customer_set_stage': '更新客户阶段',
  'crm.task_create': '创建客户待办',
  'crm.order_list': '读取客户订单',
  'crm.order_create_draft': '创建订单草稿',
  'crm.order_update_stage': '更新订单阶段',
  'crm.quote_list': '读取客户报价',
  'crm.quote_create_draft': '创建美元报价草稿',
  'crm.product_search': '检索美元产品价格',
  'crm.start_background_research': '创建客户背调任务',
  'crm.prepare_quote_delivery': '准备报价交付提案',
  'crm.whatsapp_messages_read': '读取 WhatsApp 消息',
  'crm.whatsapp_send_text': '发送 WhatsApp 单客户消息',
  'crm.whatsapp_send_quote': '发送已审核 WhatsApp 报价',
  'crm.email_messages_read': '读取客户邮件',
  'crm.email_send': '发送客户邮件',
  'crm.email_reply': '回复客户邮件',
};

const OPENCLAW_TOOL_PURPOSES: Record<AssistantOpenClawToolReceipt['toolName'], string> = {
  'crm.work_brief': '汇总当前公司真实业务数据，形成可核对的工作进度。',
  'crm.customer_search': '在当前公司范围内检索客户，并确认是否只有一个可信匹配。',
  'crm.customer_get': '读取已唯一匹配客户的资料、阶段和关联业务信息。',
  'crm.customer_add_note': '把本次沟通结论写入已核验客户的时间线。',
  'crm.customer_update': '按指令更新已核验客户资料，并保留审计记录。',
  'crm.customer_set_stage': '根据明确指令推进已核验客户的销售阶段。',
  'crm.task_create': '为已核验客户创建负责人可追踪的待办任务。',
  'crm.order_list': '读取已核验客户的真实订单和当前交付阶段。',
  'crm.order_create_draft': '基于已核验客户和产品信息创建订单草稿。',
  'crm.order_update_stage': '更新指定订单阶段并记录前后状态。',
  'crm.quote_list': '读取已核验客户已有报价，避免引用错误报价。',
  'crm.quote_create_draft': '使用产品资料库的美元价格创建可审核报价草稿。',
  'crm.product_search': '从产品资料库检索美元价格、MOQ 和规格。',
  'crm.start_background_research': '为唯一匹配客户创建真实后台背调任务。',
  'crm.prepare_quote_delivery': '核验客户与报价关系，准备交付确认材料。',
  'crm.whatsapp_messages_read': '读取当前可信一对一 WhatsApp 会话的近期消息。',
  'crm.whatsapp_send_text': '仅向当前已核验的一对一 WhatsApp 客户发送本次文本。',
  'crm.whatsapp_send_quote': '仅向当前已核验客户发送已审核报价 PDF，并等待渠道回执。',
  'crm.email_messages_read': '读取唯一可信客户邮箱关联的近期邮件。',
  'crm.email_send': '向唯一可信客户邮箱发送本次邮件，并等待 SMTP 回执。',
  'crm.email_reply': '回复已核验的原邮件线程，并等待 SMTP 回执。',
};

function turnKindLabel(turn: AssistantChatTurn) {
  if (turn.responseKind === 'TASK_RESERVATION') return '正在预留真实任务';
  if (turn.responseKind === 'TASK_CREATED') return '已创建任务';
  if (turn.responseKind === 'TASK_STATUS') return '真实任务状态';
  if (turn.responseKind === 'ACTION_BLOCKED') return '安全阻止';
  if (turn.responseKind === 'OPENCLAW_TOOL_RESULT') return 'OpenClaw 真实工具回执';
  return '建议/草稿';
}

function formatTime(value?: string | null) {
  if (!value) return '—';
  return new Date(value).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function BusinessAssistantOrb() {
  const pathname = usePathname();
  const isWhatsAppWorkspace = pathname === '/whatsapp/chat';
  const hideGlobalOrb = pathname === '/ai-workbench';
  const { user, activeCompanyId } = useAuthStore();
  const whatsapp = useAssistantContextStore((state) => state.whatsapp);
  const companyId = activeCompanyId || user?.companies?.[0]?.id || '';
  const threadId = assistantThreadIdFor(companyId, user?.id);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('chat');
  const [turns, setTurns] = useState<AssistantChatTurn[]>([]);
  const [pendingActions, setPendingActions] = useState<AssistantPendingAction[]>([]);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [brief, setBrief] = useState<AssistantBrief | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState('');
  const [pendingRequest, setPendingRequest] = useState<PendingAssistantRequest | null>(null);
  const [historyBaselineReady, setHistoryBaselineReady] = useState(false);
  const [toolText, setToolText] = useState('');
  const [toolResult, setToolResult] = useState('');
  const [toolLoading, setToolLoading] = useState<'translate' | 'reply' | null>(null);
  const [toolFilling, setToolFilling] = useState<'whatsapp' | 'email' | 'send' | null>(null);
  const [preparingActionId, setPreparingActionId] = useState<string | null>(null);
  const [sendingActionId, setSendingActionId] = useState<string | null>(null);
  const [preparedDeliveries, setPreparedDeliveries] = useState<
    Record<string, PreparedQuoteDelivery>
  >({});
  const [cancellingRunId, setCancellingRunId] = useState<string | null>(null);
  const refreshSequenceRef = useRef(0);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const lastAutoScrolledTurnRef = useRef<string | null>(null);
  const pendingStorageKey = assistantPendingStorageKey('orb', companyId, threadId);

  useEffect(() => {
    refreshSequenceRef.current += 1;
    setTurns([]);
    setPendingActions([]);
    setRuns([]);
    setBrief(null);
    setRefreshError(null);
    setPreparedDeliveries({});
    setPendingRequest(null);
    setHistoryBaselineReady(false);
    setLoading(false);
  }, [companyId, user?.id]);

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

  const refresh = useCallback(async () => {
    if (!companyId) return;
    const sequence = ++refreshSequenceRef.current;
    setLoading(true);
    try {
      const [historyResult, pendingActionResult, briefResult, runResult] = await Promise.allSettled(
        [
          getAssistantChatHistory(companyId, threadId),
          getAssistantPendingActions(companyId),
          getAssistantBrief(companyId),
          listAgentRuns(companyId),
        ],
      );
      if (sequence !== refreshSequenceRef.current) return;
      if (historyResult.status === 'fulfilled') {
        setTurns(historyResult.value);
        const beforeReconcile = readPendingAssistantRequest(pendingStorageKey);
        const reconciledPending = reconcilePendingAssistantRequest(
          pendingStorageKey,
          historyResult.value,
        );
        setPendingRequest(reconciledPending);
        if (beforeReconcile && !reconciledPending) {
          setMessage((current) => (current === beforeReconcile.text ? '' : current));
        }
        setHistoryBaselineReady(true);
      }
      if (pendingActionResult.status === 'fulfilled') setPendingActions(pendingActionResult.value);
      if (briefResult.status === 'fulfilled') setBrief(briefResult.value);
      if (runResult.status === 'fulfilled') setRuns(runResult.value);
      const failed = [historyResult, pendingActionResult, briefResult, runResult].filter(
        (result) => result.status === 'rejected',
      ).length;
      setRefreshError(failed ? `有 ${failed} 项助理数据刷新失败，当前内容可能不是最新状态` : null);
    } finally {
      if (sequence === refreshSequenceRef.current) setLoading(false);
    }
  }, [companyId, pendingStorageKey, threadId]);

  useEffect(() => {
    if (!open) {
      lastAutoScrolledTurnRef.current = null;
      return;
    }
    if (tab !== 'chat' || !historyBaselineReady) return;
    const latestTurnId = turns.at(-1)?.id || 'empty';
    const firstOpen = lastAutoScrolledTurnRef.current === null;
    if (!firstOpen && lastAutoScrolledTurnRef.current === latestTurnId) return;
    const frame = window.requestAnimationFrame(() => {
      const container = chatScrollRef.current;
      if (!container) return;
      container.scrollTo({
        top: container.scrollHeight,
        behavior: firstOpen ? 'auto' : 'smooth',
      });
      lastAutoScrolledTurnRef.current = latestTurnId;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [historyBaselineReady, open, tab, turns]);

  useEffect(() => {
    if (open && document.visibilityState !== 'hidden' && navigator.onLine) void refresh();
  }, [open, refresh]);

  useEffect(() => {
    if (!open) return undefined;
    const refreshWhenAvailable = () => {
      if (document.visibilityState !== 'hidden' && navigator.onLine) void refresh();
    };
    const timer = window.setInterval(refreshWhenAvailable, 5_000);
    document.addEventListener('visibilitychange', refreshWhenAvailable);
    window.addEventListener('online', refreshWhenAvailable);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshWhenAvailable);
      window.removeEventListener('online', refreshWhenAvailable);
    };
  }, [open, refresh]);

  useEffect(() => {
    setToolText(whatsapp?.lastMessage || '');
    setToolResult('');
  }, [whatsapp?.lastMessage, whatsapp?.phone]);

  const submitChat = async (text = message) => {
    const value = text;
    if (!value.trim() || !companyId || sending) return;
    let retryText = value;
    const requestWhatsapp = whatsapp
      ? {
          name: whatsapp.name,
          phone: whatsapp.phone,
          conversationId: whatsapp.conversationId,
          leadId: whatsapp.leadId,
          isGroup: whatsapp.isGroup,
        }
      : undefined;
    const contextFingerprint = assistantRequestContextFingerprint({
      companyId,
      threadId,
      pathname,
      whatsapp: requestWhatsapp,
    });
    setSending(true);
    try {
      await withAssistantRequestLock(pendingStorageKey, async () => {
        const request = reserveStoredAssistantRequest(
          pendingStorageKey,
          value,
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
          whatsapp: requestWhatsapp,
        });
        setTurns((items) => (items.some((item) => item.id === turn.id) ? items : [...items, turn]));
        markAssistantRequestCompleted(pendingStorageKey, request);
        setPendingRequest(null);
      });
      void refresh();
    } catch (error: unknown) {
      if (
        error instanceof PendingAssistantRequestConflictError ||
        error instanceof PendingAssistantContextChangedError
      ) {
        toast.error(error.message);
        return;
      }
      toast.error(getApiErrorMessage(error, 'AI 业务助理暂时无法回答'));
      setMessage(retryText);
      void refresh();
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
      const result = await bridge.prepareQuoteDelivery({
        proposalId: turnId,
      });
      if (!result.success || !result.data) {
        throw new Error(result.error || '报价 PDF 准备失败');
      }
      setPreparedDeliveries((current) => ({ ...current, [turnId]: result.data! }));
      setTurns((current) =>
        current.map((turn) =>
          turn.id === turnId
            ? { ...turn, accepted: true, actionStatus: 'PREPARATION_CONFIRMED' }
            : turn,
        ),
      );
      setPendingActions((current) => current.filter((action) => action.id !== turnId));
      toast.success('报价 PDF 已准备，请拖入当前 WhatsApp 聊天并人工点击发送');
    } catch (error: unknown) {
      toast.error(
        getApiErrorMessage(error, error instanceof Error ? error.message : '报价准备失败'),
      );
    } finally {
      setPreparingActionId(null);
    }
  };

  const startQuoteDeliveryDrag = (event: React.DragEvent<HTMLDivElement>, turnId: string) => {
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
        // 原生拖拽句柄是一次性的。无论成功还是失败，都回到“重新核验并准备”状态，
        // 避免用户取消拖拽后面对一张看似仍可用、实际上已失效的卡片。
        setPreparedDeliveries((current) => {
          const next = { ...current };
          delete next[turnId];
          return next;
        });
        if (!result.success) {
          toast.error(result.error || '无法开始报价文件拖拽，请重新核验并准备');
          return;
        }
        toast.success('已启动文件拖拽；如未放入 WhatsApp，请重新核验并准备');
      })
      .catch((error: unknown) => {
        setPreparedDeliveries((current) => {
          const next = { ...current };
          delete next[turnId];
          return next;
        });
        toast.error(
          error instanceof Error ? error.message : '无法开始报价文件拖拽，请重新核验并准备',
        );
      });
  };

  const runTool = async (kind: 'translate' | 'reply') => {
    if (!toolText.trim() || toolLoading) return;
    setToolLoading(kind);
    setToolResult('');
    try {
      if (kind === 'translate') {
        const targetLanguage = smartTranslationTarget(toolText);
        const response = await api.post('/ai-communications/translate-draft', {
          text: toolText.trim(),
          targetLanguage,
        });
        setToolResult(response.data?.draft || '未返回翻译结果');
      } else {
        const context = whatsapp
          ? `当前 WhatsApp 客户：${whatsapp.name} ${whatsapp.phone}\n客户消息：${toolText.trim()}`
          : toolText.trim();
        const response = await api.post('/ai-communications/generate-reply', {
          context,
          targetLanguage: 'en',
        });
        const replies = Array.isArray(response.data?.replies) ? response.data.replies : [];
        setToolResult(replies.join('\n\n'));
      }
    } catch (error: unknown) {
      toast.error(getApiErrorMessage(error, 'AI 工具暂时不可用'));
    } finally {
      setToolLoading(null);
    }
  };

  const fillGeneratedDraft = async (target: 'whatsapp' | 'email') => {
    const value = toolResult.trim();
    if (!value || toolFilling) return;
    setToolFilling(target);
    try {
      if (target === 'email') {
        if (!dispatchAssistantEmailDraft(value)) {
          toast.error('请先进入邮件中心并打开一封邮件，再填入回复草稿');
          return;
        }
        toast.success('已填入当前邮件回复框，请核对后发送');
        return;
      }

      if (
        !isWhatsAppWorkspace
        || !whatsapp?.phone
        || !whatsapp.name
        || !whatsapp.accountId
        || !whatsapp.selectionProof
        || whatsapp.isGroup
      ) {
        toast.error('请先在 WhatsApp 中选择一个有可信号码的单聊客户');
        return;
      }
      const fillDraft = window.electronAPI?.whatsapp?.fillDraft;
      if (!fillDraft) {
        toast.error('当前桌面客户端不支持安全填入，请安装最新版本');
        return;
      }
      const result = await fillDraft({
        text: value,
        targetPhone: whatsapp.phone,
        targetName: whatsapp.name,
        targetAccountId: whatsapp.accountId,
        selectionProof: whatsapp.selectionProof,
      });
      if (!result.success) throw new Error(result.error || 'WhatsApp 草稿填入失败');
      toast.success(`已填入 ${whatsapp.name || whatsapp.phone} 的输入框，请核对后发送`);
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : '草稿填入失败');
    } finally {
      setToolFilling(null);
    }
  };

  const sendGeneratedWhatsapp = async () => {
    const value = toolResult.trim();
    if (!value || toolFilling) return;
    if (
      !isWhatsAppWorkspace
      || !whatsapp?.conversationId
      || !whatsapp.phone
      || !whatsapp.name
      || !whatsapp.accountId
      || !whatsapp.selectionProof
      || whatsapp.isGroup
    ) {
      toast.error('真实发送需要当前 WhatsApp 单聊已关联可信 CRM 会话和完整号码');
      return;
    }
    const confirmed = window.confirm(
      `确认由业务助理向 ${whatsapp.name || whatsapp.phone} 发送这段消息？\n\n${value}`,
    );
    if (!confirmed) return;
    const sendWhatsappText = window.electronAPI?.agentBridge?.sendWhatsappText;
    if (!sendWhatsappText) {
      toast.error('当前桌面客户端不支持一次性授权发送，请安装最新版本');
      return;
    }
    setToolFilling('send');
    try {
      const result = await sendWhatsappText({
        conversationId: whatsapp.conversationId,
        targetPhone: whatsapp.phone,
        targetName: whatsapp.name,
        targetAccountId: whatsapp.accountId,
        selectionProof: whatsapp.selectionProof,
        text: value,
      });
      if (!result.success) throw new Error(result.error || 'WhatsApp 消息未发送');
      toast.success(result.warning || `已向 ${whatsapp.name || whatsapp.phone} 发出消息`);
      if (!result.warning) setToolResult('');
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : 'WhatsApp 发送失败');
    } finally {
      setToolFilling(null);
    }
  };

  const sendWhatsappProposal = async (
    turnId: string,
    proposal: AssistantWhatsappTextProposal,
  ) => {
    if (
      proposal.status !== 'REQUIRES_CONFIRMATION'
      || !proposal.text
      || !proposal.target?.conversationId
      || sendingActionId
    ) return;
    if (
      !isWhatsAppWorkspace
      || !whatsapp?.conversationId
      || whatsapp.conversationId !== proposal.target.conversationId
      || whatsapp.phone.replace(/\D/g, '') !== proposal.target.phone.replace(/\D/g, '')
      || !whatsapp.name
      || !whatsapp.accountId
      || !whatsapp.selectionProof
      || whatsapp.isGroup
    ) {
      toast.error('请在 WhatsApp 聊天页重新选中提案中的客户，再确认发送');
      return;
    }
    if (!window.confirm(`确认向 ${proposal.target.name} 发送这条消息？\n\n${proposal.text}`)) {
      return;
    }
    const bridge = window.electronAPI?.agentBridge?.sendWhatsappText;
    if (!bridge) {
      toast.error('当前桌面客户端不支持一次性授权发送，请安装最新版本');
      return;
    }
    setSendingActionId(turnId);
    try {
      const result = await bridge({
        conversationId: proposal.target.conversationId,
        targetPhone: proposal.target.phone,
        targetName: whatsapp.name,
        targetAccountId: whatsapp.accountId,
        selectionProof: whatsapp.selectionProof,
        text: proposal.text,
      });
      if (!result.success) throw new Error(result.error || 'WhatsApp 消息未发送');
      setTurns((items) => items.map((turn) => (
        turn.id === turnId
          ? { ...turn, accepted: true, actionStatus: 'SENT', businessStatus: 'SUCCEEDED' }
          : turn
      )));
      toast.success(result.warning || `已向 ${proposal.target.name} 发出消息`);
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : 'WhatsApp 发送失败');
    } finally {
      setSendingActionId(null);
    }
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
      void refresh();
    } catch (error: unknown) {
      toast.error(getApiErrorMessage(error, '任务取消失败，状态可能已经变化'));
    } finally {
      setCancellingRunId(null);
    }
  };

  const running = useMemo(
    () => runs.filter((run) => ['PENDING', 'RUNNING', 'AWAITING_APPROVAL'].includes(run.status)),
    [runs],
  );
  const finished = useMemo(
    () => runs.filter((run) => ['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.status)),
    [runs],
  );

  if (hideGlobalOrb) return null;

  return (
    <>
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="fixed bottom-5 right-5 z-[80] flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br from-indigo-600 via-violet-600 to-fuchsia-500 text-white shadow-[0_12px_35px_rgba(79,70,229,.35)] transition-all hover:scale-105"
          aria-label="打开 AI 业务助理"
          data-testid="assistant-orb-trigger"
        >
          <Sparkles className="h-6 w-6" />
          {(brief?.metrics.overdueReminders || 0) > 0 && (
            <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold ring-2 ring-white">
              {Math.min(brief?.metrics.overdueReminders || 0, 99)}
            </span>
          )}
        </button>
      )}

      {open && (
        <section
          data-placement={isWhatsAppWorkspace ? 'whatsapp-drawer' : 'floating'}
          className={cn(
            'fixed z-[79] flex flex-col overflow-hidden border border-slate-200 bg-white shadow-2xl',
            isWhatsAppWorkspace
              ? 'bottom-0 right-0 top-16 h-auto w-[412px] max-w-[calc(100vw-16px)] rounded-none border-b-0 border-r-0'
              : 'bottom-20 right-5 h-[min(720px,calc(100vh-110px))] w-[min(440px,calc(100vw-32px))] rounded-2xl',
          )}
          aria-label="AI 业务助理"
        >
          <header className="border-b bg-gradient-to-r from-slate-950 via-indigo-950 to-slate-900 px-4 py-3 text-white">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-white/10 ring-1 ring-white/15">
                <Bot className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="font-semibold">JY AI 业务助理</h2>
                <p className="truncate text-[11px] text-slate-300">
                  业务主管：客户 · 订单 · WhatsApp · 邮件 · 真实回执
                </p>
              </div>
              <button
                onClick={() => void refresh()}
                className="rounded-lg p-2 hover:bg-white/10"
                aria-label="刷新"
              >
                <RefreshCw className={cn('h-4 w-4', loading && 'animate-spin')} />
              </button>
              <button
                onClick={() => setOpen(false)}
                className="rounded-lg p-2 hover:bg-white/10"
                aria-label="关闭"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {whatsapp && (
              <div className="mt-2 rounded-lg bg-emerald-400/10 px-3 py-1.5 text-[11px] text-emerald-200">
                当前 WhatsApp：{whatsapp.name || whatsapp.phone}
              </div>
            )}
            <OwnerNotificationStatusPill companyId={companyId} compact className="mt-2 max-w-full" />
          </header>

          <nav className="grid grid-cols-4 border-b bg-slate-50 px-2">
            {tabs.map((item) => (
              <button
                key={item.id}
                onClick={() => setTab(item.id)}
                className={cn(
                  'flex items-center justify-center gap-1.5 border-b-2 px-1 py-2.5 text-xs',
                  tab === item.id
                    ? 'border-indigo-600 font-semibold text-indigo-700'
                    : 'border-transparent text-slate-500 hover:text-slate-800',
                )}
              >
                <item.icon className="h-3.5 w-3.5" />
                {item.label}
              </button>
            ))}
          </nav>

          {refreshError && (
            <div
              className="flex items-center gap-2 border-b border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800"
              role="status"
            >
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
              <span>{refreshError}</span>
            </div>
          )}

          <div
            ref={chatScrollRef}
            className="min-h-0 flex-1 overflow-y-auto bg-slate-50/60 p-3"
            data-testid="assistant-orb-conversation-scroll"
          >
            {tab === 'chat' && (
              <ChatTab
                turns={turns}
                pendingActions={pendingActions.filter(
                  (action) => !turns.some((turn) => turn.id === action.id),
                )}
                sending={sending}
                onQuick={(value) => void submitChat(value)}
                preparingActionId={preparingActionId}
                preparedDeliveries={preparedDeliveries}
                onPrepare={(turnId, proposal) => void prepareQuoteDelivery(turnId, proposal)}
                sendingActionId={sendingActionId}
                onSendWhatsapp={(turnId, proposal) => void sendWhatsappProposal(turnId, proposal)}
                onDragStart={startQuoteDeliveryDrag}
                runs={runs}
                cancellingRunId={cancellingRunId}
                onCancel={(runId) => void cancelRun(runId)}
              />
            )}
            {tab === 'tasks' && (
              <TasksTab
                brief={brief}
                running={running}
                finished={finished}
                cancellingRunId={cancellingRunId}
                onCancel={(runId) => void cancelRun(runId)}
              />
            )}
            {tab === 'tools' && (
              <ToolsTab
                whatsappName={whatsapp?.name}
                canFillWhatsapp={
                  isWhatsAppWorkspace
                  && !!whatsapp?.phone
                  && !!whatsapp?.name
                  && !!whatsapp?.accountId
                  && !!whatsapp?.selectionProof
                  && whatsapp.isGroup !== true
                }
                canSendWhatsapp={
                  isWhatsAppWorkspace
                  && !!whatsapp?.conversationId
                  && !!whatsapp?.phone
                  && !!whatsapp?.name
                  && !!whatsapp?.accountId
                  && !!whatsapp?.selectionProof
                  && whatsapp.isGroup !== true
                }
                canFillEmail={pathname === '/emails' || pathname === '/communication'}
                text={toolText}
                result={toolResult}
                loading={toolLoading}
                filling={toolFilling}
                onText={setToolText}
                onRun={runTool}
                onFill={(target) => void fillGeneratedDraft(target)}
                onSend={() => void sendGeneratedWhatsapp()}
              />
            )}
            {tab === 'report' && (
              <ReportTab
                brief={brief}
                runs={runs}
                onAsk={(value) => {
                  setTab('chat');
                  void submitChat(value);
                }}
              />
            )}
          </div>

          {tab === 'chat' && (
            <footer className="border-t bg-white p-3">
              {pendingRequest && (
                <div
                  className="mb-2 flex items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-[10px] text-amber-800"
                  role="status"
                  data-testid="assistant-orb-pending-retry"
                >
                  <span>上次消息结果待确认，请复用原请求重试。</span>
                  <button
                    type="button"
                    onClick={() => void submitChat(pendingRequest.text)}
                    disabled={sending}
                    className="shrink-0 rounded border border-amber-300 bg-white px-2 py-1 font-semibold disabled:opacity-50"
                  >
                    重试上次消息
                  </button>
                </div>
              )}
              {turns.length === 0 && (
                <div className="mb-2 flex gap-1.5 overflow-x-auto pb-1">
                  {quickPrompts.map((prompt) => (
                    <button
                      key={prompt}
                      onClick={() => void submitChat(prompt)}
                      className="shrink-0 rounded-full border bg-slate-50 px-2.5 py-1 text-[10px] text-slate-600 hover:border-indigo-300"
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              )}
              <div className="flex items-end gap-2 rounded-xl border bg-white p-2 focus-within:border-indigo-400 focus-within:ring-2 focus-within:ring-indigo-100">
                <textarea
                  value={message}
                  onChange={(event) => setMessage(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault();
                      void submitChat();
                    }
                  }}
                  rows={1}
                  placeholder="交代工作、问数据、让助理起草……"
                  className="max-h-28 min-h-9 flex-1 resize-none bg-transparent px-1 py-2 text-sm outline-none"
                />
                <button
                  type="button"
                  aria-label="发送给 AI 业务助理"
                  onClick={() => void submitChat()}
                  disabled={
                    !message.trim() ||
                    sending ||
                    (!!pendingRequest && message !== pendingRequest.text)
                  }
                  className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-600 text-white disabled:opacity-40"
                >
                  {sending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )}
                </button>
              </div>
            </footer>
          )}
          <Link
            href="/ai-workbench"
            onClick={() => setOpen(false)}
            className="flex items-center justify-center gap-1 border-t bg-white py-2 text-[11px] font-medium text-indigo-700 hover:bg-indigo-50"
          >
            进入完整业务助理工作台 <ChevronRight className="h-3 w-3" />
          </Link>
        </section>
      )}
    </>
  );
}

function ChatTab({
  turns,
  pendingActions,
  sending,
  onQuick,
  preparingActionId,
  sendingActionId,
  preparedDeliveries,
  onPrepare,
  onSendWhatsapp,
  onDragStart,
  runs,
  cancellingRunId,
  onCancel,
}: {
  turns: AssistantChatTurn[];
  pendingActions: AssistantPendingAction[];
  sending: boolean;
  onQuick: (value: string) => void;
  preparingActionId: string | null;
  sendingActionId: string | null;
  preparedDeliveries: Record<string, PreparedQuoteDelivery>;
  onPrepare: (turnId: string, proposal: AssistantQuoteDeliveryProposal) => void;
  onSendWhatsapp: (turnId: string, proposal: AssistantWhatsappTextProposal) => void;
  onDragStart: (event: React.DragEvent<HTMLDivElement>, turnId: string) => void;
  runs: AgentRun[];
  cancellingRunId: string | null;
  onCancel: (runId: string) => void;
}) {
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const conversationWindow = selectAssistantConversationTurns(turns, historyExpanded);
  if (turns.length === 0 && pendingActions.length === 0 && !sending)
    return (
      <div className="flex min-h-full flex-col items-center justify-center px-6 py-12 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-100 text-indigo-700">
          <Bot className="h-7 w-7" />
        </div>
        <h3 className="mt-4 font-semibold text-slate-900">早上好，我是你的业务助理</h3>
        <p className="mt-2 text-xs leading-5 text-slate-500">
          我会调用已接入的 CRM、WhatsApp 和邮件工具完成工作；只有工具回执和 provider messageId
          才表示真实执行成功。
        </p>
        <div className="mt-3 grid w-full max-w-xs grid-cols-2 gap-2 text-[11px]">
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-2 py-2 text-emerald-800">
            可管理：客户与订单
          </div>
          <div className="rounded-lg border border-blue-200 bg-blue-50 px-2 py-2 text-blue-800">
            可执行：待办、报价与客户维护
          </div>
          <div className="col-span-2 rounded-lg border border-amber-200 bg-amber-50 px-2 py-2 text-amber-800">
            主管模式可对明确的单一客户真实收发 WhatsApp 与邮件；批量外发、删除和关键价格承诺仍会二次确认
          </div>
        </div>
        <button
          onClick={() => onQuick('请根据当前 CRM 数据告诉我今天最重要的三件事')}
          className="mt-4 rounded-lg bg-indigo-600 px-3 py-2 text-xs font-medium text-white"
        >
          生成今日工作重点
        </button>
      </div>
    );
  return (
    <div className="space-y-4">
      {turns.length > 8 && (
        <div className="sticky top-0 z-10 flex justify-center pb-1">
          <button
            type="button"
            onClick={() => setHistoryExpanded((value) => !value)}
            className="inline-flex items-center gap-1 rounded-full border bg-white/95 px-2.5 py-1.5 text-[10px] font-medium text-slate-600 shadow-sm backdrop-blur"
            data-testid="assistant-orb-history-toggle"
          >
            {historyExpanded ? (
              <><ChevronsUp className="h-3 w-3" /> 收起较早对话</>
            ) : (
              <><ChevronsDown className="h-3 w-3" /> 已压缩较早 {conversationWindow.hiddenCount} 轮 · 展开</>
            )}
          </button>
        </div>
      )}
      {pendingActions.length > 0 && (
        <section
          className="space-y-3 rounded-xl border border-amber-200 bg-amber-50/70 p-3"
          data-testid="assistant-cross-channel-pending-actions"
        >
          <div>
            <p className="text-xs font-semibold text-amber-950">跨渠道待确认操作</p>
            <p className="mt-1 text-[10px] leading-4 text-amber-800">
              这些提案来自负责人微信或其他 CRM 对话；核对后只会准备 PDF，仍需你手动拖入 WhatsApp
              并点击发送。
            </p>
          </div>
          {pendingActions.map((action) => (
            <div key={action.id} className="space-y-1.5">
              <p className="text-[10px] font-medium text-amber-800">
                {action.source === 'WECHAT_OWNER' ? '来自负责人微信' : '来自其他 CRM 对话'} ·{' '}
                {formatTime(action.createdAt)}
              </p>
              <QuoteDeliveryCard
                turnId={action.id}
                proposal={action.actionProposal}
                accepted={false}
                preparing={preparingActionId === action.id}
                prepared={preparedDeliveries[action.id]}
                onPrepare={onPrepare}
                onDragStart={onDragStart}
              />
            </div>
          ))}
        </section>
      )}
      {conversationWindow.visible.map((turn) => (
        <div key={turn.id} className="space-y-2">
          <div className="ml-10 rounded-2xl rounded-br-md bg-indigo-600 px-3 py-2.5 text-sm leading-5 text-white">
            {turn.input}
          </div>
          <div className="mr-6 rounded-2xl rounded-bl-md border bg-white px-3 py-2.5 text-sm leading-6 text-slate-700 shadow-sm">
            <div className="whitespace-pre-wrap">{turn.output}</div>
            <p className="mt-2 text-[9px] text-slate-400">
              {formatTime(turn.createdAt)} · {turnKindLabel(turn)}
            </p>
            {turn.toolReceipts.length > 0 && (
              <OpenClawToolReceiptList receipts={turn.toolReceipts} compact />
            )}
            {(turn.responseKind === 'TASK_CREATED' ||
              turn.responseKind === 'TASK_STATUS' ||
              turn.responseKind === 'OPENCLAW_TOOL_RESULT') &&
              turn.agentRunId && (
                <AssistantRunStatusCard
                  run={runs.find((item) => item.id === turn.agentRunId)}
                  runId={turn.agentRunId}
                  cancelling={cancellingRunId === turn.agentRunId}
                  onCancel={onCancel}
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
              onPrepare={onPrepare}
              onDragStart={onDragStart}
            />
          )}
          {turn.actionProposal?.kind === 'SEND_WHATSAPP_TEXT' && (
            <WhatsappTextSendCard
              proposal={turn.actionProposal}
              sent={turn.actionStatus === 'SENT'}
              sending={sendingActionId === turn.id}
              onSend={() => onSendWhatsapp(turn.id, turn.actionProposal as AssistantWhatsappTextProposal)}
            />
          )}
        </div>
      ))}
      {sending && (
        <div className="mr-20 flex items-center gap-2 rounded-xl border bg-white px-3 py-3 text-xs text-slate-500">
          <Loader2 className="h-4 w-4 animate-spin text-indigo-600" />
          助理正在识别业务对象、匹配主管权限工具，并等待真实执行回执……
        </div>
      )}
    </div>
  );
}

export function OpenClawToolReceiptList({
  receipts,
  compact = false,
}: {
  receipts: AssistantOpenClawToolReceipt[];
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        'mt-3 space-y-2 rounded-lg border border-indigo-100 bg-indigo-50/50',
        compact ? 'p-2' : 'p-3',
      )}
      data-testid="openclaw-tool-receipts"
    >
      <div className="flex items-center gap-1.5 text-[10px] font-semibold text-indigo-900">
        <ShieldCheck className="h-3.5 w-3.5" />
        AI 工作过程 · 可审计执行轨迹
      </div>
      <p className="text-[9px] leading-4 text-slate-500">
        展示可验证的任务计划、对象匹配、工具调用和真实回执；不展示模型私有草稿。
      </p>
      <div className="grid grid-cols-2 gap-1 text-[9px] text-slate-500">
        <span className="rounded bg-white px-1.5 py-1 text-center">1. 理解任务</span>
        <span className="rounded bg-white px-1.5 py-1 text-center">2. 匹配业务对象</span>
        <span className="rounded bg-white px-1.5 py-1 text-center">3. 调用业务工具</span>
        <span className="rounded bg-white px-1.5 py-1 text-center">4. 核验真实回执</span>
      </div>
      {receipts.map((receipt) => (
        <div
          key={`${receipt.requestId}:${receipt.toolName}`}
          className="flex items-start justify-between gap-3 rounded-md border bg-white px-2 py-1.5 text-[10px]"
        >
          <div className="min-w-0">
            <p className="font-medium text-slate-700">{OPENCLAW_TOOL_LABELS[receipt.toolName]}</p>
            <p className="mt-0.5 leading-4 text-slate-500">
              执行说明：{OPENCLAW_TOOL_PURPOSES[receipt.toolName]}
            </p>
            <p className="mt-0.5 truncate text-slate-400" title={receipt.agentRunId}>
              任务编号：{receipt.agentRunId}
            </p>
            <p className="mt-0.5 text-slate-400">
              回执：{receipt.requestId.slice(0, 12)}… · {receipt.completedAt ? formatTime(receipt.completedAt) : '处理中'}
            </p>
            {receipt.errorCode && (
              <p className="mt-0.5 text-red-600">错误码：{receipt.errorCode}</p>
            )}
          </div>
          <span
            className={cn(
              'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 font-semibold',
              receipt.businessStatus === 'SUCCEEDED'
                ? 'bg-emerald-100 text-emerald-700'
                : receipt.businessStatus === 'FAILED'
                  ? 'bg-red-100 text-red-700'
                  : receipt.businessStatus === 'BLOCKED'
                    ? 'bg-slate-200 text-slate-700'
                    : 'bg-amber-100 text-amber-700',
            )}
          >
            {receipt.businessStatus === 'SUCCEEDED' ? (
              <CheckCircle2 className="h-3 w-3" />
            ) : receipt.businessStatus === 'FAILED' || receipt.businessStatus === 'BLOCKED' ? (
              <AlertTriangle className="h-3 w-3" />
            ) : (
              <Loader2 className="h-3 w-3 animate-spin" />
            )}
            {receipt.businessStatus === 'SUCCEEDED'
              ? '业务已完成'
              : receipt.businessStatus === 'FAILED'
                ? '失败'
                : receipt.businessStatus === 'BLOCKED'
                  ? '已阻止 · 未执行业务动作'
                  : '执行中'}
          </span>
        </div>
      ))}
    </div>
  );
}

function maskPhone(phone: string) {
  const digits = phone.replace(/\D/g, '');
  if (digits.length <= 7) return phone.startsWith('+') ? `+${digits}` : digits;
  return `+${digits.slice(0, 3)}****${digits.slice(-4)}`;
}

function quoteStatusLabel(status: string) {
  const labels: Record<string, string> = {
    draft: '草稿',
    pending: '待审核',
    approved: '已批准',
    sent: '已发送过',
  };
  return labels[status] || status;
}

export function WhatsappTextSendCard({
  proposal,
  sent,
  sending,
  onSend,
}: {
  proposal: AssistantWhatsappTextProposal;
  sent: boolean;
  sending: boolean;
  onSend: () => void;
}) {
  if (proposal.status === 'BLOCKED' || !proposal.text || !proposal.target) {
    return (
      <div className="mr-6 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-semibold">WhatsApp 发送提案已停止</p>
            <p className="mt-1 leading-5">{proposal.reason || '当前客户不满足可信发送条件'}</p>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div className="mr-6 overflow-hidden rounded-xl border border-emerald-200 bg-white shadow-sm" data-testid="whatsapp-text-send-proposal">
      <div className="border-b border-emerald-100 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-950">
        {sent ? '已发送 WhatsApp 消息' : `待确认：发送给 ${proposal.target.name}`}
      </div>
      <div className="space-y-3 p-3">
        <p className="whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-sm leading-6 text-slate-700">{proposal.text}</p>
        <p className="text-[10px] text-slate-400">目标号码：{maskPhone(proposal.target.phone)} · 仅本次确认有效</p>
        <button
          type="button"
          disabled={sent || sending}
          onClick={onSend}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
        >
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          {sent ? '发送已完成' : sending ? '正在核对并发送…' : '核对并真实发送给当前客户'}
        </button>
      </div>
    </div>
  );
}

export function QuoteDeliveryCard({
  turnId,
  proposal,
  accepted,
  preparing,
  prepared,
  onPrepare,
  onDragStart,
}: {
  turnId: string;
  proposal: AssistantQuoteDeliveryProposal;
  accepted: boolean;
  preparing: boolean;
  prepared?: PreparedQuoteDelivery;
  onPrepare: (turnId: string, proposal: AssistantQuoteDeliveryProposal) => void;
  onDragStart: (event: React.DragEvent<HTMLDivElement>, turnId: string) => void;
}) {
  if (proposal.status === 'BLOCKED' || !proposal.quote || !proposal.target) {
    return (
      <div className="mr-6 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-semibold">报价准备已阻止</p>
            <p className="mt-1 leading-5">
              {proposal.reason || '当前客户或报价信息不满足安全条件'}
            </p>
          </div>
        </div>
      </div>
    );
  }

  const quote = proposal.quote;
  const target = proposal.target;
  const isDraft = ['draft', 'pending'].includes(quote.status);
  return (
    <div
      className="mr-6 overflow-hidden rounded-xl border border-indigo-200 bg-white shadow-sm"
      data-testid="quote-delivery-proposal"
    >
      <div className="border-b border-indigo-100 bg-indigo-50 px-3 py-2">
        <div className="flex items-center gap-2 text-xs font-semibold text-indigo-950">
          <FileText className="h-4 w-4" />
          {accepted ? '已确认：准备报价 PDF' : '待确认：准备报价 PDF'}
        </div>
      </div>
      <div className="space-y-2 p-3 text-xs text-slate-700">
        <div className="grid grid-cols-[68px_1fr] gap-y-1">
          <span className="text-slate-400">客户</span>
          <span className="font-medium">{target.name}</span>
          <span className="text-slate-400">号码</span>
          <span className="font-mono">{maskPhone(target.phone)}</span>
          <span className="text-slate-400">报价单</span>
          <span className="font-medium">{quote.referenceNo}</span>
          <span className="text-slate-400">金额</span>
          <span>
            {quote.currency} {Number(quote.totalAmount).toLocaleString()}
          </span>
          <span className="text-slate-400">状态</span>
          <span>{quoteStatusLabel(quote.status)}</span>
        </div>
        {isDraft && (
          <div className="flex gap-1.5 rounded-lg border border-amber-200 bg-amber-50 p-2 text-[11px] leading-4 text-amber-800">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            这是{quoteStatusLabel(quote.status)}报价，请先核对价格、条款和客户再准备文件。
          </div>
        )}
        {!prepared ? (
          <button
            type="button"
            disabled={preparing}
            onClick={() => onPrepare(turnId, proposal)}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 px-3 py-2 font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {preparing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ShieldCheck className="h-4 w-4" />
            )}
            {preparing
              ? '正在核验并准备 PDF…'
              : accepted
                ? '重新核验并准备 PDF'
                : isDraft
                  ? '我已核对草稿，确认准备 PDF'
                  : '确认目标并准备 PDF'}
          </button>
        ) : (
          <div
            draggable
            onDragStart={(event) => onDragStart(event, turnId)}
            className="cursor-grab select-none rounded-lg border-2 border-dashed border-emerald-400 bg-emerald-50 p-3 active:cursor-grabbing"
            data-testid="assistant-quote-drag-region"
          >
            <div className="flex items-center gap-2">
              <GripVertical className="h-5 w-5 shrink-0 text-emerald-600" />
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold text-slate-900">{prepared.filename}</p>
                <p className="text-[10px] text-emerald-700">
                  PDF 已下载并计算 SHA-256 · {(prepared.size / 1024).toFixed(0)} KB
                </p>
              </div>
            </div>
            <p className="mt-2 text-[11px] leading-4 text-slate-600">
              按住此卡片拖到左侧当前 WhatsApp；预览出现后由你人工点击发送。
            </p>
          </div>
        )}
        <p className="text-[10px] leading-4 text-slate-400">
          AI 不会自动点击发送，也不会在你离线时补发。
        </p>
      </div>
    </div>
  );
}

function TasksTab({
  brief,
  running,
  finished,
  cancellingRunId,
  onCancel,
}: {
  brief: AssistantBrief | null;
  running: AgentRun[];
  finished: AgentRun[];
  cancellingRunId: string | null;
  onCancel: (runId: string) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        {[
          [brief?.metrics.todayReminders || 0, '今日待办'],
          [brief?.metrics.overdueReminders || 0, '已逾期'],
          [running.length, '进行中'],
        ].map(([value, label]) => (
          <div key={String(label)} className="rounded-xl border bg-white p-2.5 text-center">
            <p className="text-lg font-bold text-slate-900">{value}</p>
            <p className="text-[10px] text-slate-500">{label}</p>
          </div>
        ))}
      </div>
      <TaskSection
        title="正在工作的事务"
        empty="AI 当前没有执行中的任务"
        runs={running}
        cancellingRunId={cancellingRunId}
        onCancel={onCancel}
      />
      <div className="rounded-xl border bg-white">
        <div className="border-b px-3 py-2 text-xs font-semibold text-slate-800">人工待办</div>
        {brief?.reminders?.length ? (
          brief.reminders.slice(0, 8).map((item) => (
            <Link
              href={`/follow-ups/${item.id}`}
              key={item.id}
              className="flex items-start gap-2 border-b px-3 py-2.5 last:border-0 hover:bg-slate-50"
            >
              <span
                className={cn(
                  'mt-1 h-2 w-2 rounded-full',
                  item.priority === 'High' ? 'bg-red-500' : 'bg-amber-400',
                )}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-slate-800">{item.title}</p>
                <p className="mt-0.5 text-[10px] text-slate-400">{formatTime(item.dueAt)}</p>
              </div>
            </Link>
          ))
        ) : (
          <p className="p-4 text-center text-xs text-slate-400">暂无待办</p>
        )}
      </div>
      <TaskSection
        title="最近结束"
        empty="暂无已结束的 AI 工作记录"
        runs={finished.slice(0, 6)}
        cancellingRunId={cancellingRunId}
        onCancel={onCancel}
      />
    </div>
  );
}

function TaskSection({
  title,
  empty,
  runs,
  cancellingRunId,
  onCancel,
}: {
  title: string;
  empty: string;
  runs: AgentRun[];
  cancellingRunId: string | null;
  onCancel: (runId: string) => void;
}) {
  return (
    <div className="rounded-xl border bg-white">
      <div className="border-b px-3 py-2 text-xs font-semibold text-slate-800">{title}</div>
      {runs.length ? (
        runs.map((run) => (
          <AssistantRunStatusCard
            key={run.id}
            run={run}
            runId={run.id}
            cancelling={cancellingRunId === run.id}
            onCancel={onCancel}
          />
        ))
      ) : (
        <p className="p-4 text-center text-xs text-slate-400">{empty}</p>
      )}
    </div>
  );
}

export function AssistantRunStatusCard({
  run,
  runId,
  cancelling,
  onCancel,
  compact = false,
}: {
  run?: AgentRun;
  runId: string;
  cancelling: boolean;
  onCancel: (runId: string) => void;
  compact?: boolean;
}) {
  if (!run) {
    return (
      <div className="mt-2 rounded-lg border border-indigo-200 bg-indigo-50 px-2.5 py-2 text-[11px] text-indigo-700">
        <p className="font-medium">任务状态正在同步</p>
        <p className="mt-1 break-all font-mono text-[9px] text-indigo-500">任务编号：{runId}</p>
      </div>
    );
  }

  const runResult =
    run.result && typeof run.result === 'object' && !Array.isArray(run.result)
      ? (run.result as Record<string, unknown>)
      : null;
  const openClawBusinessStatus =
    run.kind === 'OPENCLAW_TOOL' &&
    typeof runResult?.businessStatus === 'string' &&
    ['PROCESSING', 'SUCCEEDED', 'BLOCKED', 'FAILED'].includes(runResult.businessStatus)
      ? runResult.businessStatus
      : null;
  const displayedStatus =
    run.kind === 'OPENCLAW_TOOL'
      ? openClawBusinessStatus === 'SUCCEEDED'
        ? '业务已完成'
        : openClawBusinessStatus === 'BLOCKED'
          ? '已阻止 · 未执行业务动作'
          : openClawBusinessStatus === 'FAILED'
            ? '执行失败'
            : openClawBusinessStatus === 'PROCESSING'
              ? '执行中'
              : run.status === 'COMPLETED'
                ? '技术调用已结束 · 业务结果待核验'
                : AGENT_STATUS_LABELS[run.status]
      : AGENT_STATUS_LABELS[run.status];
  const cancellable = ['PENDING', 'RUNNING', 'AWAITING_APPROVAL'].includes(run.status);
  const cardClass = compact
    ? 'mt-2 rounded-lg border border-indigo-200 bg-indigo-50 p-2.5'
    : 'border-b px-3 py-2.5 last:border-0';
  return (
    <div className={cardClass}>
      <div className="flex items-start gap-2">
        <CheckCircle2
          className={cn(
            'mt-0.5 h-4 w-4 shrink-0',
            openClawBusinessStatus === 'BLOCKED'
              ? 'text-slate-500'
              : run.status === 'FAILED' || openClawBusinessStatus === 'FAILED'
                ? 'text-red-500'
                : run.status === 'COMPLETED' && openClawBusinessStatus !== null
                  ? openClawBusinessStatus === 'SUCCEEDED'
                    ? 'text-emerald-500'
                    : 'text-slate-500'
                  : run.status === 'COMPLETED'
                    ? 'text-emerald-500'
                    : run.status === 'CANCELLED'
                      ? 'text-slate-400'
                      : 'text-indigo-500',
          )}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <p className="truncate text-xs font-medium text-slate-800">
              {AGENT_KIND_LABELS[run.kind]}
            </p>
            <span className="shrink-0 text-[10px] text-slate-500">{displayedStatus}</span>
          </div>
          <p className="mt-0.5 break-all font-mono text-[9px] text-slate-400" title={run.id}>
            任务编号：{run.id}
          </p>
          <p className="mt-0.5 text-[10px] text-slate-400">
            {formatTime(run.createdAt)}
            {run.completedAt
              ? ` · ${run.kind === 'OPENCLAW_TOOL' ? '处理于' : '完成于'} ${formatTime(run.completedAt)}`
              : ''}
          </p>
          {run.status === 'FAILED' && (
            <p className="mt-1 rounded bg-red-50 px-2 py-1 text-[10px] text-red-700">
              失败原因：{run.errorCode || '服务端未提供错误码'}
            </p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {run.subjectType === 'lead' && run.subjectId && (
              <Link
                href={`/leads/${run.subjectId}`}
                className="inline-flex items-center gap-1 text-[10px] font-medium text-indigo-700 hover:underline"
              >
                <ExternalLink className="h-3 w-3" />
                {run.researchReport ? `查看报告：${run.researchReport.title}` : '打开客户档案'}
              </Link>
            )}
            {cancellable && (
              <button
                type="button"
                disabled={cancelling}
                onClick={() => onCancel(run.id)}
                className="rounded border border-red-200 px-2 py-1 text-[10px] font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
              >
                {cancelling ? '取消中…' : '取消任务'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ToolsTab({
  whatsappName,
  canFillWhatsapp,
  canSendWhatsapp,
  canFillEmail,
  text,
  result,
  loading,
  filling,
  onText,
  onRun,
  onFill,
  onSend,
}: {
  whatsappName?: string;
  canFillWhatsapp: boolean;
  canSendWhatsapp: boolean;
  canFillEmail: boolean;
  text: string;
  result: string;
  loading: 'translate' | 'reply' | null;
  filling: 'whatsapp' | 'email' | 'send' | null;
  onText: (value: string) => void;
  onRun: (kind: 'translate' | 'reply') => void;
  onFill: (target: 'whatsapp' | 'email') => void;
  onSend: () => void;
}) {
  const translationTarget = smartTranslationTarget(text);
  return (
    <div className="space-y-3">
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3">
        <p className="text-xs font-semibold text-emerald-900">
          {whatsappName ? `已关联当前 WhatsApp：${whatsappName}` : '通用翻译与回复工具'}
        </p>
        <p className="mt-1 text-[10px] leading-4 text-emerald-700">
          只生成文本草稿，不会自动点击发送。
        </p>
      </div>
      <div className="rounded-xl border bg-white p-3">
        <label className="text-xs font-semibold text-slate-800">客户消息或待处理文本</label>
        <textarea
          value={text}
          onChange={(event) => onText(event.target.value)}
          rows={7}
          className="mt-2 w-full resize-none rounded-lg border bg-slate-50 p-2.5 text-sm outline-none focus:border-indigo-400"
          placeholder="粘贴客户消息；在 WhatsApp 页面会自动带入最近一条消息"
        />
        <div className="mt-2 grid grid-cols-2 gap-2">
          <button
            onClick={() => onRun('translate')}
            disabled={!text.trim() || !!loading}
            className="flex items-center justify-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium hover:bg-slate-50 disabled:opacity-40"
          >
            {loading === 'translate' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Languages className="h-3.5 w-3.5" />
            )}
            {translationTarget === 'en' ? '翻译成英文' : '翻译成中文'}
          </button>
          <button
            onClick={() => onRun('reply')}
            disabled={!text.trim() || !!loading}
            className="flex items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-xs font-medium text-white disabled:opacity-40"
          >
            {loading === 'reply' ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <WandSparkles className="h-3.5 w-3.5" />
            )}
            生成英文回复
          </button>
        </div>
      </div>
      {result && (
        <div className="rounded-xl border border-indigo-100 bg-indigo-50/60 p-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-indigo-900">生成结果</p>
            <button
              onClick={() => {
                void navigator.clipboard.writeText(result);
                toast.success('已复制');
              }}
              className="text-[10px] text-indigo-700"
            >
              复制
            </button>
          </div>
          <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-slate-700">{result}</p>
          <div className="mt-3 grid grid-cols-2 gap-2 border-t border-indigo-100 pt-3">
            <button
              type="button"
              onClick={() => onFill('whatsapp')}
              disabled={!canFillWhatsapp || !!filling}
              className="flex items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-2 py-2 text-[11px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
              title={canFillWhatsapp ? '填入当前已核验的 WhatsApp 单聊' : '请先选择有可信号码的 WhatsApp 单聊'}
            >
              {filling === 'whatsapp' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <MessageCircle className="h-3.5 w-3.5" />
              )}
              填入 WhatsApp
            </button>
            <button
              type="button"
              onClick={() => onFill('email')}
              disabled={!canFillEmail || !!filling}
              className="flex items-center justify-center gap-1.5 rounded-lg border border-indigo-200 bg-white px-2 py-2 text-[11px] font-semibold text-indigo-700 disabled:cursor-not-allowed disabled:opacity-40"
              title={canFillEmail ? '填入当前邮件回复框' : '请先进入邮件中心并打开一封邮件'}
            >
              {filling === 'email' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <FileText className="h-3.5 w-3.5" />
              )}
              填入邮件
            </button>
            <button
              type="button"
              onClick={onSend}
              disabled={!canSendWhatsapp || !!filling}
              className="col-span-2 flex items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-2 py-2.5 text-[11px] font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
              title={canSendWhatsapp ? '经管理员一次性授权后向当前已核验客户发送' : '需要可信 CRM 会话、完整号码和 WhatsApp 单聊'}
            >
              {filling === 'send' ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
              核对并真实发送给当前客户
            </button>
          </div>
        </div>
      )}
      <div className="flex items-start gap-2 rounded-lg bg-amber-50 p-2.5 text-[10px] leading-4 text-amber-800">
        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        请人工核对价格、交期、付款方式和承诺后再发送。
      </div>
    </div>
  );
}

function ReportTab({
  brief,
  runs,
  onAsk,
}: {
  brief: AssistantBrief | null;
  runs: AgentRun[];
  onAsk: (value: string) => void;
}) {
  const m = brief?.metrics;
  return (
    <div className="space-y-3">
      <div className="rounded-xl bg-gradient-to-br from-indigo-700 to-slate-900 p-4 text-white">
        <p className="text-xs text-indigo-200">实时工作简报</p>
        <h3 className="mt-1 text-lg font-semibold">今天还有 {m?.todayReminders || 0} 项待办</h3>
        <p className="mt-2 text-xs leading-5 text-slate-200">
          客户 {m?.leads || 0} 个 · 逾期 {m?.overdueReminders || 0} 项 · 待处理报价{' '}
          {m?.draftQuotes || 0} 份 · AI 进行中 {m?.activeAgentRuns || 0} 项
        </p>
      </div>
      <div className="rounded-xl border bg-white p-3">
        <h4 className="text-xs font-semibold">助理工作记录</h4>
        <div className="mt-2 space-y-2">
          {runs.slice(0, 6).map((run) => (
            <div key={run.id} className="flex items-center justify-between gap-2 text-xs">
              <span className="truncate text-slate-700">{AGENT_KIND_LABELS[run.kind]}</span>
              <span className="shrink-0 text-[10px] text-slate-400">
                {AGENT_STATUS_LABELS[run.status]}
              </span>
            </div>
          ))}
          {runs.length === 0 && <p className="py-3 text-center text-xs text-slate-400">暂无记录</p>}
        </div>
      </div>
      <button
        onClick={() =>
          onAsk('请根据当前 CRM 真实数据生成今日工作汇报，包括已完成、待办、风险和明日建议')
        }
        className="w-full rounded-lg bg-indigo-600 px-3 py-2.5 text-xs font-semibold text-white"
      >
        让助理生成完整工作汇报
      </button>
      <p className="text-center text-[10px] text-slate-400">
        数据更新时间：{formatTime(brief?.generatedAt)}
      </p>
    </div>
  );
}
