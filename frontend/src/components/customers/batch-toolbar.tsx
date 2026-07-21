'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Tags, UserPlus, Download, X, Check, Loader2 } from 'lucide-react';
import api from '@/lib/api';

interface BatchToolbarProps {
  selectedCount: number;
  selectedIds: string[];
  onClear: () => void;
  onAction: (action: string, data?: any) => Promise<void>;
}

export function BatchToolbar({ selectedCount, selectedIds, onClear, onAction }: BatchToolbarProps) {
  const [loading, setLoading] = useState<string | null>(null);

  if (selectedCount === 0) return null;

  const handleAction = async (action: string, data?: any) => {
    setLoading(action);
    try {
      await onAction(action, data);
    } finally {
      setLoading(null);
    }
  };

  return (
    <div className="flex items-center gap-3 px-4 py-2 bg-blue-50 border border-blue-200 rounded-lg animate-in slide-in-from-top-2">
      <span className="text-[12px] font-medium text-blue-700">
        已选 <span className="font-bold">{selectedCount}</span> 项
      </span>

      <div className="h-4 w-px bg-blue-200" />

      <button
        onClick={() => handleAction('tag')}
        disabled={!!loading}
        className="flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-blue-200 bg-white text-blue-700 hover:bg-blue-100 disabled:opacity-50 transition-colors"
      >
        {loading === 'tag' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Tags className="w-3 h-3" />}
        打标签
      </button>

      <button
        onClick={() => handleAction('assign')}
        disabled={!!loading}
        className="flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-blue-200 bg-white text-blue-700 hover:bg-blue-100 disabled:opacity-50 transition-colors"
      >
        {loading === 'assign' ? <Loader2 className="w-3 h-3 animate-spin" /> : <UserPlus className="w-3 h-3" />}
        分配归属人
      </button>

      <button
        onClick={() => handleAction('export')}
        disabled={!!loading}
        className="flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-blue-200 bg-white text-blue-700 hover:bg-blue-100 disabled:opacity-50 transition-colors"
      >
        {loading === 'export' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
        导出
      </button>

      <div className="flex-1" />

      <button
        onClick={onClear}
        className="text-gray-400 hover:text-gray-600 transition-colors"
        title="取消选择"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
