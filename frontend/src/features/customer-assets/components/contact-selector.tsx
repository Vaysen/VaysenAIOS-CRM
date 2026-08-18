/**
 * TASK-102H: ContactSelector
 *
 * 多联系人选择器：受控、可折叠、键盘支持。
 * - 受控：selectedContactId + onSelect 回调
 * - 可折叠：展开/收起联系人列表
 * - 键盘：Enter/Space 选中、Escape 折叠、ArrowDown/ArrowUp 导航
 */

'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { ChevronDown, ChevronRight, User } from 'lucide-react';
import type { CustomerContact } from '../types';
import { formatContactName } from '../domain/customer-links';
import { ContactSummary } from './contact-summary';

export interface ContactSelectorProps {
  contacts: CustomerContact[];
  selectedContactId: string | null;
  onSelect: (contactId: string) => void;
  /** 是否默认展开 */
  defaultExpanded?: boolean;
}

export function ContactSelector({
  contacts,
  selectedContactId,
  onSelect,
  defaultExpanded = false,
}: ContactSelectorProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [keyboardIndex, setKeyboardIndex] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);

  // 选中联系人变化时，重置键盘索引到选中项
  useEffect(() => {
    if (selectedContactId) {
      const idx = contacts.findIndex((c) => c.id === selectedContactId);
      if (idx >= 0) setKeyboardIndex(idx);
    }
  }, [selectedContactId, contacts]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (contacts.length === 0) return;

      switch (e.key) {
        case 'Enter':
        case ' ':
          e.preventDefault();
          if (!expanded) {
            setExpanded(true);
          } else if (contacts[keyboardIndex]) {
            onSelect(contacts[keyboardIndex].id);
            setExpanded(false);
          }
          break;
        case 'Escape':
          e.preventDefault();
          setExpanded(false);
          break;
        case 'ArrowDown':
          e.preventDefault();
          if (!expanded) {
            setExpanded(true);
          } else {
            setKeyboardIndex((prev) => Math.min(prev + 1, contacts.length - 1));
          }
          break;
        case 'ArrowUp':
          e.preventDefault();
          if (expanded) {
            setKeyboardIndex((prev) => Math.max(prev - 1, 0));
          }
          break;
      }
    },
    [contacts, keyboardIndex, expanded, onSelect],
  );

  if (contacts.length === 0) {
    return (
      <div className="p-2 text-[11px] text-gray-400" data-testid="contact-selector-empty">
        暂无联系人
      </div>
    );
  }

  const selected =
    contacts.find((c) => c.id === selectedContactId) ?? contacts[0];
  const selectedName = formatContactName(selected);

  return (
    <div
      className="border rounded"
      data-testid="contact-selector"
      tabIndex={0}
      onKeyDown={handleKeyDown}
      role="combobox"
      aria-expanded={expanded}
      aria-haspopup="listbox"
      aria-label="联系人选择器"
    >
      {/* 折叠头部 */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-1.5 px-2 py-1.5 text-left hover:bg-gray-50 rounded-t"
      >
        <User className="w-3 h-3 text-gray-400 shrink-0" />
        <span className="text-[12px] font-medium text-gray-700 truncate flex-1">
          {selectedName}
        </span>
        {expanded ? (
          <ChevronDown className="w-3 h-3 text-gray-400 shrink-0" />
        ) : (
          <ChevronRight className="w-3 h-3 text-gray-400 shrink-0" />
        )}
      </button>

      {/* 展开列表 */}
      {expanded && (
        <div
          ref={listRef}
          className="border-t max-h-48 overflow-y-auto"
          role="listbox"
        >
          {contacts.map((contact, index) => (
            <button
              key={contact.id}
              type="button"
              role="option"
              aria-selected={contact.id === selectedContactId}
              onClick={() => {
                onSelect(contact.id);
                setExpanded(false);
              }}
              onMouseEnter={() => setKeyboardIndex(index)}
              className={`w-full px-2 py-1.5 text-left transition-colors ${
                contact.id === selectedContactId
                  ? 'bg-blue-50'
                  : index === keyboardIndex
                    ? 'bg-gray-50'
                    : 'hover:bg-gray-50'
              }`}
            >
              <ContactSummary
                contact={contact}
                isSelected={contact.id === selectedContactId}
              />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
