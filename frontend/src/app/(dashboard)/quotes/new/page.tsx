'use client';

import { useEffect, useState, Suspense } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import api from '@/lib/api';
import { Card } from '@/components/ui/card';
import { ArrowLeft, FileText, FileCheck, ScrollText, Package, Loader2, CheckCircle } from 'lucide-react';

const TYPE_OPTIONS = [
  { key: 'quote', label: '报价单', icon: <FileText className="w-4 h-4" /> },
  { key: 'pi', label: 'PI (形式发票)', icon: <FileCheck className="w-4 h-4" /> },
  { key: 'contract', label: '合同', icon: <ScrollText className="w-4 h-4" /> },
  { key: 'sample', label: '样品单', icon: <Package className="w-4 h-4" /> },
];

function NewQuoteContent() {
  const params = useSearchParams();
  const router = useRouter();
  const fromId = params.get('from');
  const docType = params.get('type') || 'pi';

  const [sourceQuote, setSourceQuote] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [referenceNo, setReferenceNo] = useState('');
  const [notes, setNotes] = useState('');

  useEffect(() => {
    if (fromId) {
      api.get(`/quotes/${fromId}`).then((res) => setSourceQuote(res.data)).catch((error) => { console.error('[Frontend] background operation failed:', error); });
    }
  }, [fromId]);

  const fields = sourceQuote?.outputContent ? (() => { try { return JSON.parse(sourceQuote.outputContent); } catch { return {}; } })() : {};

  const prefix = docType === 'pi' ? 'PI-' : docType === 'contract' ? 'CT-' : docType === 'sample' ? 'SP-' : 'QT-';
  const defaultRef = `${prefix}${Date.now().toString(36).toUpperCase().slice(-6)}`;

  const handleCreate = async () => {
    setSubmitting(true);
    try {
      await api.post('/quotes', {
        type: docType,
        leadId: fields.lead?.id || sourceQuote?.leadId,
        conversationId: sourceQuote?.conversationId || undefined,
        lineItems: fields.lineItems || [],
        tradeTerms: fields.tradeTerms,
        paymentTerms: fields.paymentTerms,
        deliveryTime: fields.deliveryTime,
        referenceNo: referenceNo || defaultRef,
        notes: notes || `从 ${fields.referenceNo || '报价'} 生成的${TYPE_OPTIONS.find(t => t.key === docType)?.label}`,
      });
      setDone(true);
    } catch { alert('创建失败，请重试。'); }
    finally { setSubmitting(false); }
  };

  if (done) {
    return (
      <div className="p-6 max-w-lg mx-auto text-center">
        <div className="w-12 h-12 mx-auto mb-3 rounded-xl bg-green-50 flex items-center justify-center"><CheckCircle className="w-6 h-6 text-green-600"/></div>
        <h1 className="text-lg font-bold mb-2">创建成功</h1>
        <p className="text-sm text-gray-500 mb-4">{TYPE_OPTIONS.find(t => t.key === docType)?.label}草稿已生成。</p>
        <Link href="/quotes" className="px-4 py-2 bg-blue-600 text-white rounded-md text-sm hover:bg-blue-700">返回文档中心</Link>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-xl">
      <div className="flex items-center gap-3">
        <Link href="/quotes" className="text-gray-400 hover:text-gray-600"><ArrowLeft className="w-4 h-4" /></Link>
        <h1 className="text-xl font-bold">新建{TYPE_OPTIONS.find(t => t.key === docType)?.label}草稿</h1>
      </div>

      {sourceQuote && (
        <Card className="p-4 bg-blue-50 border-blue-200">
          <p className="text-xs text-blue-700 font-medium">基于文档创建</p>
          <p className="text-sm text-blue-900 mt-0.5">{fields.referenceNo || '报价草稿'}</p>
          <p className="text-xs text-blue-600 mt-0.5">{fields.lead?.companyName} · ${fields.totalAmount?.toLocaleString()}</p>
        </Card>
      )}

      <Card className="p-4">
        <div className="space-y-4">
          <div>
            <label className="text-xs font-medium text-gray-600">文档编号</label>
            <input value={referenceNo} onChange={(e) => setReferenceNo(e.target.value)}
              placeholder={defaultRef} className="w-full mt-1 border rounded px-2 py-1.5 text-sm" />
          </div>
          <div>
            <label className="text-xs font-medium text-gray-600">文档类型</label>
            <div className="flex gap-2 mt-1">
              {TYPE_OPTIONS.map((t) => (
                <span key={t.key} className={`text-xs px-2.5 py-1 rounded-md border flex items-center gap-1 ${docType === t.key ? 'bg-blue-50 border-blue-300 text-blue-700' : 'text-gray-400'}`}>
                  {t.icon}{t.label}
                </span>
              ))}
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-gray-600">备注</label>
            <textarea value={notes} onChange={(e) => setNotes(e.target.value)}
              rows={3} className="w-full mt-1 border rounded px-2 py-1.5 text-sm resize-none"
              placeholder="添加备注说明..." />
          </div>
          <button onClick={handleCreate} disabled={submitting}
            className="w-full py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-40 flex items-center justify-center gap-2">
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileCheck className="w-4 h-4" />}
            创建草稿
          </button>
          <p className="text-[9px] text-amber-600">⚠ 此为草稿，需业务员审核确认后才能对外发送。</p>
        </div>
      </Card>

      {!sourceQuote && !fromId && (
        <p className="text-xs text-gray-400">从已有报价详情页点击“PI草稿/合同草稿/样品单”可基于现有报价创建新文档。</p>
      )}
    </div>
  );
}

export default function NewQuotePage() {
  return (
    <Suspense fallback={<div className="flex justify-center py-20"><div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" /></div>}>
      <NewQuoteContent />
    </Suspense>
  );
}
