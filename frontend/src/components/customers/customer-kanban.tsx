'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import Link from 'next/link';
import { DndContext, closestCorners, useSensor, useSensors, PointerSensor, useDraggable, useDroppable } from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { MapPin, GripVertical, Tag, AlertCircle, Pin } from 'lucide-react';
import api from '@/lib/api';
import { KanbanHoverCard } from './kanban-hover-card';

const STAGES: { key: string; label: string; color: string }[] = [
  { key: 'new', label: '新客户', color: 'bg-blue-50 border-blue-200' },
  { key: 'contacted', label: '已联系', color: 'bg-cyan-50 border-cyan-200' },
  { key: 'sampling', label: '样品中', color: 'bg-purple-50 border-purple-200' },
  { key: 'quoting', label: '报价中', color: 'bg-amber-50 border-amber-200' },
  { key: 'negotiating', label: '谈判中', color: 'bg-orange-50 border-orange-200' },
  { key: 'won', label: '已成交', color: 'bg-green-50 border-green-200' },
  { key: 'lost', label: '暂停/无效', color: 'bg-gray-50 border-gray-200' },
];

function KanbanCard({ lead }: { lead: any }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: lead.id, data: lead });
  const style = transform ? {
    transform: `translate(${transform.x}px, ${transform.y}px)`,
    zIndex: isDragging ? 50 : undefined,
    opacity: isDragging ? 0.8 : undefined,
  } : undefined;

  const [showHover, setShowHover] = useState(false);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleMouseEnter = useCallback(() => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => {
      setShowHover(true);
    }, 750); // 0.75s — half of original 1.5s
  }, []);

  const handleMouseLeave = useCallback(() => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    setShowHover(false);
  }, []);

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    };
  }, []);

  const tags = lead.tags || [];

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      style={{ ...style, position: 'relative', touchAction: 'none' }}
      className="bg-white border rounded-lg p-2.5 mb-2 cursor-grab active:cursor-grabbing hover:shadow-sm transition-shadow group"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div className="flex items-start gap-1">
        {/* Grip icon — visual indicator only, drag is activated on whole card */}
        <span className="text-gray-300 mt-0.5 shrink-0 pointer-events-none">
          <GripVertical className="w-3 h-3" />
        </span>
        <Link
          href={`/customers/${lead.id}`}
          className="flex-1 min-w-0"
          onClick={(e) => { if (showHover || isDragging) e.preventDefault(); }}
          draggable={false}
        >
          <p className="text-xs font-medium truncate">
            {lead.isPinned && <Pin className="w-2.5 h-2.5 inline text-amber-500 mr-0.5" fill="currentColor" />}
            {lead.companyName || lead.leadName || '未知'}
          </p>
          <div className="flex items-center gap-1.5 mt-0.5">
            {lead.country && <span className="text-[9px] text-gray-400 flex items-center gap-0.5"><MapPin className="w-2.5 h-2.5" />{lead.country}</span>}
            {lead.leadGrade && (
              <span className={`text-[8px] px-1 py-0.5 rounded-full font-bold ${
                lead.leadGrade === 'A' ? 'bg-green-100 text-green-700' : lead.leadGrade === 'B' ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-500'
              }`}>{lead.leadGrade}级</span>
            )}
          </div>
        </Link>
      </div>
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1.5 ml-5 pointer-events-none">
          {tags.slice(0, 3).map((t: any) => (
            <span key={t.id || t.tagId} className="text-[8px] px-1.5 py-0.5 rounded-full border text-gray-500" style={{ borderColor: t.tag?.color || '#ccc', backgroundColor: (t.tag?.color || '#eee') + '20' }}>
              {t.tag?.displayName || t.tag?.name || '标签'}
            </span>
          ))}
        </div>
      )}

      {showHover && (
        <KanbanHoverCard lead={lead} onClose={() => setShowHover(false)} />
      )}
    </div>
  );
}

function KanbanColumn({ stage, leads }: { stage: typeof STAGES[0]; leads: any[] }) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.key });
  return (
    <div ref={setNodeRef} className={`flex-1 min-w-[190px] rounded-lg border p-2 ${stage.color} ${isOver ? 'ring-2 ring-blue-400' : ''}`} style={{ overflow: 'visible' }}>
      <div className="flex items-center justify-between mb-2 px-1">
        <span className="text-[11px] font-semibold">{stage.label}</span>
        <span className="text-[10px] text-gray-400">{leads.length}</span>
      </div>
      <div className="space-y-1 min-h-[60px]">
        {leads.map((lead: any) => <KanbanCard key={lead.id} lead={lead} />)}
        {leads.length === 0 && <p className="text-[10px] text-gray-300 text-center py-4">拖拽至此</p>}
      </div>
    </div>
  );
}

interface Props {
  leads: any[];
  loading?: boolean;
  error?: string | null;
}

export function CustomerKanban({ leads, loading, error }: Props) {
  const [items, setItems] = useState(leads);

  useEffect(() => { setItems(leads); }, [leads]);

  // Long-press to drag: 300ms delay + 5px distance
  const sensors = useSensors(useSensor(PointerSensor, {
    activationConstraint: { delay: 300, distance: 5 },
  }));

  const handleDragEnd = async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const leadId = String(active.id);
    const newStage = String(over.id);
    const snapshot = [...items];
    setItems((prev) => prev.map((l: any) => l.id === leadId ? { ...l, status: newStage } : l));

    try {
      await api.patch(`/leads/${leadId}/status`, { status: newStage });
    } catch {
      setItems(snapshot);
    }
  };

  if (loading) {
    return <div className="flex justify-center py-16"><div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" /></div>;
  }

  if (error) {
    return (
      <div className="flex items-center justify-center py-16 text-sm text-red-500 gap-2">
        <AlertCircle className="w-4 h-4" />
        <span>{error}</span>
      </div>
    );
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={handleDragEnd}>
      <div className="flex gap-3 overflow-x-auto overflow-y-visible pb-4" style={{ minHeight: '60vh', overflowX: 'auto', overflowY: 'visible' }}>
        {STAGES.map((s) => (
          <KanbanColumn key={s.key} stage={s} leads={items.filter((l: any) => l.status === s.key).sort((a: any, b: any) => (b.isPinned ? 1 : 0) - (a.isPinned ? 1 : 0))} />
        ))}
      </div>
    </DndContext>
  );
}
