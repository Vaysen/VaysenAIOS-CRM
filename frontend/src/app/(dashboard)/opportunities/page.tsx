'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Filter, List, Plus, Search, Kanban } from 'lucide-react';
import api from '@/lib/api';
import {
  formatOpportunityAmount,
  formatOpportunityContact,
  formatOpportunityDate,
  formatOpportunityLead,
  formatOpportunityOwner,
  OPPORTUNITY_STAGE_LABELS,
  OPPORTUNITY_STAGES,
  type Opportunity,
  type OpportunityListResponse,
  type OpportunityStage,
} from '@/types/opportunity';

const PAGE_LIMIT = 20;

export default function OpportunitiesPage() {
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [stage, setStage] = useState<OpportunityStage | ''>('');
  const [ownerUserId, setOwnerUserId] = useState('');
  const [leadId, setLeadId] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [view, setView] = useState<'list' | 'kanban'>('list');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.get<OpportunityListResponse>('/opportunities', {
      params: {
        page,
        limit: PAGE_LIMIT,
        stage: stage || undefined,
        ownerUserId: ownerUserId.trim() || undefined,
        leadId: leadId.trim() || undefined,
        search: search.trim() || undefined,
      },
    }).then((response) => {
      if (cancelled) return;
      setOpportunities(response.data?.data || []);
      setTotalPages(Math.max(1, response.data?.meta?.totalPages || 1));
    }).catch(() => {
      if (!cancelled) setError('商机加载失败，请稍后重试。');
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [leadId, ownerUserId, page, search, stage]);

  const grouped = useMemo(() => OPPORTUNITY_STAGES.reduce<Record<string, Opportunity[]>>((result, currentStage) => {
    result[currentStage] = opportunities.filter((opportunity) => opportunity.stage === currentStage);
    return result;
  }, {}), [opportunities]);

  const applyFilter = (setter: (value: string) => void, value: string) => {
    setPage(1);
    setter(value);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">商机管理</h1>
          <p className="text-sm text-gray-500">按独立项目管理客户机会、报价推进和成交结果。</p>
        </div>
        <Link href="/opportunities/new" className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700">
          <Plus className="h-4 w-4" /> 新建商机
        </Link>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
        <div className="grid gap-3 md:grid-cols-5">
          <label className="relative md:col-span-2">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <input aria-label="搜索商机" value={search} onChange={(event) => applyFilter(setSearch, event.target.value)} placeholder="搜索商机名称" className="w-full rounded-lg border border-gray-300 py-2 pl-10 pr-3 text-sm outline-none focus:ring-2 focus:ring-blue-500" />
          </label>
          <label className="text-xs text-gray-500">阶段
              <select aria-label="阶段筛选" value={stage} onChange={(event) => applyFilter((value) => setStage(value as OpportunityStage | ''), event.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm">
              <option value="">全部阶段</option>
              {OPPORTUNITY_STAGES.map((value) => <option key={value} value={value}>{OPPORTUNITY_STAGE_LABELS[value]}</option>)}
            </select>
          </label>
          <label className="text-xs text-gray-500">负责人 ID
            <input aria-label="负责人筛选" value={ownerUserId} onChange={(event) => applyFilter(setOwnerUserId, event.target.value)} placeholder="可选" className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </label>
          <label className="text-xs text-gray-500">客户 ID
            <input aria-label="客户筛选" value={leadId} onChange={(event) => applyFilter(setLeadId, event.target.value)} placeholder="可选" className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm" />
          </label>
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-1 text-xs text-gray-500"><Filter className="h-3.5 w-3.5" /> 后端筛选 · 第 {page} / {totalPages} 页</div>
          <div className="flex rounded-lg border border-gray-200 p-0.5">
            <button type="button" aria-pressed={view === 'list'} onClick={() => setView('list')} className={`inline-flex items-center gap-1 rounded px-2 py-1 text-xs ${view === 'list' ? 'bg-blue-50 text-blue-700' : 'text-gray-500'}`}><List className="h-3.5 w-3.5" />列表</button>
            <button type="button" aria-pressed={view === 'kanban'} onClick={() => setView('kanban')} className={`inline-flex items-center gap-1 rounded px-2 py-1 text-xs ${view === 'kanban' ? 'bg-blue-50 text-blue-700' : 'text-gray-500'}`}><Kanban className="h-3.5 w-3.5" />看板</button>
          </div>
        </div>
      </div>

      {loading ? <div className="rounded-xl border p-12 text-center text-sm text-gray-500">正在加载商机…</div> : error ? <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-6 text-center text-sm text-red-700">{error}</div> : view === 'list' ? (
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950">
          {opportunities.length === 0 ? <EmptyOpportunities /> : <div className="divide-y">{opportunities.map((opportunity) => <OpportunityRow key={opportunity.id} opportunity={opportunity} />)}</div>}
        </div>
      ) : (
        <div className="grid gap-3 overflow-x-auto pb-2 lg:grid-cols-7">
          {OPPORTUNITY_STAGES.map((currentStage) => <section key={currentStage} className="min-w-[190px] rounded-xl border border-gray-200 bg-gray-50 p-3">
            <div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-semibold">{OPPORTUNITY_STAGE_LABELS[currentStage]}</h2><span className="rounded-full bg-white px-2 py-0.5 text-xs text-gray-500">{grouped[currentStage]?.length || 0}</span></div>
            <div className="space-y-2">{(grouped[currentStage] || []).map((opportunity) => <OpportunityCard key={opportunity.id} opportunity={opportunity} />)}{!grouped[currentStage]?.length && <p className="rounded border border-dashed p-4 text-center text-xs text-gray-400">暂无商机</p>}</div>
          </section>)}
        </div>
      )}

      <div className="flex items-center justify-between text-sm">
        <button type="button" disabled={page <= 1} onClick={() => setPage((current) => Math.max(1, current - 1))} className="rounded border px-3 py-1.5 disabled:opacity-40">上一页</button>
        <span className="text-xs text-gray-500">共 {opportunities.length} 条当前页记录</span>
        <button type="button" disabled={page >= totalPages} onClick={() => setPage((current) => Math.min(totalPages, current + 1))} className="rounded border px-3 py-1.5 disabled:opacity-40">下一页</button>
      </div>
    </div>
  );
}

function OpportunityRow({ opportunity }: { opportunity: Opportunity }) {
  return <Link href={`/opportunities/${opportunity.id}`} className="block px-5 py-4 hover:bg-gray-50">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <p className="font-medium text-blue-700">{opportunity.name}</p>
        <p className="mt-1 text-sm text-gray-700">客户：{formatOpportunityLead(opportunity.lead)}</p>
        <p className="text-xs text-gray-500">联系人：{formatOpportunityContact(opportunity.lead)} · 负责人：{formatOpportunityOwner(opportunity.owner)}</p>
        {opportunity.lead?.country && <p className="text-xs text-gray-500">国家/地区：{opportunity.lead.country}</p>}
        <p className="mt-1 text-xs text-gray-400">关联客户 ID：{opportunity.leadId}</p>
      </div>
      <div className="text-right"><p className="text-sm font-semibold">{formatOpportunityAmount(opportunity.amount, opportunity.currency)}</p><p className="text-xs text-gray-500">{OPPORTUNITY_STAGE_LABELS[opportunity.stage]} · 赢单概率 {opportunity.probability}%</p></div>
    </div>
    <div className="mt-2 flex flex-wrap gap-3 text-xs text-gray-500"><span>预计成交：{formatOpportunityDate(opportunity.expectedCloseDate)}</span><span>更新：{formatOpportunityDate(opportunity.updatedAt)}</span>{opportunity.nextStep && <span>下一步：{opportunity.nextStep}</span>}</div>
  </Link>;
}

function OpportunityCard({ opportunity }: { opportunity: Opportunity }) {
  return <Link href={`/opportunities/${opportunity.id}`} className="block rounded-lg border border-gray-200 bg-white p-3 shadow-sm hover:border-blue-300">
    <p className="line-clamp-2 text-sm font-medium text-blue-700">{opportunity.name}</p>
    <p className="mt-1 truncate text-sm text-gray-700">客户：{formatOpportunityLead(opportunity.lead)}</p>
    <p className="truncate text-xs text-gray-500">联系人：{formatOpportunityContact(opportunity.lead)}</p>
    <p className="truncate text-xs text-gray-500">负责人：{formatOpportunityOwner(opportunity.owner)}</p>
    <p className="mt-1 truncate text-xs text-gray-400">关联客户 ID：{opportunity.leadId}</p>
    <p className="mt-2 text-sm font-semibold">{formatOpportunityAmount(opportunity.amount, opportunity.currency)}</p><p className="mt-1 text-xs text-gray-500">{opportunity.probability}% · {formatOpportunityDate(opportunity.expectedCloseDate)}</p>
  </Link>;
}

function EmptyOpportunities() { return <div className="p-12 text-center text-sm text-gray-500">暂无商机，请先新建一条正式商机。</div>; }
