'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import api from '@/lib/api';
import { useRuntimeRouteParam } from '@/lib/use-runtime-route-param';
import { Card } from '@/components/ui/card';
import { ArrowLeft, Package, Truck, CheckCircle, Clock, Filter, FileText } from 'lucide-react';

const STAGES = ['won','sampling','production','qc','shipping','payment','completed','after_sales'];
const STAGE_LABELS: Record<string,string> = {
  won:'已成交',sampling:'打样',production:'生产',qc:'质检',shipping:'出货',payment:'收款',completed:'完成',after_sales:'售后',
};

export default function OrderDetailPage() {
  const id = useRuntimeRouteParam('id');
  const [order, setOrder] = useState<any>(null);
  const [history, setHistory] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    let c = false;
    async function load() {
      try {
        const [orderRes] = await Promise.allSettled([api.get(`/orders/${id}`)]);
        if (c) return;
        if (orderRes.status === 'fulfilled') {
          const o = orderRes.value.data;
          setOrder(o);
          // Load customer history if lead linked
          if (o.leadId) {
            api.get(`/orders/lead/${o.leadId}/history`).then(r => setHistory(r.data)).catch((error) => { console.error('[Frontend] background operation failed:', error); });
          }
        } else { setError('加载失败'); }
      } catch (error) { console.error('[Frontend] operation failed:', error); } finally { if (!c) setLoading(false); }
    }
    load();
    return () => { c = true; };
  }, [id]);

  const fields = order?.outputContent ? (() => { try { return JSON.parse(order.outputContent); } catch { return {}; } })() : {};

  const changeStage = async (stage: string) => {
    setUpdating(true);
    try { await api.patch(`/orders/${id}/stage`, { stage }); setOrder({...order, outputContent: JSON.stringify({...fields, stage})}); }
    catch (error) { console.error('[Frontend] operation failed:', error); }
    finally { setUpdating(false); }
  };

  if (loading) return <div className="flex justify-center py-20"><div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" /></div>;
  if (error || !order) return <div className="p-6"><Link href="/orders" className="text-sm text-blue-600 underline">← 返回订单中心</Link><p className="text-sm text-red-600 mt-2">{error||'订单不存在'}</p></div>;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/orders" className="text-gray-400 hover:text-gray-600"><ArrowLeft className="w-4 h-4" /></Link>
        <div>
          <h1 className="text-xl font-bold">{fields.referenceNo || '订单'}</h1>
          <p className="text-sm text-gray-500">{fields.lead?.companyName || '未关联'} · {STAGE_LABELS[fields.stage] || fields.stage}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="p-4">
          <h3 className="text-sm font-semibold mb-2">客户信息</h3>
          <p className="text-sm font-medium">{fields.lead?.companyName || '—'}</p>
          <p className="text-xs text-gray-500">{fields.lead?.contactName} · {fields.lead?.country}</p>
          {order.leadId && <Link href={`/customers/${order.leadId}`} className="text-xs text-blue-600 hover:underline mt-1 inline-block">查看客户 →</Link>}
        </Card>
        <Card className="p-4">
          <h3 className="text-sm font-semibold mb-2">订单金额</h3>
          <p className="text-2xl font-bold">${fields.quote?.totalAmount?.toLocaleString() || '—'}</p>
          <p className="text-xs text-gray-500">{fields.quote?.lineItems?.length || 0} 项产品</p>
        </Card>
        <Card className="p-4">
          <h3 className="text-sm font-semibold mb-2">阶段</h3>
          <select value={fields.stage || 'won'} onChange={(e) => changeStage(e.target.value)} disabled={updating} className="w-full border rounded px-2 py-1.5 text-sm">
            {STAGES.map(s => <option key={s} value={s}>{STAGE_LABELS[s]}</option>)}
          </select>
        </Card>
      </div>

      {history && (
        <Card className="p-4">
          <h3 className="text-sm font-semibold mb-3">客户订单历史</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            {[{ label:'订单总数', v:history.stats?.totalOrders },
              { label:'累计金额', v:`$${(history.stats?.totalAmount||0).toLocaleString()}` }].map(m =>
              <div key={m.label} className="bg-gray-50 rounded p-2.5 text-center"><p className="text-[10px] text-gray-500">{m.label}</p><p className="text-sm font-bold">{m.v}</p></div>
            )}
          </div>
          {history.stats?.topProducts?.length > 0 && (
            <div>
              <p className="text-xs font-medium text-gray-600 mb-1">常购产品</p>
              <div className="flex flex-wrap gap-1">
                {history.stats.topProducts.map(([name, count]: [string, number]) => (
                  <span key={name} className="text-[10px] px-2 py-0.5 rounded-full bg-blue-50 text-blue-700">{name} ×{count}</span>
                ))}
              </div>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
