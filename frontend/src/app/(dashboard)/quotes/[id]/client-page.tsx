'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import api from '@/lib/api';
import { useRuntimeRouteParam } from '@/lib/use-runtime-route-param';
import { Card } from '@/components/ui/card';
import { ArrowLeft, FileText, DollarSign, Clock, User } from 'lucide-react';
import { sanitizeRichHtml } from '@/lib/sanitize-rich-html';
import { formatQuoteAmount, type QuoteDetail } from '@/types/quote';
import type { QuoteConvertOrderResponse } from '@/types/order';

export default function QuoteDetailPage() {
  const id = useRuntimeRouteParam('id');
  const [quote, setQuote] = useState<QuoteDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [piHtml, setPiHtml] = useState<string | null>(null);
  const [tab, setTab] = useState<'detail' | 'pi'>('detail');
  const [converting, setConverting] = useState(false);
  const [convertError, setConvertError] = useState<string | null>(null);
  const [convertedOrder, setConvertedOrder] = useState<QuoteConvertOrderResponse | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    api.get<QuoteDetail>(`/quotes/${id}`).then((res) => setQuote(res.data))
      .catch(() => setError('Failed to load quote. It may have been deleted or you lack access.'))
      .finally(() => setLoading(false));
  }, [id]);

  const viewPi = async () => {
    try {
      const res = await api.get(`/quotes/${id}/pi`);
      setPiHtml(res.data);
      setTab('pi');
    } catch (requestError) {
      console.error('[QuoteDetail] PI preview failed:', requestError);
    }
  };

  const convertToOrder = async () => {
    setConverting(true);
    setConvertError(null);
    try {
      const res = await api.post<QuoteConvertOrderResponse>(`/quotes/${id}/convert-to-order`);
      setConvertedOrder(res.data);
      setQuote((current) => current ? { ...current, status: 'accepted' } : current);
    } catch {
      setConvertError('转换订单失败，请稍后重试。');
    } finally {
      setConverting(false);
    }
  };

  if (loading) {
    return <div className="flex justify-center py-20"><div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" /></div>;
  }

  if (error || !quote) {
    return <div className="p-6"><Link href="/quotes" className="text-sm text-blue-600 underline mb-4 inline-block">← Back to Quotes</Link><p className="text-sm text-red-600">{error || 'Quote not found.'}</p></div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/quotes" className="text-gray-400 hover:text-gray-600"><ArrowLeft className="w-4 h-4" /></Link>
        <div>
          <h1 className="text-xl font-bold">{quote.referenceNo || 'Quote Draft'}</h1>
          <p className="text-sm text-gray-500">{quote.lead?.companyName || 'Unknown'} · {quote.status}</p>
        </div>
        <div className="ml-auto flex gap-2">
          <button onClick={viewPi} className="px-3 py-1.5 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700">
            <FileText className="w-3.5 h-3.5 inline mr-1" /> 预览 PI
          </button>
          <Link href={`/quotes/new?from=${id}&type=pi`} className="px-3 py-1.5 text-sm rounded-md border border-blue-200 text-blue-700 hover:bg-blue-50">PI 草稿</Link>
          <Link href={`/quotes/new?from=${id}&type=contract`} className="px-3 py-1.5 text-sm rounded-md border border-purple-200 text-purple-700 hover:bg-purple-50">合同草稿</Link>
          <Link href={`/quotes/new?from=${id}&type=sample`} className="px-3 py-1.5 text-sm rounded-md border border-green-200 text-green-700 hover:bg-green-50">样品单</Link>
          {quote.status === 'sent' && !convertedOrder && (
            <button onClick={convertToOrder} disabled={converting} className="px-3 py-1.5 text-sm rounded-md bg-green-600 text-white hover:bg-green-700 disabled:opacity-50">
              {converting ? '转换中…' : '转为订单'}
            </button>
          )}
          {convertedOrder && <Link href={`/orders/${convertedOrder.id}`} className="px-3 py-1.5 text-sm rounded-md border border-green-200 text-green-700 hover:bg-green-50">查看订单</Link>}
        </div>
      </div>

      {convertError && <p role="alert" className="text-sm text-red-600">{convertError}</p>}

      <div className="flex gap-2 border-b pb-2">
        {(['detail', 'pi'] as const).map((value) => (
          <button key={value} onClick={() => setTab(value)} className={`px-3 py-1 text-sm rounded ${tab === value ? 'bg-gray-100 font-medium' : 'text-gray-500'}`}>
            {value === 'detail' ? 'Details' : 'Proforma Invoice'}
          </button>
        ))}
      </div>

      {tab === 'detail' ? (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card className="p-4"><h3 className="text-sm font-semibold mb-2 flex gap-1.5"><User className="w-3.5 h-3.5" /> Customer</h3>
            <p className="text-sm">{quote.lead?.companyName || 'N/A'}</p>
            <p className="text-xs text-gray-500">{quote.lead?.contactName || '-'} · {quote.lead?.country || '-'}</p>
          </Card>
          <Card className="p-4"><h3 className="text-sm font-semibold mb-2 flex gap-1.5"><DollarSign className="w-3.5 h-3.5" /> Summary</h3>
            <p className="text-2xl font-bold">{formatQuoteAmount(quote.totalAmount, quote.currency)}</p>
            <p className="text-xs text-gray-500">{quote.itemCount} items</p>
            {quote.opportunity && <p className="mt-1 text-xs text-blue-600">商机：{quote.opportunity.name} · {quote.opportunity.stage}</p>}
          </Card>
          <Card className="p-4"><h3 className="text-sm font-semibold mb-2 flex gap-1.5"><Clock className="w-3.5 h-3.5" /> Terms</h3>
            <dl className="text-sm space-y-1">
              <div className="flex justify-between"><dt className="text-gray-500">Trade</dt><dd>{quote.tradeTerms || 'FOB'}</dd></div>
              <div className="flex justify-between"><dt className="text-gray-500">Payment</dt><dd>{quote.paymentTerms || 'T/T'}</dd></div>
              <div className="flex justify-between"><dt className="text-gray-500">Delivery</dt><dd>{quote.deliveryTime || 'TBD'}</dd></div>
            </dl>
          </Card>
          <Card className="p-4"><h3 className="text-sm font-semibold mb-2">Line Items</h3>
            <div className="space-y-2 text-sm">
              {quote.lineItems.map((item) => (
                <div key={item.id} className="flex justify-between border-b pb-1 last:border-0">
                  <span>{item.productName} × {item.quantity}</span>
                  <span className="font-medium">{formatQuoteAmount(item.totalPrice, quote.currency)}</span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      ) : (
        <div className="bg-white border rounded-lg overflow-hidden">
          {piHtml ? <iframe srcDoc={sanitizeRichHtml(piHtml)} sandbox="" className="w-full h-[800px]" title="PI Preview" /> : <div className="p-8 text-center text-sm text-gray-500">Click “Preview PI” to generate the proforma invoice.</div>}
        </div>
      )}
    </div>
  );
}
