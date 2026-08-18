'use client';

import { useEffect, useMemo, useState } from 'react';
import { Calculator, CheckCircle2, FileText, Loader2, Search } from 'lucide-react';
import api from '@/lib/api';

interface CatalogItem {
  catalogItemId: string;
  categoryCn: string;
  categoryEn: string;
  size: string;
  thickness: string;
  packageText: string;
  unit: string;
  costCny: number;
  saleUsd: number;
}

interface CatalogMeta {
  priceVersion: string;
  effectiveAt: string;
  source: string;
  pricingPolicy: {
    protectionFxRateCnyPerUsd: number;
    markup: number;
    requiresHumanApproval: boolean;
  };
}

export function QuoteCalculator() {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<CatalogItem[]>([]);
  const [meta, setMeta] = useState<CatalogMeta | null>(null);
  const [selected, setSelected] = useState<CatalogItem | null>(null);
  const [quantity, setQuantity] = useState(1000);
  const [leadSearch, setLeadSearch] = useState('');
  const [selectedLead, setSelectedLead] = useState<any>(null);
  const [leadResults, setLeadResults] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const response = await api.get('/products/pricing-catalog', { params: { q: query, limit: 50 } });
        setItems(response.data?.data || []);
        setMeta(response.data || null);
      } finally {
        setLoading(false);
      }
    }, 180);
    return () => window.clearTimeout(timer);
  }, [query]);

  const totalUsd = useMemo(
    () => selected ? Number((selected.saleUsd * Math.max(quantity, 0)).toFixed(2)) : 0,
    [selected, quantity],
  );

  const searchLeads = async (value: string) => {
    setLeadSearch(value);
    if (value.trim().length < 2) return setLeadResults([]);
    try {
      const response = await api.get('/leads', { params: { search: value, limit: 5 } });
      setLeadResults(response.data?.data || []);
    } catch {
      setLeadResults([]);
    }
  };

  const createQuote = async () => {
    if (!selected || quantity <= 0) return;
    setCreating(true);
    setMessage('');
    try {
      const response = await api.post('/quotes', {
        leadId: selectedLead?.id || undefined,
        currency: 'USD',
        tradeTerms: 'FOB Shenzhen',
        lineItems: [{
          catalogItemId: selected.catalogItemId,
          productName: selected.categoryCn,
          size: selected.size,
          thickness: selected.thickness,
          quantity,
          unit: selected.unit,
          unitPrice: selected.saleUsd,
        }],
        notes: `资料库一键报价；价格版本 ${meta?.priceVersion || 'unknown'}。需业务员确认后发送。`,
      });
      setMessage(`报价草稿 ${response.data.referenceNo} 已生成，金额 USD ${Number(response.data.totalAmount).toFixed(2)}`);
    } catch (error: any) {
      setMessage(error?.response?.data?.message || '生成报价失败，请检查后端连接。');
    } finally {
      setCreating(false);
    }
  };

  return (
    <section className="bg-white border rounded-lg p-6 space-y-4">
      <div>
        <h2 className="text-lg font-bold flex items-center gap-2"><Calculator className="w-5 h-5" />资料库一键报价（USD）</h2>
        <p className="text-xs text-gray-500 mt-1">直接使用Vaysen主报价表，不再使用模拟面积公式或模拟汇率。报价仅生成草稿，发送前必须人工确认。</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="relative">
          <Search className="absolute left-2.5 top-2.5 w-4 h-4 text-gray-400" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索品类、规格、编号"
            className="w-full border rounded-md py-2 pl-8 pr-3 text-sm" />
        </div>
        <div className="relative">
          <input value={leadSearch} onChange={(event) => searchLeads(event.target.value)} placeholder="关联客户（可选）"
            className="w-full border rounded-md py-2 px-3 text-sm" />
          {leadResults.length > 0 && <div className="absolute z-20 top-10 inset-x-0 bg-white border rounded-md shadow-lg max-h-40 overflow-auto">
            {leadResults.map((lead) => <button key={lead.id} type="button" onClick={() => { setSelectedLead(lead); setLeadSearch(lead.companyName || lead.contactName || '客户'); setLeadResults([]); }}
              className="block w-full text-left px-3 py-2 text-xs hover:bg-blue-50">{lead.companyName || lead.contactName} · {lead.country || '未知地区'}</button>)}
          </div>}
        </div>
      </div>

      <div className="border rounded-md max-h-72 overflow-auto">
        {loading ? <div className="p-8 flex justify-center"><Loader2 className="w-5 h-5 animate-spin" /></div> : items.length === 0 ?
          <p className="p-8 text-center text-sm text-gray-500">没有匹配的报价规格</p> :
          items.map((item) => <button key={item.catalogItemId} type="button" onClick={() => setSelected(item)}
            className={`w-full grid grid-cols-[90px_1fr_100px_90px] gap-2 px-3 py-2 text-xs text-left border-b last:border-0 hover:bg-blue-50 ${selected?.catalogItemId === item.catalogItemId ? 'bg-blue-50 ring-1 ring-inset ring-blue-300' : ''}`}>
            <span className="font-mono text-gray-500">{item.catalogItemId}</span>
            <span><b>{item.categoryCn}</b><span className="text-gray-500"> · {item.size} · {item.thickness}</span></span>
            <span className="text-gray-500">{item.packageText}</span>
            <span className="font-semibold text-blue-700">${item.saleUsd.toFixed(3)}/pc</span>
          </button>)}
      </div>

      {selected && <div className="bg-blue-50 border border-blue-100 rounded-lg p-4 grid grid-cols-1 md:grid-cols-[1fr_160px_160px] gap-4 items-end">
        <div>
          <p className="text-xs text-gray-500">已选规格</p>
          <p className="text-sm font-semibold">{selected.categoryCn} · {selected.size} · {selected.thickness}</p>
          <p className="text-[11px] text-gray-500 mt-1">成本留痕 ¥{selected.costCny.toFixed(3)}；销售标价 ${selected.saleUsd.toFixed(3)}。正式成交价仍需审批。</p>
        </div>
        <label className="text-xs text-gray-600">数量（pcs）
          <input type="number" min={1} step={100} value={quantity} onChange={(event) => setQuantity(Number(event.target.value))}
            className="mt-1 w-full border rounded px-2 py-2 text-sm bg-white" />
        </label>
        <div>
          <p className="text-xs text-gray-500">USD 合计</p>
          <p className="text-xl font-bold text-blue-700">${totalUsd.toFixed(2)}</p>
        </div>
      </div>}

      <div className="flex items-center justify-between gap-4">
        <p className="text-[10px] text-gray-500">版本 {meta?.priceVersion || '-'} · 生效 {meta?.effectiveAt || '-'} · 保护汇率 1 USD = {meta?.pricingPolicy?.protectionFxRateCnyPerUsd || '-'} CNY · 加价系数 {meta?.pricingPolicy?.markup || '-'}</p>
        <button type="button" onClick={createQuote} disabled={!selected || creating || quantity <= 0}
          className="shrink-0 px-4 py-2 bg-green-600 text-white rounded-md text-sm font-medium disabled:opacity-40 flex items-center gap-2">
          {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />}生成报价草稿
        </button>
      </div>
      {message && <p className="text-sm text-green-700 flex items-center gap-2"><CheckCircle2 className="w-4 h-4" />{message}</p>}
    </section>
  );
}
