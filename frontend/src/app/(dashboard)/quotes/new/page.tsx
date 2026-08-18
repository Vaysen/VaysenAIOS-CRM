'use client';

import { useEffect, useState, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import api from '@/lib/api';
import { Card } from '@/components/ui/card';
import { ArrowLeft, FileText, FileCheck, ScrollText, Package, Loader2, CheckCircle } from 'lucide-react';
import { formatQuoteAmount, toQuoteCreateLineItem, type QuoteDetail, type QuoteDocumentType } from '@/types/quote';
import type { Opportunity, OpportunityListResponse } from '@/types/opportunity';

const TYPE_OPTIONS: Array<{ key: QuoteDocumentType; label: string; icon: React.ReactNode }> = [
  { key: 'quote', label: '报价单', icon: <FileText className="w-4 h-4" /> },
  { key: 'pi', label: 'PI (形式发票)', icon: <FileCheck className="w-4 h-4" /> },
  { key: 'contract', label: '合同', icon: <ScrollText className="w-4 h-4" /> },
  { key: 'sample', label: '样品单', icon: <Package className="w-4 h-4" /> },
];

function NewQuoteContent() {
  const params = useSearchParams();
  const fromId = params.get('from');
  const leadId = params.get('leadId');
  const requestedType = params.get('type');
  const docType: QuoteDocumentType = TYPE_OPTIONS.some((option) => option.key === requestedType)
    ? requestedType as QuoteDocumentType
    : 'pi';

  const [sourceQuote, setSourceQuote] = useState<QuoteDetail | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [referenceNo, setReferenceNo] = useState('');
  const [notes, setNotes] = useState('');
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [opportunityId, setOpportunityId] = useState('');

  useEffect(() => {
    if (fromId) {
      api.get<QuoteDetail>(`/quotes/${fromId}`).then((res) => setSourceQuote(res.data)).catch((error) => {
      console.error('[Frontend] background operation failed:', error);
      });
    }
  }, [fromId]);

  useEffect(() => {
    const opportunityLeadId = leadId || sourceQuote?.leadId;
    if (!opportunityLeadId) return;
    api.get<OpportunityListResponse>('/opportunities', { params: { leadId: opportunityLeadId, page: 1, limit: 100 } })
      .then((res) => setOpportunities(res.data?.data || []))
      .catch(() => setOpportunities([]));
  }, [leadId, sourceQuote?.leadId]);

  useEffect(() => {
    if (sourceQuote?.opportunity?.id) setOpportunityId(sourceQuote.opportunity.id);
  }, [sourceQuote]);

  const prefix = docType === 'pi' ? 'PI-' : docType === 'contract' ? 'CT-' : docType === 'sample' ? 'SP-' : 'QT-';
  const defaultRef = `${prefix}${Date.now().toString(36).toUpperCase().slice(-6)}`;
  const selectedType = TYPE_OPTIONS.find((option) => option.key === docType);

  const handleCreate = async () => {
    setSubmitting(true);
    try {
      await api.post('/quotes', {
        type: docType,
        leadId: leadId || sourceQuote?.leadId || undefined,
        opportunityId: opportunityId || undefined,
        conversationId: sourceQuote?.conversationId || undefined,
        lineItems: (sourceQuote?.lineItems || []).map(toQuoteCreateLineItem),
        tradeTerms: sourceQuote?.tradeTerms || undefined,
        paymentTerms: sourceQuote?.paymentTerms || undefined,
        deliveryTime: sourceQuote?.deliveryTime || undefined,
        referenceNo: referenceNo || defaultRef,
        notes: notes || `Generated from ${sourceQuote?.referenceNo || 'quote'}`,
      });
      setDone(true);
    } catch (error) {
      console.error('[Frontend] operation failed:', error);
      alert('创建失败，请重试。');
    } finally {
      setSubmitting(false);
    }
  };

  if (done) {
    return (
      <div className="p-6 max-w-lg mx-auto text-center">
        <div className="w-12 h-12 mx-auto mb-3 rounded-xl bg-green-50 flex items-center justify-center"><CheckCircle className="w-6 h-6 text-green-600" /></div>
        <h1 className="text-lg font-bold mb-2">创建成功</h1>
        <p className="text-sm text-gray-500 mb-4">{selectedType?.label}草稿已生成。</p>
        <Link href="/quotes" className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm hover:bg-blue-700">返回文档中心</Link>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-xl">
      <div className="flex items-center gap-3">
        <Link href="/quotes" className="text-gray-400 hover:text-gray-600"><ArrowLeft className="w-4 h-4" /></Link>
        <h1 className="text-xl font-bold">新建{selectedType?.label}草稿</h1>
      </div>

      {sourceQuote && (
        <Card className="p-4 bg-blue-50 border-blue-200">
          <p className="text-xs text-blue-700 font-medium">基于文档创建</p>
          <p className="text-sm text-blue-900 mt-0.5">{sourceQuote.referenceNo || '报价草稿'}</p>
          <p className="text-xs text-blue-600 mt-0.5">{sourceQuote.lead?.companyName || '未关联客户'} · {formatQuoteAmount(sourceQuote.totalAmount, sourceQuote.currency)}</p>
        </Card>
      )}

      {(leadId || sourceQuote?.leadId) && <Card className="p-4"><label className="text-xs font-medium text-gray-600">关联商机（可选）</label><select aria-label="关联商机" value={opportunityId} onChange={(event) => setOpportunityId(event.target.value)} className="mt-1 w-full rounded border px-2 py-1.5 text-sm"><option value="">不关联商机</option>{opportunities.map((opportunity) => <option key={opportunity.id} value={opportunity.id}>{opportunity.name} · {opportunity.stage}</option>)}{sourceQuote?.opportunity && !opportunities.some((opportunity) => opportunity.id === sourceQuote.opportunity?.id) && <option value={sourceQuote.opportunity.id}>{sourceQuote.opportunity.name} · 原报价摘要</option>}</select><p className="mt-1 text-[11px] text-gray-500">只提交 opportunityId；复制旧报价返回的摘要不会被当作完整商机对象。</p></Card>}

      <Card className="p-4">
        <div className="space-y-4">
          <div>
            <label className="text-xs font-medium text-gray-600">文档编号</label>
            <input value={referenceNo} onChange={(event) => setReferenceNo(event.target.value)} placeholder={defaultRef} className="w-full mt-1 border rounded px-2 py-1.5 text-sm" />
          </div>
          <div>
            <label className="text-xs font-medium text-gray-600">文档类型</label>
            <div className="flex gap-2 mt-1">
              {TYPE_OPTIONS.map((option) => <span key={option.key} className={`text-xs px-2.5 py-1 rounded-md border flex items-center gap-1 ${docType === option.key ? 'bg-blue-50 border-blue-300 text-blue-700' : 'text-gray-400'}`}>{option.icon}{option.label}</span>)}
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-gray-600">备注</label>
            <textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={3} className="w-full mt-1 border rounded px-2 py-1.5 text-sm resize-none" placeholder="添加备注说明..." />
          </div>
          <button onClick={handleCreate} disabled={submitting} className="w-full py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-40 flex items-center justify-center gap-2">
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileCheck className="w-4 h-4" />} 创建草稿
          </button>
          <p className="text-[9px] text-amber-600">⚠ 此为草稿，需业务员审核确认后才能对外发送。</p>
        </div>
      </Card>

      {!sourceQuote && !fromId && <p className="text-xs text-gray-400">从已有报价详情页点击“PI草稿/合同草稿/样品单”可基于现有报价创建新文档。</p>}
    </div>
  );
}

export default function NewQuotePage() {
  return <Suspense fallback={<div className="flex justify-center py-20"><div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" /></div>}><NewQuoteContent /></Suspense>;
}
