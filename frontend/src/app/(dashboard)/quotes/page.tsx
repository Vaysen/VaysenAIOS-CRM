'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import api from '@/lib/api';
import { Card } from '@/components/ui/card';
import { FileText, FileCheck, ScrollText, Package, Filter, Plus, Calculator, Eye, Search, X } from 'lucide-react';

const DOC_TYPES = ['all', 'quote', 'pi', 'contract', 'sample'] as const;
const TYPE_LABELS: Record<string, { label: string; icon: React.ReactNode }> = {
  all: { label: '全部', icon: null },
  quote: { label: '报价单', icon: <FileText className="w-3 h-3" /> },
  pi: { label: 'PI', icon: <FileCheck className="w-3 h-3" /> },
  contract: { label: '合同', icon: <ScrollText className="w-3 h-3" /> },
  sample: { label: '样品单', icon: <Package className="w-3 h-3" /> },
};

const STATUSES = ['all', 'draft', 'pending', 'approved', 'sent', 'accepted'];
const STATUS_LABELS: Record<string, string> = {
  all: '全部', draft: '草稿', pending: '待审核', approved: '已批准', sent: '已发送', accepted: '已接受',
};

export default function QuotesPage() {
  const [quotes, setQuotes] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [docType, setDocType] = useState<string>('all');
  const [status, setStatus] = useState<string>('all');
  const [custSearch, setCustSearch] = useState('');

  useEffect(() => {
    api.get('/quotes', { params: { limit: 100 } }).then((res) => {
      setQuotes(res.data?.data || []);
    }).catch(() => setError('加载失败')).finally(() => setLoading(false));
  }, []);

  const parseFields = (q: any) => {
    try { return JSON.parse(q.outputContent || '{}'); } catch { return {}; }
  };

  const getDocType = (fields: any) => {
    if (fields.type === 'pi' || fields.referenceNo?.startsWith('PI-')) return 'pi';
    if (fields.type === 'contract' || fields.referenceNo?.startsWith('CT-')) return 'contract';
    if (fields.type === 'sample' || fields.referenceNo?.startsWith('SP-')) return 'sample';
    return 'quote';
  };

  const filtered = quotes.filter((q: any) => {
    const fields = parseFields(q);
    const t = getDocType(fields);
    if (docType !== 'all' && t !== docType) return false;
    if (status !== 'all' && fields.status !== status) return false;
    if (custSearch) {
      const name = (fields.lead?.companyName || '').toLowerCase();
      if (!name.includes(custSearch.toLowerCase())) return false;
    }
    return true;
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">外贸文档中心</h1>
          <p className="text-sm text-gray-500 mt-0.5">报价单 · PI · 合同 · 样品单 — 文档草稿、审批与版本管理。</p>
        </div>
        <div className="flex gap-2">
          <Link href="/products" className="px-3 py-1.5 text-sm border rounded-md hover:bg-gray-50 flex items-center gap-1.5">
            <Calculator className="w-3.5 h-3.5" /> 报价计算器
          </Link>
        </div>
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {[
          { label: '全部文档', value: quotes.length, color: 'bg-blue-50 text-blue-700' },
          { label: '草稿', value: quotes.filter((q: any) => parseFields(q).status === 'draft').length, color: 'bg-amber-50 text-amber-700' },
          { label: '待审核', value: quotes.filter((q: any) => parseFields(q).status === 'pending').length, color: 'bg-purple-50 text-purple-700' },
          { label: '已发送', value: quotes.filter((q: any) => parseFields(q).status === 'sent').length, color: 'bg-green-50 text-green-700' },
          { label: '已接受', value: quotes.filter((q: any) => parseFields(q).status === 'accepted').length, color: 'bg-green-100 text-green-800' },
        ].map((m) => (
          <Card key={m.label} className="p-3">
            <p className="text-[10px] text-gray-500">{m.label}</p>
            <p className={`text-xl font-bold mt-0.5 ${m.color.split(' ')[1]}`}>{m.value}</p>
          </Card>
        ))}
      </div>

      {/* Filters */}
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-1.5">
          <Filter className="w-3.5 h-3.5 text-gray-400" />
          <span className="text-xs text-gray-500 mr-1">类型:</span>
          {DOC_TYPES.map((t) => (
            <button key={t} onClick={() => setDocType(t)}
              className={`text-[11px] px-2.5 py-1 rounded-md border transition-colors ${docType === t ? 'bg-blue-50 border-blue-200 text-blue-700 font-semibold' : 'border-gray-200 text-gray-500 hover:bg-gray-50'}`}>
              {TYPE_LABELS[t].label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-gray-500 mr-1">状态:</span>
          {STATUSES.map((s) => (
            <button key={s} onClick={() => setStatus(s)}
              className={`text-[11px] px-2.5 py-1 rounded-md border transition-colors ${status === s ? 'bg-blue-50 border-blue-200 text-blue-700 font-semibold' : 'border-gray-200 text-gray-500 hover:bg-gray-50'}`}>
              {STATUS_LABELS[s]}
            </button>
          ))}
        </div>
        <div className="relative ml-auto">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-gray-400" />
          <input type="text" placeholder="搜索客户..." value={custSearch} onChange={(e) => setCustSearch(e.target.value)}
            className="w-40 h-8 pl-7 pr-2 rounded-md border text-xs outline-none focus:border-blue-300" />
          {custSearch && <button onClick={() => setCustSearch('')} className="absolute right-1.5 top-1/2 -translate-y-1/2"><X className="w-3 h-3 text-gray-400" /></button>}
        </div>
      </div>

      {/* Document list */}
      <Card className="overflow-hidden">
        {loading ? (
          <div className="flex justify-center py-16"><div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" /></div>
        ) : error ? (
          <div className="p-8 text-center text-sm text-red-600">{error}</div>
        ) : filtered.length === 0 ? (
          <div className="p-12 text-center">
            <FileText className="w-10 h-10 mx-auto text-gray-300 mb-3" />
            <p className="text-sm font-medium text-gray-700">暂无文档</p>
            <p className="text-xs text-gray-500 mt-1">
              {docType !== 'all' || status !== 'all' ? '当前筛选条件下没有匹配的文档。' : '从沟通中心或报价计算器创建第一份文档。'}
            </p>
          </div>
        ) : (
          <div className="divide-y">
            {filtered.map((q: any) => {
              const fields = parseFields(q);
              const dt = getDocType(fields);
              return (
                <Link key={q.id} href={`/quotes/${q.id}`}
                  className="flex items-center justify-between px-5 py-3.5 hover:bg-gray-50 transition-colors">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium">{fields.referenceNo || '草稿'}</p>
                      <span className={`text-[9px] px-1.5 py-0.5 rounded-full border flex items-center gap-0.5 ${dt === 'pi' ? 'bg-blue-50 text-blue-600 border-blue-200' : dt === 'contract' ? 'bg-purple-50 text-purple-600' : dt === 'sample' ? 'bg-green-50 text-green-600' : 'bg-amber-50 text-amber-600'}`}>
                        {TYPE_LABELS[dt].icon}{TYPE_LABELS[dt].label}
                      </span>
                      <span className={`text-[9px] px-1.5 py-0.5 rounded-full ${fields.status === 'draft' ? 'bg-gray-100 text-gray-600' : fields.status === 'sent' ? 'bg-blue-50 text-blue-600' : fields.status === 'accepted' ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                        {STATUS_LABELS[fields.status] || '草稿'}
                      </span>
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {fields.lead?.companyName || '未关联客户'}
                      {fields.totalAmount ? ` · $${Number(fields.totalAmount).toLocaleString()}` : ''}
                      {fields.lineItems?.length ? ` · ${fields.lineItems.length} 项产品` : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0 ml-4">
                    <span className="text-[10px] text-gray-400">{new Date(q.createdAt).toLocaleDateString('zh-CN')}</span>
                    <Eye className="w-4 h-4 text-gray-300" />
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </Card>
    </div>
  );
}
