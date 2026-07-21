'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCorners,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import toast from 'react-hot-toast';
import api from '@/lib/api';
import { ArrowRight, DollarSign, FileText, GripVertical, Plus, Search } from 'lucide-react';

const stages = [
  { key: 'new', label: '新商机', hint: '有回复或已确认需求' },
  { key: 'contacted', label: '需求沟通', hint: '确认产品、数量、目标价' },
  { key: 'interested', label: '方案中', hint: '选品、图片、包装、交期' },
  { key: 'quoted', label: '已报价', hint: '已发正式报价单' },
  { key: 'negotiation', label: '谈判中', hint: '价格、样品、付款条款' },
  { key: 'won', label: '成交', hint: '转订单或复购维护' },
];

export default function OpportunitiesPage() {
  const [leads, setLeads] = useState<any[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [activeLead, setActiveLead] = useState<any | null>(null);
  const [previewLead, setPreviewLead] = useState<any | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  useEffect(() => {
    fetchLeads();
  }, []);

  const fetchLeads = async () => {
    setLoading(true);
    try {
      const res = await api.get('/leads', { params: { page: 1, limit: 800 } });
      setLeads(res.data.data || []);
    } finally {
      setLoading(false);
    }
  };

  const filtered = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return leads
      .filter((lead) => lead.status !== 'prospect_pool')
      .filter((lead) => !keyword || `${lead.companyName} ${lead.contactName} ${lead.country} ${lead.mainProducts}`.toLowerCase().includes(keyword));
  }, [leads, search]);

  const grouped = useMemo(() => {
    const map: Record<string, any[]> = {};
    for (const stage of stages) map[stage.key] = [];
    for (const lead of filtered) {
      const key = stages.some((stage) => stage.key === lead.status) ? lead.status : 'new';
      map[key].push(lead);
    }
    return map;
  }, [filtered]);

  const handleDragEnd = async (event: any) => {
    const { active, over } = event;
    setActiveLead(null);
    if (!over) return;
    const leadId = active.id as string;
    const nextStatus = over.id as string;
    const lead = leads.find((item) => item.id === leadId);
    if (!lead || lead.status === nextStatus) return;

    const previousStatus = lead.status;
    setLeads((prev) => prev.map((item) => item.id === leadId ? { ...item, status: nextStatus } : item));
    try {
      await api.patch(`/leads/${leadId}/status`, { status: nextStatus });
      toast.success(`已移动到 ${stages.find((stage) => stage.key === nextStatus)?.label || nextStatus}`);
    } catch (error: any) {
      setLeads((prev) => prev.map((item) => item.id === leadId ? { ...item, status: previousStatus } : item));
      toast.error(error.response?.data?.message || '商机阶段更新失败');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">商机管理</h2>
          <p className="text-sm text-gray-500">拖动卡片即可推进阶段。客户是公司档案，商机用于管理单次项目、报价和推进线。</p>
        </div>
        <div className="flex gap-2">
          <Link href="/leads/new" className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300">
            <Plus className="h-4 w-4" />
            新建客户
          </Link>
          <Link href="/emails/send" className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700">
            <FileText className="h-4 w-4" />
            发方案/报价邮件
          </Link>
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
        <div className="relative max-w-md">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索客户、联系人、国家、产品..."
            className="w-full rounded-lg border border-gray-300 bg-white py-2 pl-10 pr-3 text-sm outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-800"
          />
        </div>
      </div>

      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={(event) => setActiveLead(leads.find((lead) => lead.id === event.active.id) || null)}
        onDragEnd={handleDragEnd}
      >
        <div className="overflow-x-auto pb-2">
          <div className="grid min-w-[1240px] grid-cols-6 gap-3">
            {stages.map((stage) => (
              <OpportunityColumn key={stage.key} stage={stage} leads={grouped[stage.key] || []} loading={loading} onPreview={setPreviewLead} />
            ))}
          </div>
        </div>
        <DragOverlay dropAnimation={null}>
          {activeLead ? <OpportunityCard lead={activeLead} overlay /> : null}
        </DragOverlay>
      </DndContext>

      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
        后续正式版建议新增商机表：一个客户可有多个商机，每个商机单独管理报价、样品、付款条款、产品清单、推进阶段和成交复盘。
      </div>

      {previewLead && <LeadPreviewModal lead={previewLead} onClose={() => setPreviewLead(null)} />}
    </div>
  );
}

function OpportunityColumn({ stage, leads, loading, onPreview }: { stage: any; leads: any[]; loading: boolean; onPreview: (lead: any) => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.key });
  return (
    <section
      ref={setNodeRef}
      className={`flex min-h-[520px] flex-col rounded-xl border border-gray-200 bg-gray-50 p-3 transition-colors dark:border-gray-800 dark:bg-gray-900/40 ${
        isOver ? 'border-blue-400 bg-blue-50 dark:border-blue-600 dark:bg-blue-900/20' : ''
      }`}
    >
      <div className="mb-3">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-gray-900 dark:text-white">{stage.label}</h3>
          <span className="rounded-full bg-white px-2 py-0.5 text-xs text-gray-500 dark:bg-gray-800">{leads.length}</span>
        </div>
        <p className="mt-1 text-xs text-gray-500">{stage.hint}</p>
      </div>
      <div className="flex-1 space-y-2">
        {loading ? (
          <div className="rounded-lg bg-white p-3 text-sm text-gray-400 dark:bg-gray-950">加载中...</div>
        ) : leads.length ? leads.map((lead) => (
          <OpportunityCard key={lead.id} lead={lead} onPreview={onPreview} />
        )) : (
          <div className="flex min-h-28 items-center justify-center rounded-lg border border-dashed border-gray-300 p-4 text-center text-xs text-gray-400 dark:border-gray-700">
            拖动客户到这里
          </div>
        )}
      </div>
    </section>
  );
}

