'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import api from '@/lib/api';
import { Card } from '@/components/ui/card';
import { Package, Truck, CheckCircle, Clock, Filter, Eye, Plus, FileText } from 'lucide-react';

const STAGES = [
  { key: '', label: '全部' },
  { key: 'won', label: '已成交' },
  { key: 'sampling', label: '打样' },
  { key: 'production', label: '生产' },
  { key: 'qc', label: '质检' },
  { key: 'shipping', label: '出货' },
  { key: 'payment', label: '收款' },
  { key: 'completed', label: '完成' },
];

const STAGE_ICONS: Record<string, React.ReactNode> = {
  won: <CheckCircle className="w-3 h-3" />, sampling: <Package className="w-3 h-3" />,
  production: <Clock className="w-3 h-3" />, qc: <Filter className="w-3 h-3" />,
  shipping: <Truck className="w-3 h-3" />, payment: <CheckCircle className="w-3 h-3" />,
  completed: <CheckCircle className="w-3 h-3" />,
};

export default function OrdersPage() {
  const [orders, setOrders] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stage, setStage] = useState('');

  useEffect(() => {
    api.get('/orders', { params: { limit: 100, stage: stage || undefined } }).then((res) => {
      setOrders(res.data?.data || []);
    }).catch(() => setError('加载失败')).finally(() => setLoading(false));
  }, [stage]);

  const parseFields = (o: any) => { try { return JSON.parse(o.outputContent || '{}'); } catch { return {}; } };

  const active = orders.filter((o: any) => {
    const s = parseFields(o).stage;
    return s && !['completed'].includes(s);
  }).length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">订单中心</h1>
          <p className="text-sm text-gray-500 mt-0.5">成交客户跟单 · 打样/生产/质检/出货/收款/售后</p>
        </div>
        <div className="flex gap-2">
          <Link href="/quotes" className="px-3 py-1.5 text-sm border rounded-md hover:bg-gray-50 flex items-center gap-1.5">
            <FileText className="w-3.5 h-3.5" /> 报价中心
          </Link>
        </div>
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: '全部订单', value: orders.length },
          { label: '进行中', value: active },
          { label: '已完成', value: orders.filter((o: any) => parseFields(o).stage === 'completed').length },
          { label: '待收款', value: orders.filter((o: any) => parseFields(o).stage === 'payment').length },
        ].map((m) => (
          <Card key={m.label} className="p-3">
            <p className="text-[10px] text-gray-500">{m.label}</p>
            <p className="text-xl font-bold mt-0.5">{m.value}</p>
          </Card>
        ))}
      </div>

      {/* Stage filter */}
      <div className="flex items-center gap-1.5 flex-wrap">
        <Filter className="w-3.5 h-3.5 text-gray-400" />
        {STAGES.map((s) => (
          <button key={s.key} onClick={() => setStage(s.key)}
            className={`text-[11px] px-2.5 py-1 rounded-md border transition-colors flex items-center gap-1 ${stage === s.key ? 'bg-blue-50 border-blue-200 text-blue-700' : 'border-gray-200 text-gray-500 hover:bg-gray-50'}`}>
            {STAGE_ICONS[s.key]}{s.label}
          </button>
        ))}
      </div>

      {/* Order list */}
      <Card className="overflow-hidden">
        {loading ? (
          <div className="flex justify-center py-16"><div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" /></div>
        ) : error ? (
          <div className="p-8 text-center text-sm text-red-600">{error}</div>
        ) : orders.length === 0 ? (
          <div className="p-12 text-center">
            <Package className="w-10 h-10 mx-auto text-gray-300 mb-3" />
            <p className="text-sm font-medium text-gray-700">暂无订单</p>
            <p className="text-xs text-gray-500 mt-1">确认报价后可创建订单，跟踪生产与交付进度。</p>
          </div>
        ) : (
          <div className="divide-y">
            {orders.map((o: any) => {
              const fields = parseFields(o);
              const stageLabel = STAGES.find(s => s.key === fields.stage)?.label || fields.stage || '—';
              return (
                <Link key={o.id} href={`/orders/${o.id}`}
                  className="flex items-center justify-between px-5 py-3.5 hover:bg-gray-50 transition-colors">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="text-sm font-medium">{fields.referenceNo || '订单'}</p>
                      <span className={`text-[9px] px-1.5 py-0.5 rounded-full flex items-center gap-0.5 ${fields.stage === 'completed' ? 'bg-green-50 text-green-600' : fields.stage === 'shipping' ? 'bg-blue-50 text-blue-600' : 'bg-amber-50 text-amber-600'}`}>
                        {STAGE_ICONS[fields.stage]}{stageLabel}
                      </span>
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {fields.lead?.companyName || '未关联客户'}
                      {fields.quote?.totalAmount ? ` · $${Number(fields.quote.totalAmount).toLocaleString()}` : ''}
                    </p>
                  </div>
                  <div className="flex items-center gap-3 shrink-0 ml-4">
                    <span className="text-[10px] text-gray-400">{new Date(o.createdAt).toLocaleDateString('zh-CN')}</span>
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
