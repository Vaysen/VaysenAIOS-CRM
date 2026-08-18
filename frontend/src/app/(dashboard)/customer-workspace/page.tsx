'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, RefreshCw, Search, Users } from 'lucide-react';
import { getCustomerWorkspaceCounts, listCustomerWorkspace } from '@/lib/customer-workspace-api';
import {
  CUSTOMER_WORKSPACE_FILTERS,
  CUSTOMER_WORKSPACE_SORTS,
  type CustomerWorkspaceCounts,
  type CustomerWorkspaceFilter,
  type CustomerWorkspaceListItem,
  type CustomerWorkspaceSort,
} from '@/types/customer-workspace';

const FILTER_LABELS: Record<CustomerWorkspaceFilter, string> = {
  all: '全部', today_follow_up: '今日待跟进', new_messages: '新消息', active_opportunities: '进行中商机',
  identity_pending: '身份待确认', merge_pending: '合并待复核', archived: '已归档',
};

const SORT_LABELS: Record<CustomerWorkspaceSort, string> = {
  recent_contact: '最近联系', recent_update: '最近更新', follow_up_due: '待办到期', opportunity_amount: '商机金额', name: '姓名',
};

const EMPTY_COUNTS: CustomerWorkspaceCounts = { total: 0, todayFollowUp: 0, newMessages: 0, activeOpportunities: 0, identityPending: 0, mergePending: 0, archived: 0 };
const COUNT_CARDS = [
  ['total', '全部客户', 'all'], ['todayFollowUp', '今日待跟进', 'today_follow_up'], ['newMessages', '新消息', 'new_messages'],
  ['activeOpportunities', '进行中商机', 'active_opportunities'], ['identityPending', '身份待确认', 'identity_pending'], ['mergePending', '合并待复核', 'merge_pending'], ['archived', '已归档', 'archived'],
] as const;

