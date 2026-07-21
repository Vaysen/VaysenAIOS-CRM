'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Users, Clock, TrendingUp, Globe, Star, Tag, Sparkles, ChevronRight, Filter } from 'lucide-react';

export interface SegmentGroup {
  key: string;
  label: string;
  count: number;
  icon?: React.ReactNode;
  highlight?: boolean;
}

interface Props {
  segments: SegmentGroup[];
  activeSegment: string;
  onSegmentChange: (key: string) => void;
  stageCounts?: Record<string, number>;
  totalLeads: number;
}

const STAGE_SEGMENTS: SegmentGroup[] = [
  { key: 'all', label: '全部客户', count: 0, icon: <Users className="w-3.5 h-3.5" /> },
  { key: 'new', label: '新客户', count: 0, icon: <Star className="w-3.5 h-3.5" /> },
  { key: 'contacted', label: '已联系', count: 0, icon: <Clock className="w-3.5 h-3.5" /> },
  { key: 'sampling', label: '样品中', count: 0, icon: <Tag className="w-3.5 h-3.5" /> },
  { key: 'quoting', label: '报价中', count: 0, icon: <TrendingUp className="w-3.5 h-3.5" /> },
  { key: 'negotiating', label: '谈判中', count: 0, icon: <ChevronRight className="w-3.5 h-3.5" /> },
  { key: 'won', label: '已成交', count: 0, icon: <Star className="w-3.5 h-3.5 text-amber-500" /> },
];

export function SegmentSidebar({ segments, activeSegment, onSegmentChange, stageCounts = {}, totalLeads }: Props) {
  const [section, setSection] = useState<'dynamic' | 'stage'>('stage');

  const stageItems = STAGE_SEGMENTS.map(s => ({
    ...s,
    count: s.key === 'all' ? totalLeads : (stageCounts[s.key] || 0),
  }));

  return (
    <aside className="w-52 border-r bg-white shrink-0 overflow-y-auto flex flex-col">
      {/* Section tabs */}
      <div className="flex border-b">
        <button
          onClick={() => setSection('stage')}
          className={cn(
            'flex-1 py-2 text-[11px] font-medium text-center border-b-2 transition-colors',
            section === 'stage' ? 'border-blue-500 text-blue-700' : 'border-transparent text-gray-400 hover:text-gray-600'
          )}
        >
          客户阶段
        </button>
        <button
          onClick={() => setSection('dynamic')}
          className={cn(
            'flex-1 py-2 text-[11px] font-medium text-center border-b-2 transition-colors',
            section === 'dynamic' ? 'border-blue-500 text-blue-700' : 'border-transparent text-gray-400 hover:text-gray-600'
          )}
        >
          动态客群
        </button>
      </div>

      <div className="flex-1 overflow-y-auto py-1">
        {section === 'stage' ? (
          <div className="space-y-0.5 px-2">
            {stageItems.map(item => (
              <button
                key={item.key}
                onClick={() => onSegmentChange(item.key)}
                className={cn(
                  'w-full flex items-center justify-between px-2 py-1.5 rounded text-left text-[12px] transition-colors',
                  activeSegment === item.key
                    ? 'bg-blue-50 text-blue-700 font-medium'
                    : 'text-gray-600 hover:bg-gray-50'
                )}
              >
                <span className="flex items-center gap-2 truncate">
                  <span className={cn('shrink-0', activeSegment === item.key ? 'text-blue-500' : 'text-gray-400')}>
                    {item.icon}
                  </span>
                  {item.label}
                </span>
                {item.count > 0 && (
                  <span className={cn(
                    'text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0',
                    activeSegment === item.key
                      ? 'bg-blue-100 text-blue-700'
                      : 'bg-gray-100 text-gray-500'
                  )}>
                    {item.count}
                  </span>
                )}
              </button>
            ))}
          </div>
        ) : (
          <div className="space-y-0.5 px-2">
            {segments.map(seg => (
              <button
                key={seg.key}
                onClick={() => onSegmentChange(seg.key)}
                className={cn(
                  'w-full flex items-center justify-between px-2 py-1.5 rounded text-left text-[12px] transition-colors',
                  activeSegment === seg.key
                    ? 'bg-blue-50 text-blue-700 font-medium'
                    : 'text-gray-600 hover:bg-gray-50'
                )}
              >
                <span className="flex items-center gap-2 truncate">
                  {seg.icon && <span className="shrink-0">{seg.icon}</span>}
                  {seg.label}
                </span>
                {seg.count > 0 && (
                  <span className={cn(
                    'text-[10px] px-1.5 py-0.5 rounded-full font-medium shrink-0',
                    seg.highlight
                      ? 'bg-red-100 text-red-600'
                      : activeSegment === seg.key
                        ? 'bg-blue-100 text-blue-700'
                        : 'bg-gray-100 text-gray-500'
                  )}>
                    {seg.count}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* AI Custom Segment */}
      <div className="p-2 border-t">
        <button className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded border border-green-200 bg-green-50 text-[11px] text-green-700 hover:bg-green-100 transition-colors">
          <Sparkles className="w-3 h-3" />
          AI 自定义客群
          <ChevronRight className="w-3 h-3 ml-auto" />
        </button>
      </div>
    </aside>
  );
}
