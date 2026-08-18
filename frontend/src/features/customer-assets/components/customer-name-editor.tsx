/**
 * TASK-102H: CustomerNameEditor
 *
 * 公司名内联编辑器。
 * - 受控编辑模式（view / edit）
 * - 空公司名显示占位符
 * - Enter 保存、Escape 取消
 */

'use client';

import { useState, useEffect, useCallback } from 'react';
import { Edit3, Check, X, Loader2 } from 'lucide-react';
import { buildDisplayName } from '../domain/customer-links';

export interface CustomerNameEditorProps {
  companyName: string | null;
  onSave: (newName: string) => Promise<void>;
  saving?: boolean;
}

export function CustomerNameEditor({
  companyName,
  onSave,
  saving = false,
}: CustomerNameEditorProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  // 同步外部值
  useEffect(() => {
    setDraft(companyName ?? '');
    setEditing(false);
  }, [companyName]);

  const handleSave = useCallback(async () => {
    await onSave(draft);
    setEditing(false);
  }, [draft, onSave]);

  const handleCancel = useCallback(() => {
    setDraft(companyName ?? '');
    setEditing(false);
  }, [companyName]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        void handleSave();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        handleCancel();
      }
    },
    [handleSave, handleCancel],
  );

  if (editing) {
    return (
      <div className="flex items-center gap-1" data-testid="name-editor-editing">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          className="text-sm font-bold text-gray-900 border-b border-blue-400 outline-none flex-1 bg-transparent"
          autoFocus
          placeholder="公司名称"
          disabled={saving}
        />
        <button
          onClick={handleSave}
          disabled={saving}
          className="text-green-600 hover:text-green-700 disabled:opacity-40"
          aria-label="保存"
        >
          {saving ? (
            <Loader2 className="w-3 h-3 animate-spin" />
          ) : (
            <Check className="w-3 h-3" />
          )}
        </button>
        <button
          onClick={handleCancel}
          disabled={saving}
          className="text-gray-400 hover:text-red-500 disabled:opacity-40"
          aria-label="取消"
        >
          <X className="w-3 h-3" />
        </button>
      </div>
    );
  }

  const display = buildDisplayName(companyName);
  const isPlaceholder = companyName === null || companyName.trim() === '';

  return (
    <div
      className="flex items-center gap-1 group"
      data-testid="name-editor-view"
    >
      <p
        className={`text-sm font-bold flex-1 ${
          isPlaceholder ? 'text-gray-400 italic' : 'text-gray-900'
        }`}
      >
        {display}
      </p>
      <button
        onClick={() => setEditing(true)}
        className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-blue-600 transition-opacity"
        aria-label="编辑公司名"
      >
        <Edit3 className="w-3 h-3" />
      </button>
    </div>
  );
}
