'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
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
import Link from 'next/link';
import api from '@/lib/api';
import toast from 'react-hot-toast';
import { Calendar, Mail, MapPin, MousePointer, Pencil, Plus, Reply, Trash2 } from 'lucide-react';
import {
  ACTIVE_STAGES,
  CLOSED_STAGES,
  COLUMN_BORDER_COLORS,
  FOLLOW_UP_COLORS,
  GRADE_COLORS,
  STATUS_COLORS,
} from '@/lib/lead-constants';

const STORAGE_KEY = 'vaysen-crm_board_stages';
const DEFAULT_STAGE_LABELS: Record<string, string> = {
  new: '新客户',
  contacted: '已联系',
  replied: '有回复',
  interested: '有意向',
  quoted: '已报价',
  won: '已成交',
  lost: '已流失',
};

interface EmailStats {
  sent: number;
  opened: number;
  clicked: number;
  replied: number;
  bounced: number;
}

interface LeadData {
  id: string;
  companyName: string;
  contactName?: string;
  contactEmail?: string;
  country?: string;
  status: string;
  leadGrade?: string;
  leadScore?: number;
  owner?: { id: string; firstName: string; lastName: string; email: string };
  nextFollowUpAt?: string;
  emailStats?: EmailStats;
  followUpStatus?: string;
}

interface Stage {
  value: string;
  label: string;
  closed?: boolean;
}

function defaultStages(): Stage[] {
  return [
    ...ACTIVE_STAGES.map((value) => ({ value, label: DEFAULT_STAGE_LABELS[value] || value, closed: false })),
    ...CLOSED_STAGES.map((value) => ({ value, label: DEFAULT_STAGE_LABELS[value] || value, closed: true })),
  ];
}

function EmailEngagement({ stats }: { stats?: EmailStats }) {
  if (!stats || stats.sent === 0) return null;

  return (
    <div className="mt-1 flex items-center gap-2 text-[10px] text-gray-400 dark:text-gray-500">
      {stats.opened > 0 && (
        <span className="inline-flex items-center gap-0.5" title="已打开">
          <Mail className="h-2.5 w-2.5" />
          {stats.opened}
        </span>
      )}
      {stats.clicked > 0 && (
        <span className="inline-flex items-center gap-0.5 text-blue-500" title="已点击">
          <MousePointer className="h-2.5 w-2.5" />
          {stats.clicked}
        </span>
      )}
      {stats.replied > 0 && (
        <span className="inline-flex items-center gap-0.5 text-green-500" title="已回复">
          <Reply className="h-2.5 w-2.5" />
          {stats.replied}
        </span>
      )}
    </div>
  );
}

function FollowUpBadge({ status }: { status?: string; nextFollowUpAt?: string }) {
  if (!status || status === 'normal') return null;

  const labels: Record<string, string> = {
    due_today: '今日跟进',
    overdue: '已逾期',
    long_time_no_contact: '久未联系',
  };

  return (
    <div className="mt-1">
      <span className={`inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-medium ${FOLLOW_UP_COLORS[status] || ''}`}>
        <Calendar className="h-2.5 w-2.5" />
        {labels[status] || status}
      </span>
    </div>
  );
}

function KanbanCard({ lead, isOverlay = false }: { lead: LeadData; isOverlay?: boolean }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: lead.id,
    data: lead,
  });

  const style = transform
    ? { transform: `translate(${transform.x}px, ${transform.y}px)`, zIndex: isDragging ? 50 : undefined }
    : undefined;

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      style={style}
      className={`group rounded-lg border border-gray-200 bg-white p-2.5 transition-all hover:border-blue-300 hover:shadow-md active:cursor-grabbing dark:border-gray-700 dark:bg-gray-900 ${
        isDragging ? 'opacity-50 shadow-lg' : ''
      } ${isOverlay ? 'rotate-2 shadow-xl' : ''}`}
    >
      <Link
        href={`/leads/${lead.id}`}
        className="line-clamp-1 text-sm font-medium text-blue-600 hover:underline dark:text-blue-400"
        onClick={(e) => isDragging && e.preventDefault()}
      >
        {lead.companyName}
      </Link>

      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        {lead.country && (
          <span className="inline-flex items-center gap-0.5 text-[11px] text-gray-500 dark:text-gray-400">
            <MapPin className="h-3 w-3" />
            {lead.country}
          </span>
        )}
        {lead.leadGrade && (
          <span className={`inline-flex rounded px-1 py-0.5 text-[10px] font-medium ${GRADE_COLORS[lead.leadGrade] || ''}`}>
            {lead.leadGrade}
          </span>
        )}
        {lead.leadScore != null && (
          <span className="text-[11px] font-semibold text-gray-700 dark:text-gray-300">{lead.leadScore}</span>
        )}
      </div>

      {lead.contactName && <p className="mt-0.5 line-clamp-1 text-[11px] text-gray-500 dark:text-gray-400">{lead.contactName}</p>}
      <EmailEngagement stats={lead.emailStats} />
      <FollowUpBadge status={lead.followUpStatus} nextFollowUpAt={lead.nextFollowUpAt} />

      {lead.owner && (
        <div className="mt-1.5 flex items-center gap-1 border-t border-gray-100 pt-1.5 dark:border-gray-800">
          <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-blue-100 text-[9px] font-medium text-blue-600 dark:bg-blue-900/30 dark:text-blue-400">
            {lead.owner.firstName?.[0]}
            {lead.owner.lastName?.[0]}
          </span>
          <span className="truncate text-[11px] text-gray-400 dark:text-gray-500">{lead.owner.firstName}</span>
        </div>
      )}
    </div>
  );
}