function OpportunityCard({ lead, overlay = false, onPreview }: { lead: any; overlay?: boolean; onPreview?: (lead: any) => void }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: lead.id,
    data: lead,
  });
  const style = transform ? { transform: `translate(${transform.x}px, ${transform.y}px)`, zIndex: isDragging ? 50 : undefined } : undefined;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`rounded-lg border border-gray-200 bg-white p-3 text-sm shadow-sm transition hover:border-blue-300 dark:border-gray-800 dark:bg-gray-950 ${
        isDragging ? 'opacity-50' : ''
      } ${overlay ? 'rotate-2 shadow-xl' : ''}`}
    >
      <div className="flex items-start gap-2">
        <button {...listeners} {...attributes} className="mt-0.5 cursor-grab rounded p-1 text-gray-300 hover:bg-gray-100 hover:text-gray-500 active:cursor-grabbing dark:hover:bg-gray-800">
          <GripVertical className="h-4 w-4" />
        </button>
        <div className="min-w-0 flex-1">
          <button
            type="button"
            onClick={() => onPreview?.(lead)}
            className="line-clamp-1 text-left font-medium text-blue-600 hover:underline"
          >
            {lead.companyName}
          </button>
          <div className="mt-1 text-xs text-gray-500">{lead.contactName || lead.contactEmail || '未填写联系人'}</div>
          <div className="mt-2 flex items-center justify-between text-xs text-gray-400">
            <span>{lead.country || '-'}</span>
            <span className="flex items-center gap-1"><DollarSign className="h-3 w-3" />{lead.estimatedOrderVolume || '待评估'}</span>
          </div>
          <button
            type="button"
            onClick={() => onPreview?.(lead)}
            className="mt-2 flex items-center gap-1 text-xs text-blue-600 hover:underline"
          >
            查看客户与跟进 <ArrowRight className="h-3 w-3" />
          </button>
        </div>
      </div>
    </div>
  );
}

function LeadPreviewModal({ lead, onClose }: { lead: any; onClose: () => void }) {
  const [detail, setDetail] = useState<any>(lead);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get(`/leads/${lead.id}`)
      .then((res) => setDetail(res.data))
      .catch(() => setDetail(lead))
      .finally(() => setLoading(false));
  }, [lead]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="max-h-[86vh] w-full max-w-3xl overflow-hidden rounded-xl bg-white shadow-xl dark:bg-gray-950">
        <div className="flex items-start justify-between border-b border-gray-200 p-5 dark:border-gray-800">
          <div>
            <h3 className="text-xl font-semibold text-gray-900 dark:text-white">{detail.companyName}</h3>
            <p className="mt-1 text-sm text-gray-500">{detail.country || '-'} · {detail.industry || detail.productCategory || '未填写行业'}</p>
          </div>
          <button onClick={onClose} className="rounded-lg px-2 py-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-gray-800">×</button>
        </div>
        <div className="max-h-[62vh] overflow-y-auto p-5">
          {loading ? (
            <div className="py-10 text-center text-gray-400">加载客户资料...</div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              <Info label="联系人" value={detail.contactName || '-'} />
              <Info label="职位" value={detail.contactTitle || '-'} />
              <Info label="邮箱" value={detail.contactEmail || '-'} />
              <Info label="电话" value={detail.contactPhone || '-'} />
              <Info label="网站" value={detail.website || '-'} />
              <Info label="评分" value={`${detail.leadGrade || '-'} ${detail.leadScore ?? ''}`} />
              <Info label="当前阶段" value={stages.find((s) => s.key === detail.status)?.label || detail.status || '-'} />
              <Info label="预计订单" value={detail.estimatedOrderVolume || '-'} />
              <div className="md:col-span-2">
                <div className="text-xs font-medium text-gray-500">主营产品/需求</div>
                <div className="mt-1 rounded-lg bg-gray-50 p-3 text-sm text-gray-700 dark:bg-gray-900 dark:text-gray-300">{detail.mainProducts || detail.notes || '暂无记录'}</div>
              </div>
            </div>
          )}
        </div>
        <div className="flex justify-end gap-2 border-t border-gray-200 p-4 dark:border-gray-800">
          <button onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300">关闭</button>
          <Link href={`/leads/${lead.id}`} className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700">进入完整资料</Link>
        </div>
      </div>
    </div>
  );
}

function Info({ label, value }: { label: string; value: any }) {
  return (
    <div className="rounded-lg border border-gray-200 p-3 dark:border-gray-800">
      <div className="text-xs font-medium text-gray-500">{label}</div>
      <div className="mt-1 break-words text-sm text-gray-900 dark:text-white">{value}</div>
    </div>
  );
}
