'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import api from '@/lib/api';
import { Card } from '@/components/ui/card';
import { FileText, FileCheck, ScrollText, Package, Filter, Calculator, Eye, Search, X } from 'lucide-react';
import { formatQuoteAmount, formatQuoteDate, type QuoteListItem, type QuoteListResponse, type QuoteStatus } from '@/types/quote';

const DOC_TYPES = ['all', 'quote', 'pi', 'contract', 'sample'] as const;
const TYPE_LABELS: Record<string, { label: string; icon: React.ReactNode }> = {
  all: { label: '全部', icon: null },
  quote: { label: '报价单', icon: <FileText className="w-3 h-3" /> },
  pi: { label: 'PI', icon: <FileCheck className="w-3 h-3" /> },
  contract: { label: '合同', icon: <ScrollText className="w-3 h-3" /> },
  sample: { label: '样品单', icon: <Package className="w-3 h-3" /> },
};
const STATUSES: Array<'all' | QuoteStatus> = ['all', 'draft', 'sent', 'accepted', 'rejected', 'expired', 'cancelled'];
const STATUS_LABELS: Record<string, string> = {
  all: '全部', draft: '草稿', sent: '已发送', accepted: '已接受', rejected: '已拒绝', expired: '已过期', cancelled: '已取消',
};

export default function QuotesPage() {
  const [quotes, setQuotes] = useState<QuoteListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [docType, setDocType] = useState<(typeof DOC_TYPES)[number]>('all');
  const [status, setStatus] = useState<'all' | QuoteStatus>('all');
  const [custSearch, setCustSearch] = useState('');

  useEffect(() => {
    api.get<QuoteListResponse>('/quotes', { params: { limit: 100 } }).then((res) => {
      setQuotes(res.data?.data || []);
    }).catch(() => setError('加载失败')).finally(() => setLoading(false));
  }, []);

  const filtered = quotes.filter((quote) => {
    if (docType !== 'all' && quote.type !== docType) return false;
    if (status !== 'all' && quote.status !== status) return false;
    if (custSearch && !(quote.lead?.companyName || '').toLowerCase().includes(custSearch.toLowerCase())) return false;
    return true;
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">外贸文档中心</h1>
          <p className="text-sm text-gray-500 mt-0.5">报价单 · PI · 合同 · 样品单 — 文档草稿、审批与版本管理。</p>
        </div>
        <Link href="/products" className="px-3 py-1.5 text-sm border rounded-md hover:bg-gray-50 flex items-center gap-1.5">
          <Calculator className="w-3.5 h-3.5" /> 报价计算器
        </Link>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: '全部文档', value: quotes.length, color: 'text-blue-700' },
          { label: '草稿', value: quotes.filter((quote) => quote.status === 'draft').length, color: 'text-amber-700' },
          { label: '已发送', value: quotes.filter((quote) => quote.status === 'sent').length, color: 'text-green-700' },
          { label: '已接受', value: quotes.filter((quote) => quote.status === 'accepted').length, color: 'text-green-800' },
        ].map((metric) => (
          <Card key={metric.label} className="p-3">
            <p className="text-[10px] text-gray-500">{metric.label}</p>
            <p className={`text-xl font-bold mt-0.5 ${metric.color}`}>{metric.value}</p>
          </Card>
        ))}
      </div>

      <div className="flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-1.5">
          <Filter className="w-3.5 h-3.5 text-gray-400" />
          <span className="text-xs text-gray-500 mr-1">类型:</span>
          {DOC_TYPES.map((type) => (
            <button key={type} onClick={() => setDocType(type)}
              className={`text-[11px] px-2.5 py-1 rounded-md border transition-colors ${docType === type ? 'bg-blue-50 border-blue-200 text-blue-700 font-semibold' : 'border-gray-200 text-gray-500 hover:bg-gray-50'}`}>
              {TYPE_LABELS[type].label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-gray-500 mr-1">状态:</span>
          {STATUSES.map((value) => (
            <button key={value} onClick={() => setStatus(value)}
              className={`text-[11px] px-2.5 py-1 rounded-md border transition-colors ${status === value ? 'bg-blue-50 border-blue-200 text-blue-700 font-semibold' : 'border-gray-200 text-gray-500 hover:bg-gray-50'}`}>
              {STATUS_LABELS[value]}
            </button>
          ))}
        </div>
        <div className="relative ml-auto">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-gray-400" />
          <input type="text" placeholder="搜索客户..." value={custSearch} onChange={(event) => setCustSearch(event.target.value)}
            className="w-40 h-8 pl-7 pr-2 rounded-md border text-xs outline-none focus:border-blue-300" />
          {custSearch && <button onClick={() => setCustSearch('')} className="absolute right-1.5 top-1/2 -translate-y-1/2"><X className="w-3 h-3 text-gray-400" /></button>}
        </div>
      </div>

      <Card className="overflow-hidden">
        {loading ? (
          <div className="flex justify-center py-16"><div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" /></div>
        ) : error ? (
          <div className="p-8 text-center text-sm text-red-600">{error}</div>
        ) : filtered.length === 0 ? (
          <div className="p-12 text-center">
            <FileText className="w-10 h-10 mx-auto text-gray-300 mb-3" />
            <p className="text-sm font-medium text-gray-700">暂无文档</p>
            <p className="text-xs text-gray-500 mt-1">{docType !== 'all' || status !== 'all' ? '当前筛选条件下没有匹配的文档。' : '从沟通中心或报价计算器创建第一份文档。'}</p>
          </div>
        ) : (
          <div className="divide-y">
            {filtered.map((quote) => (
              <Link key={quote.id} href={`/quotes/${quote.id}`} className="flex items-center justify-between px-5 py-3.5 hover:bg-gray-50 transition-colors">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium">{quote.referenceNo || '草稿'}</p>
                    <span className="text-[9px] px-1.5 py-0.5 rounded-full border flex items-center gap-0.5 bg-gray-50 text-gray-600">
                      {TYPE_LABELS[quote.type].icon}{TYPE_LABELS[quote.type].label}
                    </span>
                    <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-600">{STATUS_LABELS[quote.status] || '草稿'}</span>
                  </div>
                   <p className="text-xs text-gray-500 mt-0.5">
                    {quote.lead?.companyName || '未关联客户'} · {formatQuoteAmount(quote.totalAmount, quote.currency)}{quote.itemCount ? ` · ${quote.itemCount} 项产品` : ''}
                   </p>
                   {quote.opportunity && <p className="text-xs text-blue-600">商机：{quote.opportunity.name} · {quote.opportunity.stage}</p>}
                </div>
                <div className="flex items-center gap-3 shrink-0 ml-4">
                  <span className="text-[10px] text-gray-400">{formatQuoteDate(quote.createdAt)}</span>
                  <Eye className="w-4 h-4 text-gray-300" />
                </div>
              </Link>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