function KanbanColumn({ status, label, leads }: { status: string; label: string; leads: LeadData[] }) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  const colorClass = STATUS_COLORS[status] || 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300';
  const borderClass = COLUMN_BORDER_COLORS[status] || 'border-t-gray-300';

  return (
    <div
      ref={setNodeRef}
      className={`flex w-[210px] flex-shrink-0 flex-col rounded-xl border border-t-2 border-gray-200 bg-gray-50 ${borderClass} transition-colors dark:border-gray-800 dark:bg-gray-950/50 ${
        isOver ? 'border-blue-300 bg-blue-50 dark:border-blue-700 dark:bg-blue-900/10' : ''
      }`}
    >
      <div className="flex items-center justify-between px-2.5 py-2">
        <span className={`inline-flex rounded px-1.5 py-0.5 text-xs font-medium ${colorClass}`}>{label}</span>
        <span className="text-xs font-medium text-gray-400 dark:text-gray-500">{leads.length}</span>
      </div>
      <div className="min-h-[80px] flex-1 space-y-1.5 px-1.5 pb-1.5">
        {leads.length === 0 ? (
          <div className="flex h-16 items-center justify-center text-xs text-gray-300 dark:text-gray-600">暂无客户</div>
        ) : (
          leads.map((lead) => <KanbanCard key={lead.id} lead={lead} />)
        )}
      </div>
    </div>
  );
}

