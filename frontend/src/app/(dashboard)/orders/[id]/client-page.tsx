'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import api from '@/lib/api';
import { useRuntimeRouteParam } from '@/lib/use-runtime-route-param';
import { Card } from '@/components/ui/card';
import { ArrowLeft } from 'lucide-react';
import { formatOrderAmount, type OrderDetail, type OrderHistoryResponse } from '@/types/order';

const STAGES = ['won','sampling','production','qc','shipping','payment','completed','after_sales'];
const STAGE_LABELS: Record<string,string> = {
  won:'已成交',sampling:'打样',production:'生产',qc:'质检',shipping:'出货',payment:'收款',completed:'完成',after_sales:'售后',
};

export default function OrderDetailPage() {
  const id = useRuntimeRouteParam('id');
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [history, setHistory] = useState<OrderHistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updating, setUpdating] = useState(false);

  useEffect(() => {
    let c = false;
    async function load() {
      try {
        const [orderRes] = await Promise.allSettled([api.get<OrderDetail>(`/orders/${id}`)]);
        if (c) return;
        if (orderRes.status === 'fulfilled') {
          const o = orderRes.value.data;
          setOrder(o);
          // Load customer history if lead linked
          if (o.leadId) {
            api.get<OrderHistoryResponse>(`/orders/lead/${o.leadId}/history`).then(r => setHistory(r.data)).catch((error) => { console.error('[Frontend] background operation failed:', error); });
          }
        } else { setError('加载失败'); }
      } catch (error) { console.error('[Frontend] operation failed:', error); } finally { if (!c) setLoading(false); }
    }
    load();
    return () => { c = true; };
  }, [id]);

  const changeStage = async (stage: string) => {
    setUpdating(true);
    try {
      const res = await api.patch<OrderDetail>(`/orders/${id}/stage`, { stage });
      setOrder(res.data);
    }
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
          {order.opportunity && <p className="mb-1 text-xs text-blue-600">商机：{order.opportunity.name} · {order.opportunity.stage}</p>}
          <h1 className="text-xl font-bold">{order.orderNo || '订单'}</h1>
          <p className="text-sm text-gray-500">{order.lead?.companyName || '未关联'} · {STAGE_LABELS[order.stage] || order.stage}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="p-4">
          <h3 className="text-sm font-semibold mb-2">客户信息</h3>
          <p className="text-sm font-medium">{order.lead?.companyName || '—'}</p>
          <p className="text-xs text-gray-500">{order.lead?.contactName || '-'} · {order.lead?.country || '-'}</p>
          {order.leadId && <Link href={`/customers/${order.leadId}`} className="text-xs text-blue-600 hover:underline mt-1 inline-block">查看客户 →</Link>}
        </Card>
        <Card className="p-4">
          <h3 className="text-sm font-semibold mb-2">订单金额</h3>
          <p className="text-2xl font-bold">{formatOrderAmount(order.totalAmount, order.currency)}</p>
          <p className="text-xs text-gray-500">{order.quote?.itemCount || 0} 项产品</p>
        </Card>
        <Card className="p-4">
          <h3 className="text-sm font-semibold mb-2">阶段</h3>
          <select value={order.stage || 'won'} onChange={(e) => changeStage(e.target.value)} disabled={updating} className="w-full border rounded px-2 py-1.5 text-sm">
            {STAGES.map(s => <option key={s} value={s}>{STAGE_LABELS[s]}</option>)}
          </select>
        </Card>
      </div>

      {history && (
        <Card className="p-4">
          <h3 className="text-sm font-semibold mb-3">客户订单历史</h3>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
            {[{ label:'订单总数', v:history.stats.totalOrders },
              { label:'累计金额', v:formatOrderAmount(history.stats.totalAmount, order.currency) }].map(m =>
              <div key={m.label} className="bg-gray-50 rounded p-2.5 text-center"><p className="text-[10px] text-gray-500">{m.label}</p><p className="text-sm font-bold">{m.v}</p></div>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
