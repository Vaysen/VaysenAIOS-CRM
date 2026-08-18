'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Check, CircleAlert, Clock3, Loader2, X } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { cancelAssistantTool, confirmAssistantTool, listAssistantToolHistory, type AssistantToolExecution } from '@/lib/assistant-tool-api';

const labels: Record<AssistantToolExecution['state'], string> = {
  REQUESTED: '已请求', PLANNING: '规划中', AWAITING_CONFIRMATION: '待确认', RUNNING: '执行中', SUCCEEDED: '已完成', FAILED: '失败', CANCELLED: '已取消',
};

function StateIcon({ state }: { state: AssistantToolExecution['state'] }) {
  if (state === 'SUCCEEDED') return <Check className="h-3.5 w-3.5 text-emerald-600" />;
  if (state === 'FAILED') return <CircleAlert className="h-3.5 w-3.5 text-red-600" />;
  if (state === 'RUNNING' || state === 'PLANNING') return <Loader2 className="h-3.5 w-3.5 animate-spin text-indigo-600" />;
  return <Clock3 className="h-3.5 w-3.5 text-amber-600" />;
}

export function AssistantToolHistory({ companyId }: { companyId: string }) {
  const [items, setItems] = useState<AssistantToolExecution[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => { if (companyId) setItems(await listAssistantToolHistory(companyId)); }, [companyId]);
  useEffect(() => { void load(); }, [load]);
  const act = async (id: string, action: 'confirm' | 'cancel') => { setBusy(id); try { const next = action === 'confirm' ? await confirmAssistantTool(id) : await cancelAssistantTool(id); setItems((current) => current.map((item) => item.id === id ? next : item)); } finally { setBusy(null); } };
  return <Card className="border-slate-200 p-4" data-testid="assistant-tool-history">
    <div className="flex items-center justify-between"><div><h2 className="text-sm font-semibold text-slate-900">真实工具执行</h2><p className="text-[10px] text-slate-400">持久回读 · 失败不显示成功</p></div><Clock3 className="h-4 w-4 text-indigo-500" /></div>
    <div className="mt-3 space-y-2">{items.slice(0, 8).map((item) => <div key={item.id} className="rounded-lg border border-slate-100 bg-slate-50 p-2.5">
      <div className="flex items-center gap-1.5 text-[11px] font-medium text-slate-700"><StateIcon state={item.state} /> {item.toolName}<span className="ml-auto text-[10px] text-slate-500">{labels[item.state]}</span></div>
      {item.errorCode && <p className="mt-1 text-[10px] text-red-600">{item.errorCode}</p>}
      {Boolean(item.resultRef?.id) && <Link className="mt-1 inline-block text-[10px] text-indigo-700" href={item.toolName === 'quote_draft_create' ? `/quotes/${String(item.resultRef?.id)}` : item.toolName === 'task_follow_up_create' ? `/follow-ups/${String(item.resultRef?.id)}` : `/customers/${String(item.parameterSummary.leadId)}`}>查看真实记录 →</Link>}
      {item.state === 'AWAITING_CONFIRMATION' && <div className="mt-2 flex gap-1.5"><button className="rounded bg-indigo-600 px-2 py-1 text-[10px] font-semibold text-white disabled:opacity-50" disabled={busy === item.id} onClick={() => void act(item.id, 'confirm')}>{busy === item.id ? '处理中' : '确认执行'}</button><button className="rounded border px-2 py-1 text-[10px]" disabled={busy === item.id} onClick={() => void act(item.id, 'cancel')}><X className="inline h-3 w-3" /> 取消</button></div>}
    </div>)}{items.length === 0 && <p className="py-4 text-center text-xs text-slate-400">暂无真实工具记录</p>}</div>
  </Card>;
}
