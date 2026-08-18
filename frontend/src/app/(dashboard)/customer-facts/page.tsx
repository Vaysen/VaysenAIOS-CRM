'use client';

import { FormEvent, useEffect, useState } from 'react';
import { Check, ClipboardCheck, FileText, Plus, ShieldCheck, X } from 'lucide-react';
import api from '@/lib/api';
import { FeatureRoleGuard } from '@/components/auth/feature-role-guard';

type Evidence = { excerpt: string; locator: string; source?: { title: string; canonicalUri?: string | null } | null };
type Fact = { id: string; leadId: string; factKey: string; valueJson: Record<string, unknown>; status: string };
type Proposal = { id: string; leadId: string; factKey: string; valueJson: Record<string, unknown>; status: string; lead?: { companyName?: string | null; contactName?: string | null }; evidenceLinks: Array<{ evidence: Evidence; relation: string }> };

const newRequestId = () => `web-${Date.now()}-${Math.random().toString(16).slice(2)}`;

function CustomerFactsContent() {
  const [facts, setFacts] = useState<Fact[]>([]);
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [leadId, setLeadId] = useState('');
  const [factKey, setFactKey] = useState('customer.intent');
  const [value, setValue] = useState('');
  const [sourceTitle, setSourceTitle] = useState('');
  const [sourceUri, setSourceUri] = useState('');
  const [excerpt, setExcerpt] = useState('');
  const [locator, setLocator] = useState('paragraph:1');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [legacyJson, setLegacyJson] = useState('{\n  "records": []\n}');
  const [legacyResult, setLegacyResult] = useState<string | null>(null);

  const load = async () => {
    const [factResponse, proposalResponse] = await Promise.all([
      api.get<Fact[]>('/customer-facts'),
      api.get<Proposal[]>('/customer-facts/proposals'),
    ]);
    setFacts(factResponse.data || []);
    setProposals(proposalResponse.data || []);
  };

  useEffect(() => { load().catch(() => setError('客户事实加载失败，请检查登录状态与公司上下文。')); }, []);

  const createProposal = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(null);
    try {
      await api.post('/customer-facts/proposals', {
        leadId: leadId.trim(), factKey: factKey.trim(),
        value: { schemaVersion: 1, type: 'TEXT', value: value.trim() },
        sourceTitle: sourceTitle.trim(), sourceUri: sourceUri.trim() || undefined,
        excerpt: excerpt.trim(), locator: locator.trim(),
      });
      setLeadId(''); setValue(''); setSourceTitle(''); setSourceUri(''); setExcerpt(''); await load();
    } catch { setError('提案创建失败。请确认 Lead 属于当前公司，且定位符使用 paragraph:1、page:1 等格式。'); }
    finally { setBusy(false); }
  };

  const review = async (proposal: Proposal, action: 'accept' | 'reject') => {
    setBusy(true); setError(null);
    try {
      await api.post(`/customer-facts/proposals/${proposal.id}/${action}`, {
        requestId: newRequestId(),
        reason: action === 'accept' ? 'Reviewed against the attached source evidence.' : 'Evidence is not sufficient for confirmation.',
      });
      await load();
    } catch { setError('审核操作失败，可能是权限不足或提案已被其他人处理。'); }
    finally { setBusy(false); }
  };

  const runLegacyDryRun = async () => {
    setBusy(true); setError(null); setLegacyResult(null);
    try {
      const payload = JSON.parse(legacyJson) as Record<string, unknown>;
      const response = await api.post('/customer-facts/legacy/dry-run', payload);
      setLegacyResult(JSON.stringify(response.data, null, 2) ?? '');
    } catch (cause) {
      setError(cause instanceof SyntaxError ? 'Legacy JSON 格式无效。' : 'Legacy dry-run 失败：请确认记录 tenantRef 等于当前公司，并只提交已脱敏数据。');
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">客户事实</h1><p className="text-sm text-gray-500">证据先行的客户画像事实与人工审核队列。</p></div>
        <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"><ShieldCheck className="h-4 w-4" /> AI 只能提出建议，不能确认事实</div>
      </div>
      {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
      <div className="grid gap-6 xl:grid-cols-[360px_1fr]">
        <form onSubmit={createProposal} className="space-y-3 rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-950">
          <div className="flex items-center gap-2 font-semibold"><Plus className="h-4 w-4" /> 导入证据提案</div>
          <p className="text-xs text-gray-500">此表单只创建 PROPOSED，不会写入 CONFIRMED 客户事实。</p>
          <label className="block text-sm">Lead ID<input required value={leadId} onChange={(event) => setLeadId(event.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2" /></label>
          <label className="block text-sm">Fact key<input required value={factKey} onChange={(event) => setFactKey(event.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2" /></label>
          <label className="block text-sm">事实值<textarea required value={value} onChange={(event) => setValue(event.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2" rows={2} /></label>
          <label className="block text-sm">来源标题<input required value={sourceTitle} onChange={(event) => setSourceTitle(event.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2" /></label>
          <label className="block text-sm">来源 URL（可选）<input value={sourceUri} onChange={(event) => setSourceUri(event.target.value)} placeholder="https://..." className="mt-1 w-full rounded-lg border px-3 py-2" /></label>
          <label className="block text-sm">原文摘录<textarea required value={excerpt} onChange={(event) => setExcerpt(event.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2" rows={3} /></label>
          <label className="block text-sm">定位符<input required value={locator} onChange={(event) => setLocator(event.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2" /></label>
          <button disabled={busy} className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-50">保存证据提案</button>
        </form>
        <section className="space-y-3">
          <div className="flex items-center gap-2"><ClipboardCheck className="h-4 w-4" /><h2 className="font-semibold">待审核提案</h2></div>
          {proposals.length === 0 ? <div className="rounded-xl border border-dashed p-10 text-center text-sm text-gray-500">暂无提案</div> : proposals.map((proposal) => {
            const evidence = proposal.evidenceLinks[0]?.evidence;
            return <article key={proposal.id} className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-950"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-semibold">{proposal.factKey}</p><p className="text-xs text-gray-500">{proposal.lead?.companyName || proposal.leadId} · {proposal.lead?.contactName || '无联系人'}</p></div><span className="rounded-full bg-amber-100 px-2 py-1 text-xs text-amber-800">{proposal.status}</span></div><p className="mt-3 text-sm">{String(proposal.valueJson.value || '')}</p>{evidence && <div className="mt-3 rounded-lg bg-gray-50 p-3 text-xs text-gray-600"><p className="font-medium"><FileText className="mr-1 inline h-3 w-3" />{evidence.source?.title || 'Source evidence'}</p><p className="mt-1">“{evidence.excerpt}”</p><p className="mt-1 text-gray-400">{evidence.locator}{evidence.source?.canonicalUri ? ` · ${evidence.source.canonicalUri}` : ''}</p></div>}<div className="mt-3 flex gap-2"><button type="button" disabled={busy || proposal.status !== 'PROPOSED'} onClick={() => review(proposal, 'accept')} className="inline-flex items-center gap-1 rounded border border-green-200 px-3 py-1.5 text-xs text-green-700 disabled:opacity-50"><Check className="h-3 w-3" />接受并确认</button><button type="button" disabled={busy || proposal.status !== 'PROPOSED'} onClick={() => review(proposal, 'reject')} className="inline-flex items-center gap-1 rounded border border-red-200 px-3 py-1.5 text-xs text-red-700 disabled:opacity-50"><X className="h-3 w-3" />拒绝</button></div></article>;
          })}
        </section>
      </div>
      <section className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-800 dark:bg-gray-950"><h2 className="font-semibold">已确认客户事实</h2>{facts.length === 0 ? <p className="mt-3 text-sm text-gray-500">暂无已确认事实。</p> : <div className="mt-3 divide-y">{facts.map((fact) => <div key={fact.id} className="flex flex-wrap items-center justify-between gap-3 py-3"><div><p className="text-sm font-medium">{fact.factKey}</p><p className="text-xs text-gray-500">{fact.leadId} · {String(fact.valueJson.value || '')}</p></div><span className="rounded-full bg-green-100 px-2 py-1 text-xs text-green-700">{fact.status}</span></div>)}</div>}</section>
      <section className="rounded-xl border border-slate-200 bg-slate-50 p-5 shadow-sm dark:border-slate-800 dark:bg-slate-950"><div className="flex items-center gap-2"><FileText className="h-4 w-4" /><h2 className="font-semibold">Legacy evidence dry-run</h2><span className="rounded-full bg-slate-200 px-2 py-1 text-[10px] text-slate-700">DRY_RUN_ONLY</span></div><p className="mt-1 text-xs text-gray-500">仅提交已脱敏的 legacy adapter 输入；系统只返回提案计划与隔离报告，不执行迁移或写库。</p><textarea value={legacyJson} onChange={(event) => setLegacyJson(event.target.value)} className="mt-3 min-h-36 w-full rounded-lg border bg-white px-3 py-2 font-mono text-xs dark:bg-gray-900" spellCheck={false} /><button type="button" disabled={busy} onClick={runLegacyDryRun} className="mt-3 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm hover:bg-slate-100 disabled:opacity-50">运行 dry-run</button>{legacyResult && <pre className="mt-3 max-h-80 overflow-auto rounded-lg bg-slate-900 p-3 text-xs text-slate-100">{legacyResult}</pre>}</section>
      <div className="text-xs text-gray-500">所有列表均按当前公司隔离；证据和审核回执保存在 CRM，未连接真实外发渠道。</div>
    </div>
  );
}

export default function CustomerFactsPage() {
  return <FeatureRoleGuard module="customerFactsReview"><CustomerFactsContent /></FeatureRoleGuard>;
}
