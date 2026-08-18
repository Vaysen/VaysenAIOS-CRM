'use client';

import { FormEvent, useEffect, useState } from 'react';
import { Check, ClipboardList, PauseCircle, Plus, ShieldCheck, X } from 'lucide-react';
import api from '@/lib/api';
import { FeatureRoleGuard } from '@/components/auth/feature-role-guard';

type Step = { id: string; position: number; channel: string; delaySeconds: number; templateSnapshot: Record<string, unknown> };
type Sequence = { id: string; name: string; description: string | null; status: string; steps: Step[]; _count?: { enrollments: number } };
type Execution = { id: string; status: string; version: number; step: Step; draftOutbox?: { status: string } | null; receipts: Array<{ kind: string; createdAt: string }> };
type Enrollment = { id: string; leadId: string; status: string; executions: Execution[]; lead?: { companyName: string | null; contactName: string | null } };

function SalesSequencesContent() {
  const [sequences, setSequences] = useState<Sequence[]>([]);
  const [selected, setSelected] = useState<Sequence | null>(null);
  const [enrollments, setEnrollments] = useState<Enrollment[]>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [channel, setChannel] = useState('EMAIL');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [leadId, setLeadId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const response = await api.get<Sequence[]>('/sales-sequences');
    const data = response.data || [];
    setSequences(data);
    if (selected) setSelected(data.find((item) => item.id === selected.id) || null);
  };

  const loadEnrollments = async (sequence: Sequence) => {
    setSelected(sequence);
    const response = await api.get<Enrollment[]>(`/sales-sequences/${sequence.id}/enrollments`);
    setEnrollments(response.data || []);
  };

  useEffect(() => { load().catch(() => setError('销售序列加载失败。')); }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setError(null);
    try {
      await api.post('/sales-sequences', {
        name: name.trim(),
        description: description.trim() || undefined,
        steps: [{ channel, delaySeconds: 0, templateSnapshot: { subject: subject.trim(), body: body.trim() } }],
      });
      setName(''); setDescription(''); setSubject(''); setBody('');
      await load();
    } catch { setError('序列创建失败，请检查权限和字段。'); } finally { setBusy(false); }
  };

  const activate = async (sequence: Sequence) => {
    setBusy(true); setError(null);
    try { await api.post(`/sales-sequences/${sequence.id}/activate`); await load(); } catch { setError('序列激活失败。'); } finally { setBusy(false); }
  };

  const enroll = async () => {
    if (!selected || !leadId.trim()) return;
    setBusy(true); setError(null);
    try { await api.post(`/sales-sequences/${selected.id}/enrollments`, { leadId: leadId.trim() }); setLeadId(''); await loadEnrollments(selected); } catch { setError('Lead 报名失败，确认序列已激活且 Lead 属于当前公司。'); } finally { setBusy(false); }
  };

  const transition = async (executionId: string, action: 'approve' | 'cancel') => {
    setBusy(true); setError(null);
    try { await api.post(`/sales-sequences/executions/${executionId}/${action}`); if (selected) await loadEnrollments(selected); } catch { setError('执行状态更新失败，可能已被其他人修改。'); } finally { setBusy(false); }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">销售序列</h1>
          <p className="text-sm text-gray-500">把跟进步骤沉淀成可审核的草稿执行计划。</p>
        </div>
        <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <ShieldCheck className="h-4 w-4" /> 当前仅 DRAFT_ONLY，不会发送真实邮件或 WhatsApp
        </div>
      </div>

      {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      <div className="grid gap-6 xl:grid-cols-[360px_1fr]">
        <form onSubmit={submit} className="space-y-4 rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-950">
          <div className="flex items-center gap-2 font-semibold"><Plus className="h-4 w-4" /> 新建序列</div>
          <label className="block text-sm">名称<input required value={name} onChange={(event) => setName(event.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2" /></label>
          <label className="block text-sm">说明<textarea value={description} onChange={(event) => setDescription(event.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2" rows={2} /></label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm">渠道<select value={channel} onChange={(event) => setChannel(event.target.value)} className="mt-1 w-full rounded-lg border bg-white px-3 py-2"><option value="EMAIL">Email</option><option value="WHATSAPP">WhatsApp</option></select></label>
            <label className="block text-sm">延迟<input value="0" readOnly className="mt-1 w-full rounded-lg border bg-gray-50 px-3 py-2" /></label>
          </div>
          <label className="block text-sm">草稿主题<input value={subject} onChange={(event) => setSubject(event.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2" /></label>
          <label className="block text-sm">草稿正文<textarea value={body} onChange={(event) => setBody(event.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2" rows={5} /></label>
          <button disabled={busy} className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-50">保存草稿序列</button>
        </form>

        <section className="space-y-3">
          <h2 className="font-semibold">我的序列</h2>
          {sequences.length === 0 ? <div className="rounded-xl border border-dashed p-10 text-center text-sm text-gray-500">还没有销售序列。</div> : sequences.map((sequence) => (
            <div key={sequence.id} className={`rounded-xl border bg-white p-4 shadow-sm dark:bg-gray-950 ${selected?.id === sequence.id ? 'border-blue-400' : 'border-gray-200'}`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <button type="button" onClick={() => loadEnrollments(sequence)} className="text-left"><p className="font-semibold text-blue-700">{sequence.name}</p><p className="mt-1 text-xs text-gray-500">{sequence.description || '无说明'} · {sequence.steps.length} 步 · {sequence._count?.enrollments || 0} 个报名</p></button>
                <div className="flex items-center gap-2"><span className="rounded-full bg-gray-100 px-2 py-1 text-xs">{sequence.status}</span>{sequence.status !== 'ACTIVE' && <button type="button" disabled={busy} onClick={() => activate(sequence)} className="rounded border px-2 py-1 text-xs hover:bg-gray-50">激活</button>}</div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">{sequence.steps.map((step) => <span key={step.id} className="rounded bg-blue-50 px-2 py-1 text-xs text-blue-700">{step.position}. {step.channel}</span>)}</div>
            </div>
          ))}
        </section>
      </div>

      {selected && <section className="space-y-4 rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-950">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold">{selected.name} · 报名与审核</h2><p className="text-xs text-gray-500">这里只生成和审核草稿，不产生任何外发动作。</p></div><div className="flex gap-2"><input aria-label="Lead ID" placeholder="输入 Lead ID" value={leadId} onChange={(event) => setLeadId(event.target.value)} className="rounded-lg border px-3 py-2 text-sm" /><button type="button" disabled={busy || selected.status !== 'ACTIVE'} onClick={enroll} className="rounded-lg bg-blue-600 px-3 py-2 text-sm text-white disabled:opacity-50">报名 Lead</button></div></div>
        {enrollments.length === 0 ? <p className="rounded-lg border border-dashed p-8 text-center text-sm text-gray-500">暂无报名。</p> : <div className="divide-y">{enrollments.map((enrollment) => enrollment.executions.map((execution) => <div key={execution.id} className="flex flex-wrap items-center justify-between gap-3 py-4"><div><p className="text-sm font-medium">{enrollment.lead?.companyName || enrollment.leadId}</p><p className="text-xs text-gray-500">{enrollment.lead?.contactName || '无联系人'} · {execution.step.channel} · {execution.draftOutbox?.status || 'DRAFT_ONLY'}</p></div><div className="flex items-center gap-2"><span className="rounded-full bg-gray-100 px-2 py-1 text-xs">{execution.status}</span>{execution.status === 'DRAFT_PENDING' && <><button type="button" disabled={busy} onClick={() => transition(execution.id, 'approve')} className="inline-flex items-center gap-1 rounded border border-green-200 px-2 py-1 text-xs text-green-700"><Check className="h-3 w-3" />批准草稿</button><button type="button" disabled={busy} onClick={() => transition(execution.id, 'cancel')} className="inline-flex items-center gap-1 rounded border border-red-200 px-2 py-1 text-xs text-red-700"><X className="h-3 w-3" />取消</button></>}</div></div>))}</div>}
      </section>}

      <div className="flex items-center gap-2 text-xs text-gray-500"><ClipboardList className="h-4 w-4" /> 回执与 CAS 状态保存在 CRM；真实 provider reader / reconciliation worker 尚未接线。</div>
    </div>
  );
}

export default function SalesSequencesPage() {
  return <FeatureRoleGuard module="salesSequencesManagement"><SalesSequencesContent /></FeatureRoleGuard>;
}
