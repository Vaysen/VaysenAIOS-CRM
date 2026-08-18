'use client';

import { FormEvent, Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import api from '@/lib/api';
import { OPPORTUNITY_STAGE_LABELS, OPPORTUNITY_STAGES, type CreateOpportunityInput, type OpportunityStage } from '@/types/opportunity';

function NewOpportunityContent() {
  const searchParams = useSearchParams();
  const [form, setForm] = useState<CreateOpportunityInput>({ leadId: searchParams.get('leadId') || '', name: '', stage: 'new', currency: 'USD', probability: 10 });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdId, setCreatedId] = useState<string | null>(null);

  const update = (field: keyof CreateOpportunityInput, value: string) => setForm((current) => ({ ...current, [field]: value }));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (!form.leadId.trim() || !form.name.trim()) { setError('客户 ID 和商机名称为必填项。'); return; }
    setSaving(true);
    try {
      const payload = { ...form, leadId: form.leadId.trim(), name: form.name.trim(), amount: form.amount || undefined, probability: Number(form.probability), expectedCloseDate: form.expectedCloseDate ? new Date(`${form.expectedCloseDate}T00:00:00.000Z`).toISOString() : undefined };
      const response = await api.post('/opportunities', payload);
      setCreatedId(response.data?.id || null);
    } catch (requestError: any) {
      setError(requestError?.response?.data?.message || '商机创建失败，请检查客户和输入后重试。');
    } finally { setSaving(false); }
  };

  if (createdId) return <div className="mx-auto max-w-xl space-y-4 rounded-xl border bg-white p-8 text-center"><h1 className="text-xl font-semibold">商机创建成功</h1><p className="text-sm text-gray-500">后端已创建初始阶段历史，负责人默认使用当前用户。</p><div className="flex justify-center gap-3"><Link href={`/opportunities/${createdId}`} className="rounded bg-blue-600 px-4 py-2 text-sm text-white">查看商机</Link><Link href="/opportunities" className="rounded border px-4 py-2 text-sm">返回商机列表</Link></div></div>;

  return <div className="mx-auto max-w-2xl space-y-6">
    <div><Link href="/opportunities" className="text-sm text-gray-500 hover:text-blue-600">← 返回商机</Link><h1 className="mt-3 text-2xl font-bold">新建商机</h1><p className="mt-1 text-sm text-gray-500">商机阶段独立于客户 Lead.status，由后端 Opportunity 状态机管理。</p></div>
    <form onSubmit={submit} className="space-y-4 rounded-xl border bg-white p-5">
      {error && <div role="alert" className="rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      <Field label="客户 ID *"><input aria-label="客户 ID" required value={form.leadId} onChange={(e) => update('leadId', e.target.value)} className="input" /></Field>
      <Field label="商机名称 *"><input aria-label="商机名称" required value={form.name} onChange={(e) => update('name', e.target.value)} className="input" /></Field>
      <Field label="描述"><textarea aria-label="商机描述" value={form.description || ''} onChange={(e) => update('description', e.target.value)} className="input min-h-24" /></Field>
      <div className="grid gap-4 md:grid-cols-2"><Field label="初始阶段"><select aria-label="初始阶段" value={form.stage} onChange={(e) => { const value = e.target.value as OpportunityStage; setForm((current) => ({ ...current, stage: value, probability: value === 'new' ? 10 : current.probability })); }} className="input">{OPPORTUNITY_STAGES.map((stage) => <option key={stage} value={stage}>{OPPORTUNITY_STAGE_LABELS[stage]}</option>)}</select></Field><Field label="金额"><input aria-label="金额" inputMode="decimal" value={form.amount || ''} onChange={(e) => update('amount', e.target.value)} className="input" /></Field><Field label="币种"><input aria-label="币种" maxLength={3} value={form.currency || 'USD'} onChange={(e) => update('currency', e.target.value.toUpperCase())} className="input" /></Field><Field label="赢单概率 (%)"><input aria-label="赢单概率" type="number" min={0} max={100} value={form.probability ?? 0} onChange={(e) => setForm((current) => ({ ...current, probability: Number(e.target.value) }))} className="input" /></Field><Field label="预计成交日期"><input aria-label="预计成交日期" type="date" value={form.expectedCloseDate || ''} onChange={(e) => update('expectedCloseDate', e.target.value)} className="input" /></Field><Field label="下一步"><input aria-label="下一步" value={form.nextStep || ''} onChange={(e) => update('nextStep', e.target.value)} className="input" /></Field></div>
      {form.stage === 'lost' && <Field label="输单原因 *"><input aria-label="输单原因" value={form.lostReason || ''} onChange={(e) => update('lostReason', e.target.value)} className="input" /></Field>}
      <p className="text-xs text-gray-500">负责人由后端按当前登录用户默认设置；本页没有可靠的用户目录，因此不开放 ownerUserId 手填。</p>
      <button type="submit" disabled={saving} className="w-full rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{saving ? '创建中…' : '创建商机'}</button>
    </form>
    <style>{`.input { width: 100%; border: 1px solid #d1d5db; border-radius: .5rem; padding: .5rem .75rem; font-size: .875rem; }`}</style>
  </div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="block text-sm font-medium text-gray-700">{label}<span className="mt-1 block">{children}</span></label>; }

export default function NewOpportunityPage() {
  return <Suspense fallback={<div className="p-12 text-center text-sm text-gray-500">正在加载…</div>}><NewOpportunityContent /></Suspense>;
}