export default function KanbanBoard({
  search,
  countryFilter,
  gradeFilter,
  ownerUserId,
  reviewStatus,
  sortBy,
  showClosed,
}: {
  search: string;
  countryFilter: string;
  gradeFilter: string;
  ownerUserId?: string;
  reviewStatus: string;
  sortBy: string;
  showClosed: boolean;
}) {
  const [leads, setLeads] = useState<LeadData[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeLead, setActiveLead] = useState<LeadData | null>(null);
  const [boardStages, setBoardStages] = useState<Stage[]>([]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      setBoardStages(saved ? JSON.parse(saved) : defaultStages());
    } catch {
      setBoardStages(defaultStages());
    }
  }, []);

  const persistStages = (next: Stage[]) => {
    setBoardStages(next);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  };

  const visibleStages = useMemo(() => {
    const active = boardStages.filter((s) => !s.closed);
    const closed = boardStages.filter((s) => s.closed);
    return showClosed ? [...active, ...closed] : active;
  }, [boardStages, showClosed]);

  const fetchLeads = useCallback(async () => {
    if (visibleStages.length === 0) return;
    try {
      setLoading(true);
      const params: any = { limit: 500, status: visibleStages.map((s) => s.value).join(',') };
      if (search) params.search = search;
      if (countryFilter) params.country = countryFilter;
      if (gradeFilter) params.leadGrade = gradeFilter;
      if (ownerUserId) params.ownerUserId = ownerUserId;
      if (reviewStatus) params.reviewStatus = reviewStatus;
      if (sortBy) params.sortBy = sortBy;

      const res = await api.get('/leads', { params });
      setLeads(res.data.data || []);
    } catch {
      toast.error('客户看板加载失败');
    } finally {
      setLoading(false);
    }
  }, [countryFilter, gradeFilter, ownerUserId, reviewStatus, search, sortBy, visibleStages]);

  useEffect(() => {
    fetchLeads();
  }, [fetchLeads]);

  const addStage = () => {
    const label = window.prompt('请输入新看板名称，例如：寄样中、等待付款');
    if (!label?.trim()) return;
    const value = `custom_${label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_')}_${Date.now().toString(36)}`;
    persistStages([...boardStages.filter((s) => !s.closed), { value, label: label.trim(), closed: false }, ...boardStages.filter((s) => s.closed)]);
  };

  const renameStage = () => {
    const current = window.prompt('请输入要重命名的看板名称');
    if (!current) return;
    const target = boardStages.find((s) => s.value === current || s.label === current);
    if (!target) return window.alert('未找到该看板');
    const label = window.prompt('新的看板名称', target.label);
    if (!label?.trim()) return;
    persistStages(boardStages.map((s) => (s.value === target.value ? { ...s, label: label.trim() } : s)));
  };

  const removeStage = () => {
    const current = window.prompt('请输入要删除的看板名称。请先把该列客户移动到其他看板。');
    if (!current) return;
    const target = boardStages.find((s) => s.value === current || s.label === current);
    if (!target) return window.alert('未找到该看板');
    if (!window.confirm(`确认删除看板「${target.label}」？`)) return;
    persistStages(boardStages.filter((s) => s.value !== target.value));
  };

  const handleDragEnd = async (event: any) => {
    const { active, over } = event;
    setActiveLead(null);
    if (!over) return;

    const leadId = active.id as string;
    const newStatus = over.id as string;
    const lead = leads.find((l) => l.id === leadId);
    if (!lead || lead.status === newStatus) return;

    const oldStatus = lead.status;
    setLeads((prev) => prev.map((l) => (l.id === leadId ? { ...l, status: newStatus } : l)));

    try {
      await api.patch(`/leads/${leadId}/status`, { status: newStatus });
      const stageLabel = boardStages.find((s) => s.value === newStatus)?.label || newStatus;
      toast.success(`已移动到 ${stageLabel}`);
    } catch {
      setLeads((prev) => prev.map((l) => (l.id === leadId ? { ...l, status: oldStatus } : l)));
      toast.error('更新看板失败');
    }
  };

  const activeColumns = boardStages
    .filter((s) => !s.closed)
    .map((s) => ({ ...s, leads: leads.filter((l) => l.status === s.value) }));
  const closedColumns = boardStages
    .filter((s) => s.closed)
    .map((s) => ({ ...s, leads: leads.filter((l) => l.status === s.value) }));

  if (loading) {
    return (
      <div className="flex gap-3 overflow-x-auto">
        {ACTIVE_STAGES.map((s) => (
          <div key={s} className="h-[30vh] w-[210px] flex-shrink-0 animate-pulse rounded-xl border border-gray-200 bg-gray-50 dark:border-gray-800 dark:bg-gray-950/50" />
        ))}
      </div>
    );
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={(event) => setActiveLead(leads.find((l) => l.id === event.active.id) || null)}
      onDragEnd={handleDragEnd}
    >
      <div className="space-y-6">
        <div>
          <div className="mb-2 ml-1 flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-gray-600 dark:text-gray-400">客户跟进看板</h3>
            <div className="flex gap-1">
              <button onClick={addStage} className="rounded border px-2 py-1 text-xs hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800">
                <Plus className="inline h-3 w-3" /> 新增
              </button>
              <button onClick={renameStage} className="rounded border px-2 py-1 text-xs hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800">
                <Pencil className="inline h-3 w-3" /> 重命名
              </button>
              <button onClick={removeStage} className="rounded border px-2 py-1 text-xs text-red-600 hover:bg-red-50 dark:border-gray-700 dark:hover:bg-red-900/20">
                <Trash2 className="inline h-3 w-3" /> 删除
              </button>
            </div>
          </div>
          <div className="flex min-h-[200px] gap-3 overflow-x-auto pb-2">
            {activeColumns.map((col) => (
              <KanbanColumn key={col.value} status={col.value} label={col.label} leads={col.leads} />
            ))}
          </div>
        </div>

        {showClosed && (
          <div>
            <h3 className="mb-2 ml-1 text-sm font-semibold text-gray-600 dark:text-gray-400">已结束客户</h3>
            <div className="flex min-h-[150px] gap-3 overflow-x-auto pb-2">
              {closedColumns.map((col) => (
                <KanbanColumn key={col.value} status={col.value} label={col.label} leads={col.leads} />
              ))}
            </div>
          </div>
        )}
      </div>

      <DragOverlay dropAnimation={null}>{activeLead ? <KanbanCard lead={activeLead} isOverlay /> : null}</DragOverlay>
    </DndContext>
  );
}