export default function CustomerWorkspacePage() {
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<CustomerWorkspaceFilter>('all');
  const [sort, setSort] = useState<CustomerWorkspaceSort>('recent_update');
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<CustomerWorkspaceListItem[]>([]);
  const [meta, setMeta] = useState({ page: 1, limit: 20, total: 0, totalPages: 1 });
  const [counts, setCounts] = useState<CustomerWorkspaceCounts>(EMPTY_COUNTS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const [list, nextCounts] = await Promise.all([
        listCustomerWorkspace({ search: search.trim() || undefined, filter, sort, page, limit: 20 }),
        getCustomerWorkspaceCounts(),
      ]);
      setRows(list.data); setMeta(list.meta); setCounts(nextCounts);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '客户工作台加载失败');
    } finally { setLoading(false); }
  }, [filter, page, search, sort]);

  useEffect(() => { void load(); }, [load]);

  const applyFilter = (next: CustomerWorkspaceFilter) => { setFilter(next); setPage(1); };
  const formatAmount = (amount: CustomerWorkspaceListItem['opportunityAmount']) => amount == null ? '—' : `$${Number(amount).toLocaleString('en-US')}`;

  return (
    <div className="max-w-full min-w-0 space-y-5 overflow-x-hidden">
      <header>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">客户工作台</h1>
        <p className="mt-1 text-sm text-gray-500">按客户聚合跟进、消息、商机、身份和风险，打开客户详情查看完整 360。</p>
      </header>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        {COUNT_CARDS.map(([key, label, nextFilter]) => (
          <button key={key} type="button" onClick={() => applyFilter(nextFilter)} className="min-w-0 rounded-xl border bg-white p-3 text-left shadow-sm hover:border-blue-300 dark:border-gray-800 dark:bg-gray-950">
            <div className="text-xs text-gray-500">{label}</div>
            <div className="mt-1 text-xl font-semibold text-gray-900 dark:text-white">{counts[key] ?? 0}</div>
          </button>
        ))}
      </div>

      <section className="rounded-xl border bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <label className="relative min-w-0 flex-1"><Search className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" /><span className="sr-only">搜索客户</span><input value={search} maxLength={120} onChange={(event) => { setSearch(event.target.value); setPage(1); }} onKeyDown={(event) => { if (event.key === 'Enter') void load(); }} placeholder="搜索公司、联系人或客户 ID" className="w-full rounded-lg border py-2 pl-9 pr-3 text-sm outline-none focus:border-blue-500" /></label>
          <select aria-label="客户排序" value={sort} onChange={(event) => { setSort(event.target.value as CustomerWorkspaceSort); setPage(1); }} className="rounded-lg border px-3 py-2 text-sm">{CUSTOMER_WORKSPACE_SORTS.map((value) => <option key={value} value={value}>{SORT_LABELS[value]}</option>)}</select>
          <button type="button" onClick={() => void load()} aria-label="刷新客户工作台" className="inline-flex items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm hover:bg-gray-50"><RefreshCw className="h-4 w-4" />刷新</button>
        </div>
        <div className="mt-4 flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label="客户筛选">
          {CUSTOMER_WORKSPACE_FILTERS.map((value) => <button key={value} type="button" role="tab" aria-selected={filter === value} onClick={() => applyFilter(value)} className={`shrink-0 rounded-full px-3 py-1.5 text-xs ${filter === value ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>{FILTER_LABELS[value]}</button>)}
        </div>
      </section>

      {error && <div role="alert" className="flex items-center justify-between gap-3 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700"><span>{error}</span><button type="button" onClick={() => void load()} className="rounded border border-red-300 bg-white px-3 py-1.5">重试</button></div>}
      {loading ? <div className="rounded-xl border bg-white p-12 text-center text-sm text-gray-500 dark:border-gray-800 dark:bg-gray-950">正在加载客户工作台…</div> : rows.length === 0 ? <div className="rounded-xl border bg-white p-12 text-center dark:border-gray-800 dark:bg-gray-950"><Users className="mx-auto h-8 w-8 text-gray-300" /><p className="mt-2 text-sm text-gray-500">没有符合当前筛选的客户。</p></div> : <div className="overflow-hidden rounded-xl border bg-white dark:border-gray-800 dark:bg-gray-950"><div className="overflow-x-auto"><table className="min-w-[760px] w-full text-left text-sm"><thead className="bg-gray-50 text-xs text-gray-500 dark:bg-gray-900"><tr><th className="px-4 py-3">客户</th><th className="px-4 py-3">状态</th><th className="px-4 py-3">最近联系</th><th className="px-4 py-3">待跟进</th><th className="px-4 py-3">商机金额</th><th className="px-4 py-3">风险</th></tr></thead><tbody className="divide-y">{rows.map((row) => <tr key={row.id} className="hover:bg-gray-50 dark:hover:bg-gray-900"><td className="px-4 py-3"><Link href={`/customers/${encodeURIComponent(row.id)}`} className="font-medium text-blue-700 hover:underline">{row.displayName || row.companyName || '未命名客户'}</Link><div className="text-xs text-gray-400">{row.ownerName || '未分配'}{row.countryIso2 ? ` · ${row.countryIso2}` : ''}{row.unreadMessageCount ? ` · ${row.unreadMessageCount} 条新消息` : ''}</div></td><td className="px-4 py-3 text-gray-600">{row.archived ? '已归档' : row.status || '—'}</td><td className="px-4 py-3 text-gray-600">{row.lastContactedAt ? new Date(row.lastContactedAt).toLocaleDateString('zh-CN') : '—'}</td><td className="px-4 py-3 text-gray-600">{row.nextFollowUpAt ? new Date(row.nextFollowUpAt).toLocaleDateString('zh-CN') : '—'}</td><td className="px-4 py-3 text-gray-600">{formatAmount(row.opportunityAmount)}</td><td className="px-4 py-3">{row.risks?.length ? <span className="inline-flex items-center gap-1 text-amber-700"><AlertTriangle className="h-3.5 w-3.5" />{row.risks.length}</span> : <span className="text-gray-400">—</span>}</td></tr>)}</tbody></table></div><div className="flex items-center justify-between border-t px-4 py-3 text-xs text-gray-500"><span>共 {meta.total} 条 · 第 {meta.page}/{meta.totalPages} 页</span><div className="flex gap-1"><button type="button" disabled={page <= 1} onClick={() => setPage((value) => value - 1)} aria-label="上一页" className="rounded border p-1.5 disabled:opacity-40"><ChevronLeft className="h-4 w-4" /></button><button type="button" disabled={page >= meta.totalPages} onClick={() => setPage((value) => value + 1)} aria-label="下一页" className="rounded border p-1.5 disabled:opacity-40"><ChevronRight className="h-4 w-4" /></button></div></div></div>}
    </div>
  );
}
