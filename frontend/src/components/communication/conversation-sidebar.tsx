'use client';

import { useState } from 'react';
import { Search, MessageCircle, Globe, MessageSquare, Pin, X } from 'lucide-react';
import type { Channel, ConversationSummary } from './types';
import { cn } from '@/lib/utils';

const channels: { key: Channel | 'all'; label: string; icon: React.ReactNode }[] = [
  { key: 'all', label: '全部', icon: null },
  { key: 'whatsapp', label: 'WhatsApp', icon: <MessageCircle className="w-3 h-3" /> },
  { key: 'website_inquiry', label: '网站询盘', icon: <Globe className="w-3 h-3" /> },
  { key: 'website_livechat', label: '实时客服', icon: <MessageSquare className="w-3 h-3" /> },
];

const groups: { key: string; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'unread', label: '未读' },
  { key: 'pinned', label: '置顶' },
  { key: 'A', label: 'A级' },
  { key: 'B', label: 'B级' },
  { key: 'C', label: 'C级' },
  { key: 'pending', label: '待跟进' },
];

interface Props {
  conversations: ConversationSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function ConversationSidebar({ conversations, selectedId, onSelect }: Props) {
  const [channel, setChannel] = useState<Channel | 'all'>('all');
  const [group, setGroup] = useState('all');
  const [search, setSearch] = useState('');

  const filtered = conversations.filter((c) => {
    if (channel !== 'all' && c.channel !== channel) return false;
    if (group === 'unread' && !c.unreadCount) return false;
    if (group === 'pinned' && !c.isPinned) return false;
    if (group === 'A' && c.lead?.leadGrade !== 'A') return false;
    if (group === 'B' && c.lead?.leadGrade !== 'B') return false;
    if (group === 'C' && c.lead?.leadGrade !== 'C') return false;
    if (group === 'pending' && !c.hasPendingFollowUp) return false;
    if (search) {
      const q = search.toLowerCase();
      return (c.lead?.companyName?.toLowerCase().includes(q) || c.subject?.toLowerCase().includes(q) || c.lastMessagePreview?.toLowerCase().includes(q));
    }
    return true;
  });

  const formatTime = (ts: string | null) => {
    if (!ts) return '';
    const d = new Date(ts);
    const now = new Date();
    const diffMin = Math.floor((now.getTime() - d.getTime()) / 60000);
    if (diffMin < 1) return '刚刚';
    if (diffMin < 60) return `${diffMin}分钟前`;
    const diffHrs = Math.floor(diffMin / 60);
    if (diffHrs < 24) return `${diffHrs}小时前`;
    const diffDays = Math.floor(diffHrs / 24);
    if (diffDays < 7) return `${diffDays}天前`;
    return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
  };

  const channelLabel = (ch: string) => channels.find(c => c.key === ch)?.label || ch;
  const channelColor = (ch: string) => {
    if (ch === 'whatsapp') return 'bg-green-50 text-green-600';
    if (ch === 'website_inquiry') return 'bg-blue-50 text-blue-600';
    if (ch === 'website_livechat') return 'bg-purple-50 text-purple-600';
    return 'bg-gray-50 text-gray-500';
  };

  return (
    <aside className="flex flex-col h-full border-r bg-white">
      {/* Header */}
      <div className="px-3 py-3 border-b">
        <h2 className="text-sm font-semibold mb-2.5">会话列表</h2>

        {/* Channel tabs */}
        <div className="grid grid-cols-4 gap-1 mb-2">
          {channels.map((ch) => (
            <button key={ch.key} onClick={() => setChannel(ch.key)} className={cn(
              'flex items-center justify-center gap-1 h-7 rounded-md text-[10px] border transition-colors',
              channel === ch.key ? 'bg-blue-50 border-blue-200 text-blue-700 font-semibold' : 'bg-gray-50 border-gray-200 text-gray-500 hover:bg-gray-100'
            )}>{ch.icon}{ch.label}</button>
          ))}
        </div>

        {/* Group tabs */}
        <div className="flex gap-1 flex-wrap mb-2">
          {groups.map((g) => (
            <button key={g.key} onClick={() => setGroup(g.key)} className={cn(
              'px-2 py-0.5 rounded text-[10px] transition-colors',
              group === g.key ? 'bg-gray-200 text-gray-800 font-medium' : 'text-gray-400 hover:text-gray-600'
            )}>{g.label}</button>
          ))}
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-gray-400" />
          <input type="text" placeholder="搜索客户名、主题、消息..." value={search} onChange={(e) => setSearch(e.target.value)} className="w-full h-8 pl-7 pr-7 rounded-md border text-xs outline-none focus:border-blue-300" />
          {search && (
            <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>

      {/* Conversation list */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1.5">
        {filtered.map((conv) => {
          // 获取客户头像 — 优先 ContactPoint 缓存的 avatarUrl
          const avatarUrl = conv.contactPoint?.avatarUrl || null;
          // 客户名首字母作为 fallback
          const displayName = conv.lead?.companyName || conv.subject || '未知';
          const initial = displayName.charAt(0).toUpperCase();
          // 真实手机号（用于显示）
          const realPhone = conv.lead?.whatsapp && !conv.lead.whatsapp.includes('@')
            ? conv.lead.whatsapp
            : (conv.contactPoint?.originalValue && !conv.contactPoint.originalValue.includes('@')
              ? conv.contactPoint.originalValue
              : null);
          return (
          <button
            key={conv.id}
            onClick={() => onSelect(conv.id)}
            className={cn(
              'w-full text-left p-2.5 rounded-lg border transition-all',
              selectedId === conv.id
                ? 'bg-blue-50 border-blue-300 shadow-sm'
                : conv.unreadCount > 0
                  ? 'bg-green-50/40 border-green-200 hover:bg-green-50 hover:border-green-300'
                  : 'border-transparent hover:bg-gray-50 hover:border-gray-200'
            )}
          >
            {/* Row 1: Avatar + Name + Time */}
            <div className="flex items-start justify-between gap-2 mb-1">
              <div className="flex items-center gap-2 flex-1 min-w-0">
                {/* 客户头像 */}
                <div className="w-8 h-8 rounded-full shrink-0 overflow-hidden flex items-center justify-center bg-green-100 text-green-700 text-xs font-bold">
                  {avatarUrl ? (
                    <img src={avatarUrl} alt="" className="w-full h-full object-cover"
                         onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                  ) : (
                    initial
                  )}
                </div>
                <span className="font-semibold text-xs text-gray-900 truncate flex-1 flex items-center gap-1">
                  {conv.isPinned && <Pin className="w-2.5 h-2.5 text-amber-500 shrink-0" fill="currentColor" />}
                  {displayName}
                </span>
              </div>
              <span className="text-[10px] text-gray-400 whitespace-nowrap shrink-0">{formatTime(conv.lastMessageAt)}</span>
            </div>

            {/* Row 2: Channel + Phone + Grade + Unread */}
            <div className="flex items-center gap-1.5 mb-1 flex-wrap">
              <span className={cn('text-[9px] px-1.5 py-0.5 rounded font-medium', channelColor(conv.channel))}>
                {channelLabel(conv.channel)}
              </span>
              {realPhone && (
                <span className="text-[9px] text-green-600 font-mono">
                  {realPhone}
                </span>
              )}
              {conv.lead?.leadGrade && (
                <span className={cn(
                  'text-[8px] px-1.5 py-0.5 rounded-full font-bold',
                  conv.lead.leadGrade === 'A' ? 'bg-green-100 text-green-700'
                  : conv.lead.leadGrade === 'B' ? 'bg-yellow-100 text-yellow-700'
                  : 'bg-gray-100 text-gray-500'
                )}>{conv.lead.leadGrade}级</span>
              )}
              {conv.unreadCount > 0 && (
                <span className="bg-red-500 text-white text-[9px] font-bold px-1.5 py-0.5 rounded-full leading-none ml-auto animate-pulse shadow-sm">
                  {conv.unreadCount}
                </span>
              )}
            </div>

            {/* Row 3: Last message preview */}
            {conv.lastMessagePreview && (
              <p className="text-[10px] text-gray-500 truncate leading-relaxed">
                {conv.lastMessagePreview}
              </p>
            )}
          </button>
          );
        })}
        {filtered.length === 0 && (
          <div className="text-center py-12">
            <p className="text-xs text-gray-400">暂无会话</p>
          </div>
        )}
      </div>
    </aside>
  );
}
