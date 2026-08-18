'use client';

import { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Pencil,
  ShieldCheck,
  Sparkles,
  XCircle,
} from 'lucide-react';
import { sendAssistantChat, type AssistantChatTurn, type AssistantMode } from '@/lib/agent-api';
import { createClientUuid } from '@/lib/client-id';
import { useAuthStore } from '@/store/authStore';

const MODES: Array<{ id: AssistantMode; label: string; help: string }> = [
  { id: 'ask', label: 'Ask', help: '只读问答与帮助' },
  { id: 'insight', label: 'Insight', help: '摘要、风险和下一步' },
  { id: 'draft', label: 'Draft', help: '生成草稿，不发送' },
  { id: 'action', label: 'Action', help: '生成审批卡，不直接执行' },
];

type ReviewDecision = 'PENDING' | 'APPROVED_SIMULATION' | 'REJECTED';

export function CustomerSalesCopilot({
  customerId,
  customerName,
}: {
  customerId: string;
  customerName: string;
}) {
  const { user, activeCompanyId } = useAuthStore();
  const membership = user?.companies?.find((company) => company.id === activeCompanyId)
    || user?.companies?.[0];
  const canViewDetailedDiagnostics = [
    'sales_manager',
    'company_admin',
    'super_admin',
  ].includes(membership?.role || '');
  const [mode, setMode] = useState<AssistantMode>('insight');
  const [prompt, setPrompt] = useState('');
  const [turn, setTurn] = useState<AssistantChatTurn | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviewText, setReviewText] = useState('');
  const [reviewDecision, setReviewDecision] = useState<ReviewDecision>('PENDING');
  const [editingReview, setEditingReview] = useState(false);

  const ask = async () => {
    if (!prompt.trim() || loading || !activeCompanyId || !user?.id) return;
    setLoading(true);
    setError(null);
    try {
      const result = await sendAssistantChat({
        requestId: createClientUuid(),
        companyId: activeCompanyId,
        threadId: `customer-${customerId}-${user.id}`,
        customerId,
        mode,
        message: prompt.trim(),
        pathname: `/customers/${customerId}`,
      });
      setTurn(result);
      setPrompt('');
      if (result.actionProposal?.kind === 'CUSTOMER_ACTION_REVIEW') {
        setReviewText(result.actionProposal.instruction);
        setReviewDecision('PENDING');
        setEditingReview(false);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '销售副驾暂时不可用，请重试。');
    } finally {
      setLoading(false);
    }
  };

  const customerAction = turn?.actionProposal?.kind === 'CUSTOMER_ACTION_REVIEW'
    ? turn.actionProposal
    : null;

  return (
    <section
      className="max-w-full overflow-hidden rounded-xl border border-indigo-200 bg-indigo-50/40 p-4"
      aria-label="Vaysen销售副驾"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-sm font-semibold text-indigo-950">
            <Sparkles className="h-4 w-4 shrink-0" />Vaysen销售副驾
          </div>
          <p className="mt-1 break-words text-xs text-indigo-800">
            当前客户：{customerName} · AI 只使用授权 CRM 上下文。
          </p>
        </div>
        <span className="rounded-full bg-white px-2 py-1 text-[10px] text-indigo-700">
          人工审批边界开启
        </span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4" role="tablist" aria-label="销售副驾模式">
        {MODES.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={mode === item.id}
            onClick={() => setMode(item.id)}
            className={`min-w-0 rounded-lg border px-2 py-2 text-left ${
              mode === item.id
                ? 'border-indigo-500 bg-indigo-600 text-white'
                : 'border-indigo-100 bg-white text-indigo-900'
            }`}
          >
            <span className="block text-xs font-semibold">{item.label}</span>
            <span className="mt-0.5 block break-words text-[10px] opacity-80">{item.help}</span>
          </button>
        ))}
      </div>

      <div className="mt-3 flex min-w-0 flex-col gap-2 sm:flex-row">
        <label className="sr-only" htmlFor="customer-copilot-prompt">向销售副驾提问</label>
        <textarea
          id="customer-copilot-prompt"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') void ask();
          }}
          rows={2}
          placeholder={mode === 'draft'
            ? '例如：草拟一封跟进邮件，不要发送'
            : mode === 'action'
              ? '例如：为该客户创建明日跟进待办'
              : '例如：总结该客户最近变化和下一步'}
          className="min-w-0 flex-1 resize-none rounded-lg border bg-white px-3 py-2 text-sm outline-none focus:border-indigo-500"
        />
        <button
          type="button"
          onClick={() => void ask()}
          disabled={loading || !prompt.trim()}
          className="inline-flex h-fit shrink-0 items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {loading && <Loader2 className="h-4 w-4 animate-spin" />}
          运行 {MODES.find((item) => item.id === mode)?.label}
        </button>
      </div>

      {error && (
        <div role="alert" className="mt-3 flex gap-2 rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span className="min-w-0 flex-1 break-words">{error}</span>
          <button type="button" onClick={() => void ask()} className="shrink-0 underline">重试</button>
        </div>
      )}

      {turn && (
        <div className="mt-3 min-w-0 rounded-lg border border-white bg-white p-3">
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-700">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
            {turn.intent === 'ACTION' ? '待人工审批的动作建议' : `${turn.intent} 结果`}
          </div>
          <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-slate-700">
            {turn.output}
          </p>

          {turn.diagnostics && (
            <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-[11px] text-slate-600" aria-label="AI 响应诊断">
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                <span>意图：{turn.diagnostics.intent}</span>
                <span>质量：{turn.diagnostics.qualityStatus}</span>
                {canViewDetailedDiagnostics && <span>来源：{turn.diagnostics.responseSource}</span>}
                {canViewDetailedDiagnostics && <span>延迟：{turn.diagnostics.latencyMs}ms</span>}
                {canViewDetailedDiagnostics && turn.diagnostics.model && (
                  <span className="break-all">模型：{turn.diagnostics.model}</span>
                )}
              </div>
              {canViewDetailedDiagnostics && turn.diagnostics.tools.length > 0 && (
                <p className="mt-1 break-all">已验证工具：{turn.diagnostics.tools.join(', ')}</p>
              )}
            </div>
          )}

          {customerAction && (
            <div className="mt-3 min-w-0 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-950" aria-label="客户动作审批卡">
              <div className="flex items-center gap-2 font-semibold">
                <ShieldCheck className="h-4 w-4 shrink-0" />内部动作安全审批
              </div>
              <p className="mt-1 break-words">目标：{customerAction.target.name}</p>
              {editingReview ? (
                <textarea
                  aria-label="编辑动作草稿"
                  value={reviewText}
                  onChange={(event) => setReviewText(event.target.value)}
                  rows={3}
                  className="mt-2 w-full min-w-0 resize-y rounded-md border border-amber-300 bg-white px-2 py-2 text-xs"
                />
              ) : (
                <p className="mt-2 whitespace-pre-wrap break-words rounded-md bg-white/80 p-2">{reviewText}</p>
              )}
              <p className="mt-2">批准仅记录本地安全模拟；不会写入发送队列，也不会调用任何真实发送适配器。</p>

              {reviewDecision === 'PENDING' ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setEditingReview((value) => !value)}
                    className="inline-flex items-center gap-1 rounded-md border border-amber-300 bg-white px-2 py-1.5"
                  >
                    <Pencil className="h-3.5 w-3.5" />{editingReview ? '完成编辑' : '编辑'}
                  </button>
                  <button
                    type="button"
                    disabled={!reviewText.trim()}
                    onClick={() => {
                      setEditingReview(false);
                      setReviewDecision('APPROVED_SIMULATION');
                    }}
                    className="rounded-md bg-emerald-700 px-2 py-1.5 text-white disabled:opacity-50"
                  >
                    批准安全模拟
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setEditingReview(false);
                      setReviewDecision('REJECTED');
                    }}
                    className="inline-flex items-center gap-1 rounded-md bg-slate-700 px-2 py-1.5 text-white"
                  >
                    <XCircle className="h-3.5 w-3.5" />拒绝
                  </button>
                </div>
              ) : (
                <p role="status" className="mt-3 font-semibold">
                  {reviewDecision === 'APPROVED_SIMULATION'
                    ? '安全模拟已批准：未写入外部通道，未发送任何消息。'
                    : '审批卡已拒绝：未执行，未发送任何消息。'}
                </p>
              )}
            </div>
          )}

          {turn.actionProposal && !customerAction && (
            <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
              <p className="font-semibold">审批卡：{turn.actionProposal.kind}</p>
              <p className="mt-1">需要人工确认后才能继续；本卡不会自动发送消息或绕过现有审计流程。</p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
