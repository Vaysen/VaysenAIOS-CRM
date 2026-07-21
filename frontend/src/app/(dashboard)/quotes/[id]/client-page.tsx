'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import api from '@/lib/api';
import { useRuntimeRouteParam } from '@/lib/use-runtime-route-param';
import { Card } from '@/components/ui/card';
import { ArrowLeft, FileText, DollarSign, Clock, User } from 'lucide-react';
import { sanitizeRichHtml } from '@/lib/sanitize-rich-html';

export default function QuoteDetailPage() {
  const id = useRuntimeRouteParam('id');
  const [artifact, setArtifact] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [piHtml, setPiHtml] = useState<string | null>(null);
  const [tab, setTab] = useState<'detail' | 'pi'>('detail');

  useEffect(() => {
    setLoading(true);
    setError(null);
    api.get(`/quotes/${id}`).then((res) => setArtifact(res.data))
      .catch(() => setError('Failed to load quote. It may have been deleted or you lack access.'))
      .finally(() => setLoading(false));
  }, [id]);

  const viewPi = async () => {
    try {
      const res = await api.get(`/quotes/${id}/pi`);
      setPiHtml(res.data);
      setTab('pi');
    } catch (error) { console.error('[Frontend] operation failed:', error); }
  };

  if (loading) {
    return (
      <div className="flex justify-center py-20">
        <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error || !artifact) {
    return (
      <div className="p-6">
        <Link href="/quotes" className="text-sm text-blue-600 underline mb-4 inline-block">← Back to Quotes</Link>
        <p className="text-sm text-red-600">{error || 'Quote not found.'}</p>
      </div>
    );
  }

  const fields = artifact.outputContent ? (() => { try { return JSON.parse(artifact.outputContent); } catch { return {}; } })() : {};

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/quotes" className="text-gray-400 hover:text-gray-600"><ArrowLeft className="w-4 h-4" /></Link>
        <div>
          <h1 className="text-xl font-bold">{fields.referenceNo || 'Quote Draft'}</h1>
          <p className="text-sm text-gray-500">{fields.lead?.companyName || 'Unknown'} · {fields.status || 'draft'}</p>
        </div>
        <div className="ml-auto flex gap-2">
          <button onClick={viewPi} className="px-3 py-1.5 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700">
            <FileText className="w-3.5 h-3.5 inline mr-1" /> 预览 PI
          </button>
          <Link href={`/quotes/new?from=${id}&type=pi`} className="px-3 py-1.5 text-sm rounded-md border border-blue-200 text-blue-700 hover:bg-blue-50">
            PI 草稿
          </Link>
          <Link href={`/quotes/new?from=${id}&type=contract`} className="px-3 py-1.5 text-sm rounded-md border border-purple-200 text-purple-700 hover:bg-purple-50">
            合同草稿
          </Link>
          <Link href={`/quotes/new?from=${id}&type=sample`} className="px-3 py-1.5 text-sm rounded-md border border-green-200 text-green-700 hover:bg-green-50">
            样品单
          </Link>
        </div>
      </div>

      <div className="flex gap-2 border-b pb-2">
        {(['detail', 'pi'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`px-3 py-1 text-sm rounded ${tab === t ? 'bg-gray-100 font-medium' : 'text-gray-500'}`}>
            {t === 'detail' ? 'Details' : 'Proforma Invoice'}
          </button>
        ))}
      </div>

      {tab === 'detail' ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card className="p-4"><h3 className="text-sm font-semibold mb-2 flex gap-1.5"><User className="w-3.5 h-3.5" /> Customer</h3>
            <p className="text-sm">{fields.lead?.companyName || 'N/A'}</p>
            <p className="text-xs text-gray-500">{fields.lead?.contactName} · {fields.lead?.country}</p>
          </Card>
          <Card className="p-4"><h3 className="text-sm font-semibold mb-2 flex gap-1.5"><DollarSign className="w-3.5 h-3.5" /> Summary</h3>
            <p className="text-2xl font-bold">${fields.totalAmount?.toFixed(2) || '0.00'}</p>
            <p className="text-xs text-gray-500">{fields.lineItems?.length || 0} items</p>
          </Card>
          <Card className="p-4"><h3 className="text-sm font-semibold mb-2 flex gap-1.5"><Clock className="w-3.5 h-3.5" /> Terms</h3>
            <dl className="text-sm space-y-1">
              <div className="flex justify-between"><dt className="text-gray-500">Trade</dt><dd>{fields.tradeTerms || 'FOB'}</dd></div>
              <div className="flex justify-between"><dt className="text-gray-500">Payment</dt><dd>{fields.paymentTerms || 'T/T'}</dd></div>
              <div className="flex justify-between"><dt className="text-gray-500">Delivery</dt><dd>{fields.deliveryTime || 'TBD'}</dd></div>
            </dl>
          </Card>
          <Card className="p-4"><h3 className="text-sm font-semibold mb-2">Line Items</h3>
            <div className="space-y-2 text-sm">
              {(fields.lineItems || []).map((item: any, i: number) => (
                <div key={i} className="flex justify-between border-b pb-1 last:border-0">
                  <span>{item.productName} × {item.quantity}</span>
                  <span className="font-medium">${(item.totalPrice || item.quantity * item.unitPrice).toFixed(2)}</span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      ) : (
        <div className="bg-white border rounded-lg overflow-hidden">
          {piHtml ? (
            <iframe srcDoc={sanitizeRichHtml(piHtml)} sandbox="" className="w-full h-[800px]" title="PI Preview" />
          ) : (
            <div className="p-8 text-center text-sm text-gray-500">Click “View PI” to generate the proforma invoice.</div>
          )}
        </div>
      )}
    </div>
  );
}
