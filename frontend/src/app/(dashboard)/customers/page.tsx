'use client';

import { useEffect, useState, useMemo, useCallback } from 'react';
import Link from 'next/link';
import api from '@/lib/api';
import { Card } from '@/components/ui/card';
import { Plus, LayoutList, Columns, Search, Filter, X, ChevronLeft, ChevronRight, Download, Loader2 } from 'lucide-react';
import { CustomerKanban } from '@/components/customers/customer-kanban';
import { CustomerTable } from '@/components/customers/customer-table';
import { SegmentSidebar, type SegmentGroup } from '@/components/customers/segment-sidebar';
import { BatchToolbar } from '@/components/customers/batch-toolbar';

const PAGE_SIZE = 20;

export default function CustomersPage() {
  const [view, setView] = useState<'list' | 'board'>('list');
  const [allLeads, setAllLeads] = useState<any[]>([]);
  const [segment, setSegment] = useState<string>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [search, setSearch] = useState('');
  const [filterGrade, setFilterGrade] = useState<string>('');
  const [filterSource, setFilterSource] = useState<string>('');
  const [filterStatus, setFilterStatus] = useState<string>('');
  const [showFilters, setShowFilters] = useState(false);

  // Selection & batch
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchLoading, setBatchLoading] = useState(false);

  // Pagination
  const [page, setPage] = useState(1);

  useEffect(() => {
    setLoading(true);
    api.get('/leads', { params: { page: 1, limit: 500 } })
      .then((res) => {
        const data = res.data?.data || res.data || [];
        setAllLeads(Array.isArray(data) ? data : []);
      })
      .catch(() => setError('加载客户列表失败'))
      .finally(() => setLoading(false));
  }, []);

  // Derived data
  const stageCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    allLeads.forEach((l: any) => {
      const s = l.status || 'new';
      counts[s] = (counts[s] || 0) + 1;
    });
    return counts;
  }, [allLeads]);

  // Segment definition
  const dynamicSegments: SegmentGroup[] = useMemo(() => [
    { key: 'recent7', label: '最近7天联系', count: allLeads.filter((l: any) => l.lastContactedAt && (Date.now() - new Date(l.lastContactedAt).getTime()) < 7 * 86400000).length },
    { key: 'inactive', label: '超7天未联系', count: allLeads.filter((l: any) => !l.lastContactedAt || (Date.now() - new Date(l.lastContactedAt).getTime()) > 7 * 86400000).length },
    { key: 'pinned', label: '我的关注', count: allLeads.filter((l: any) => l.isPinned).length },
    { key: 'updated', label: '资料有更新', count: 0, highlight: false },
    { key: 'won', label: '今年已成交', count: allLeads.filter((l: any) => l.status === 'won').length },
  ], [allLeads]);

  // Filtering
  const filteredLeads = useMemo(() => {
    let result = allLeads;

    // Segment filter
    if (segment === 'A') result = result.filter((l: any) => l.leadGrade === 'A');
    else if (segment === 'B') result = result.filter((l: any) => l.leadGrade === 'B');
    else if (segment === 'C') result = result.filter((l: any) => l.leadGrade === 'C');
    else if (segment === 'new') result = result.filter((l: any) => l.status === 'new');
    else if (segment === 'contacted') result = result.filter((l: any) => l.status === 'contacted');
    else if (segment === 'sampling') result = result.filter((l: any) => l.status === 'sampling');
    else if (segment === 'quoting') result = result.filter((l: any) => l.status === 'quoting');
    else if (segment === 'negotiating') result = result.filter((l: any) => l.status === 'negotiating');
    else if (segment === 'won_') result = result.filter((l: any) => l.status === 'won');
    else if (segment === 'recent7') result = result.filter((l: any) => l.lastContactedAt && (Date.now() - new Date(l.lastContactedAt).getTime()) < 7 * 86400000);
    else if (segment === 'inactive') result = result.filter((l: any) => !l.lastContactedAt || (Date.now() - new Date(l.lastContactedAt).getTime()) > 7 * 86400000);
    else if (segment === 'pinned') result = result.filter((l: any) => l.isPinned);

    // Additional filters
    if (search) {
      const q = search.toLowerCase();
      result = result.filter((l: any) =>
        (l.companyName || '').toLowerCase().includes(q) ||
        (l.contactName || '').toLowerCase().includes(q) ||
        (l.contactEmail || '').toLowerCase().includes(q)
      );
    }
    if (filterGrade) result = result.filter((l: any) => l.leadGrade === filterGrade);
    if (filterSource) result = result.filter((l: any) => l.sourceType === filterSource);
    if (filterStatus) result = result.filter((l: any) => l.status === filterStatus);

    return result;
  }, [allLeads, segment, search, filterGrade, filterSource, filterStatus]);

  // Sort: pinned first, then by updatedAt
  const sortedLeads = useMemo(() =>
    [...filteredLeads].sort((a, b) => {
      if (a.isPinned && !b.isPinned) return -1;
      if (!a.isPinned && b.isPinned) return 1;
      return new Date(b.updatedAt || b.createdAt || 0).getTime() - new Date(a.updatedAt || a.createdAt || 0).getTime();
    }),
    [filteredLeads]
  );

  // Pagination
  const totalPages = Math.ceil(sortedLeads.length / PAGE_SIZE);
  const pagedLeads = useMemo(() =>
    sortedLeads.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [sortedLeads, page]
  );

  // Selection handlers
  const toggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    if (pagedLeads.every((l: any) => selectedIds.has(l.id))) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(pagedLeads.map((l: any) => l.id)));
    }
  }, [pagedLeads, selectedIds]);

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  // Batch actions
  const handleBatchAction = useCallback(async (action: string, data?: any) => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setBatchLoading(true);
    try {
      if (action === 'export') {
        // Trigger download
        const res = await api.get('/leads/export', {
          params: { ids: ids.join(','), format: 'csv' },
          responseType: 'blob',
        });
        const url = window.URL.createObjectURL(new Blob([res.data]));
        const a = document.createElement('a');
        a.href = url;
        a.download = `customers_export_${new Date().toISOString().slice(0, 10)}.csv`;
        a.click();
        window.URL.revokeObjectURL(url);
      } else {
        await api.post('/leads/batch', { ids, action, data });
      }
      clearSelection();
      // Refresh
      const res = await api.get('/leads', { params: { page: 1, limit: 500 } });
      const listData = res.data?.data || res.data || [];
      setAllLeads(Array.isArray(listData) ? listData : []);
    } catch (err) {
      console.error('Batch action failed:', err);
    } finally {
      setBatchLoading(false);
    }
  }, [selectedIds, clearSelection]);

  // Reset page when filters change
  useEffect(() => { setPage(1); }, [segment, search, filterGrade, filterSource, filterStatus]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-6 pt-4 pb-2 shrink-0">
        <div>
          <h1 className="text-xl font-bold text-gray-900">客户资产中心</h1>
          <p className="text-xs text-gray-500 mt-0.5">
            所有客户、联系人、沟通记录、询盘、报价和订单统一管理
          </p>
        </div>
        <div className="flex gap-2">
          {/* View toggle */}
          <div className="flex border rounded-md overflow-hidden">
            <button
              onClick={() => setView('list')}
              className={`px-2.5 py-1.5 text-xs flex items-center gap-1 ${view === 'list' ? 'bg-blue-50 text-blue-700 font-medium' : 'text-gray-500 hover:bg-gray-50'}`}
            >
              <LayoutList className="w-3.5 h-3.5" /> 列表
            </button>
            <button
              onClick={() => setView('board')}
              className={`px-2.5 py-1.5 text-xs flex items-center gap-1 ${view === 'board' ? 'bg-blue-50 text-blue-700 font-medium' : 'text-gray-500 hover:bg-gray-50'}`}
            >
              <Columns className="w-3.5 h-3.5" /> 看板
            </button>
          </div>
          <Link
            href="/leads/import"
            className="px-3 py-1.5 text-xs border rounded-md hover:bg-gray-50 text-gray-600 flex items-center gap-1"
          >
            <Download className="w-3 h-3" /> 导入
          </Link>
          <Link
            href="/leads/new"
            className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded-md hover:bg-blue-700 flex items-center gap-1 font-medium"
          >
            <Plus className="w-3.5 h-3.5" /> 新增客户
          </Link>
        </div>
      </div>


      <div className="flex flex-1 overflow-hidden border-t">
        {/* Left Segment Sidebar */}
        <SegmentSidebar
          segments={dynamicSegments}
          activeSegment={segment}
          onSegmentChange={setSegment}
          stageCounts={stageCounts}
          totalLeads={allLeads.length}
        />

        {/* Right: Toolbar + Content */}
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Toolbar: Search + Filters */}
          <div className="px-4 py-2 border-b flex items-center gap-3 shrink-0 flex-wrap">
            {/* Search */}
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                placeholder="搜索公司名称、联系人..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="pl-7 pr-3 py-1.5 text-[12px] border rounded-md w-52 outline-none focus:border-blue-400 transition-colors"
              />
              {search && (
                <button onClick={() => setSearch('')} className="absolute right-1.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>

            {/* Grade filter */}
            <select
              value={filterGrade}
              onChange={(e) => setFilterGrade(e.target.value)}
              className="text-[11px] border rounded px-2 py-1.5 bg-white text-gray-600 outline-none"
            >
              <option value="">全部等级</option>
              <option value="A">A 级</option>
              <option value="B">B 级</option>
              <option value="C">C 级</option>
            </select>

            {/* Source filter */}
            <select
              value={filterSource}
              onChange={(e) => setFilterSource(e.target.value)}
              className="text-[11px] border rounded px-2 py-1.5 bg-white text-gray-600 outline-none"
            >
              <option value="">全部来源</option>
              <option value="website_inquiry">网站询盘</option>
              <option value="alibaba_inquiry">阿里询盘</option>
              <option value="acquisition">获客开发</option>
              <option value="manual">手动录入</option>
              <option value="whatsapp_click">WhatsApp</option>
              <option value="whatsapp">WhatsApp 自动建档</option>
              <option value="google">Google</option>
              <option value="facebook">Facebook</option>
              <option value="exhibition">展会</option>
            </select>

            {/* Status filter */}
            <select
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
              className="text-[11px] border rounded px-2 py-1.5 bg-white text-gray-600 outline-none"
            >
              <option value="">全部状态</option>
              <option value="new">新客户</option>
              <option value="contacted">已联系</option>
              <option value="sampling">样品中</option>
              <option value="quoting">报价中</option>
              <option value="negotiating">谈判中</option>
              <option value="won">已成交</option>
              <option value="lost">暂停</option>
            </select>

            {/* Clear filters */}
            {(filterGrade || filterSource || filterStatus) && (
              <button
                onClick={() => { setFilterGrade(''); setFilterSource(''); setFilterStatus(''); }}
                className="text-[10px] text-blue-600 hover:underline"
              >
                清除筛选
              </button>
            )}

            <div className="flex-1" />

            <span className="text-[11px] text-gray-400">
              共 {filteredLeads.length} 个客户
            </span>
          </div>

          {/* Batch Toolbar */}
          <div className="px-4 pt-2 shrink-0">
            <BatchToolbar
              selectedCount={selectedIds.size}
              selectedIds={Array.from(selectedIds)}
              onClear={clearSelection}
              onAction={handleBatchAction}
            />
          </div>

          {/* Content area */}
          <div className="flex-1 overflow-auto px-4">
            {view === 'board' ? (
              <CustomerKanban leads={pagedLeads} loading={loading} error={error} />
            ) : (
              <Card className="border-0 shadow-none">
                <CustomerTable
                  leads={pagedLeads}
                  selectedIds={selectedIds}
                  onToggleSelect={toggleSelect}
                  onToggleSelectAll={toggleSelectAll}
                  loading={loading}
                  error={error}
                />
              </Card>
            )}
          </div>

          {/* Pagination */}
          {view === 'list' && totalPages > 1 && (
            <div className="px-4 py-3 border-t flex items-center justify-between shrink-0">
              <span className="text-[11px] text-gray-500">
                共 {filteredLeads.length} 条，第 {page}/{totalPages} 页
              </span>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  className="px-2 py-1 text-[11px] border rounded hover:bg-gray-50 disabled:opacity-30"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                </button>
                {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                  let pageNum: number;
                  if (totalPages <= 5) {
                    pageNum = i + 1;
                  } else if (page <= 3) {
                    pageNum = i + 1;
                  } else if (page >= totalPages - 2) {
                    pageNum = totalPages - 4 + i;
                  } else {
                    pageNum = page - 2 + i;
                  }
                  return (
                    <button
                      key={pageNum}
                      onClick={() => setPage(pageNum)}
                      className={`px-2.5 py-1 text-[11px] rounded ${page === pageNum ? 'bg-blue-50 text-blue-700 border border-blue-200 font-medium' : 'border hover:bg-gray-50'}`}
                    >
                      {pageNum}
                    </button>
                  );
                })}
                <button
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages}
                  className="px-2 py-1 text-[11px] border rounded hover:bg-gray-50 disabled:opacity-30"
                >
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
                <span className="text-[10px] text-gray-400 ml-2">
                  跳至
                  <input
                    type="number"
                    min={1}
                    max={totalPages}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        const v = parseInt((e.target as HTMLInputElement).value);
                        if (v >= 1 && v <= totalPages) setPage(v);
                      }
                    }}
                    className="w-10 mx-1 px-1 py-0.5 border rounded text-center text-[11px]"
                  />
                  页
                </span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
