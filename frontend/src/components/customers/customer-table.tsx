'use client';

import Link from 'next/link';
import { cn } from '@/lib/utils';
import { MapPin, Star, ExternalLink, Mail, MessageSquare, FileText, Phone } from 'lucide-react';
import { CustomerHoverCard } from './hover-card';

interface CustomerTableProps {
  leads: any[];
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onToggleSelectAll: () => void;
  loading: boolean;
  error: string | null;
}

const STAGE_LABELS: Record<string, { label: string; className: string }> = {
  new: { label: '新客户', className: 'bg-blue-50 text-blue-700 border-blue-200' },
  contacted: { label: '已联系', className: 'bg-cyan-50 text-cyan-700 border-cyan-200' },
  sampling: { label: '样品中', className: 'bg-purple-50 text-purple-700 border-purple-200' },
  quoting: { label: '报价中', className: 'bg-amber-50 text-amber-700 border-amber-200' },
  negotiating: { label: '谈判中', className: 'bg-orange-50 text-orange-700 border-orange-200' },
  won: { label: '已成交', className: 'bg-green-50 text-green-700 border-green-200' },
  lost: { label: '暂停', className: 'bg-gray-50 text-gray-500 border-gray-200' },
};

const SOURCE_LABELS: Record<string, string> = {
  website_inquiry: '网站询盘',
  alibaba_inquiry: '阿里询盘',
  acquisition: '获客开发',
  manual: '手动录入',
  whatsapp_click: 'WhatsApp',
  whatsapp: 'WhatsApp',
  google: 'Google',
  facebook: 'Facebook',
  exhibition: '展会',
  referral: '客户推荐',
};

function timeAgo(dateStr: string | null | undefined): string {
  if (!dateStr) return '—';
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diff = now - then;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}小时前`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}天前`;
  return new Date(dateStr).toLocaleDateString('zh-CN');
}

export function CustomerTable({ leads, selectedIds, onToggleSelect, onToggleSelectAll, loading, error }: CustomerTableProps) {
  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (error) {
    return <div className="p-8 text-center text-sm text-red-600">{error}</div>;
  }

  if (leads.length === 0) {
    return (
      <div className="p-12 text-center">
        <div className="w-12 h-12 mx-auto mb-3 rounded-xl bg-blue-50 flex items-center justify-center text-xl">
          <Star className="w-6 h-6 text-blue-500" />
        </div>
        <p className="text-sm font-medium text-gray-700">暂无客户数据</p>
        <p className="text-xs text-gray-500 mt-1">获客开发、网站询盘和手动录入的客户将在此显示。</p>
      </div>
    );
  }

  const allSelected = leads.length > 0 && leads.every(l => selectedIds.has(l.id));

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12px] min-w-[1100px]">
        <thead>
          <tr className="border-b bg-gray-50/80 sticky top-0 z-10">
            <th className="text-left py-2.5 px-2 w-8">
              <input
                type="checkbox"
                checked={allSelected}
                onChange={onToggleSelectAll}
                className="w-3.5 h-3.5 rounded border-gray-300"
              />
            </th>
            <th className="text-left py-2.5 px-2 text-gray-500 font-medium">公司名称</th>
            <th className="text-left py-2.5 px-2 text-gray-500 font-medium">客户标签</th>
            <th className="text-left py-2.5 px-2 text-gray-500 font-medium">客户阶段</th>
            <th className="text-left py-2.5 px-2 text-gray-500 font-medium">主要联系人</th>
            <th className="text-left py-2.5 px-2 text-gray-500 font-medium">最新动态</th>
            <th className="text-left py-2.5 px-2 text-gray-500 font-medium">跟进人</th>
            <th className="text-left py-2.5 px-2 text-gray-500 font-medium">最近联系</th>
            <th className="text-left py-2.5 px-2 text-gray-500 font-medium">国家/地区</th>
            <th className="text-left py-2.5 px-2 text-gray-500 font-medium">来源</th>
            <th className="text-left py-2.5 px-2 text-gray-500 font-medium">创建时间</th>
            <th className="text-left py-2.5 px-2 text-gray-500 font-medium">操作</th>
          </tr>
        </thead>
        <tbody>
          {leads.map((lead: any) => {
            const stage = STAGE_LABELS[lead.status] || STAGE_LABELS.new;
            const isSelected = selectedIds.has(lead.id);
            return (
              <tr
                key={lead.id}
                className={cn(
                  'border-b hover:bg-gray-50/80 transition-colors',
                  isSelected && 'bg-blue-50/40'
                )}
              >
                <td className="py-2.5 px-2">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => onToggleSelect(lead.id)}
                    className="w-3.5 h-3.5 rounded border-gray-300"
                  />
                </td>
                <td className="py-2.5 px-2">
                  <Link href={`/customers/${lead.id}`} className="hover:text-blue-600 transition-colors">
                    <span className="font-medium text-gray-900 flex items-center gap-1">
                      {lead.isPinned && <Star className="w-3 h-3 text-amber-500 shrink-0" fill="currentColor" />}
                      <span className="truncate max-w-[160px]">{lead.companyName || lead.leadName || '未知'}</span>
                    </span>
                  </Link>
                </td>
                <td className="py-2.5 px-2">
                  <div className="flex flex-wrap gap-1">
                    {lead.leadGrade && (
                      <span className={cn(
                        'text-[9px] px-1.5 py-0.5 rounded-full border font-medium',
                        lead.leadGrade === 'A' ? 'bg-green-50 text-green-700 border-green-200' :
                        lead.leadGrade === 'B' ? 'bg-blue-50 text-blue-700 border-blue-200' :
                        'bg-gray-50 text-gray-500 border-gray-200'
                      )}>
                        {lead.leadGrade}级
                      </span>
                    )}
                    {(lead.tags || []).slice(0, 2).map((t: any) => (
                      <span key={t.id || t.tagId} className="text-[9px] px-1.5 py-0.5 rounded-full border bg-gray-50 text-gray-500">
                        {t.tag?.displayName || t.tag?.name || '标签'}
                      </span>
                    ))}
                    {(lead.tags || []).length > 2 && (
                      <span className="text-[9px] text-gray-400">+{lead.tags.length - 2}</span>
                    )}
                  </div>
                </td>
                <td className="py-2.5 px-2">
                  <span className={cn('text-[10px] px-1.5 py-0.5 rounded border', stage.className)}>
                    {stage.label}
                  </span>
                </td>
                <td className="py-2.5 px-2">
                  <div className="text-gray-700 truncate max-w-[120px]">
                    {lead.contactName || '—'}
                    {lead.contactPhone && (
                      <span className="text-[10px] text-gray-400 ml-1">{lead.contactPhone}</span>
                    )}
                  </div>
                </td>
                <td className="py-2.5 px-2">
                  <CustomerHoverCard leadId={lead.id} lead={lead} />
                </td>
                <td className="py-2.5 px-2">
                  <span className="text-blue-600">{lead.owner?.firstName || lead.owner?.email?.split('@')[0] || '—'}</span>
                </td>
                <td className="py-2.5 px-2">
                  <span className="text-gray-500 text-[11px]">{timeAgo(lead.lastContactedAt)}</span>
                </td>
                <td className="py-2.5 px-2">
                  {lead.country ? (
                    <span className="flex items-center gap-1 text-gray-600">
                      <MapPin className="w-3 h-3 text-gray-400" />
                      {lead.country}
                    </span>
                  ) : (
                    <span className="text-gray-300">—</span>
                  )}
                </td>
                <td className="py-2.5 px-2">
                  <span className="text-gray-500 text-[11px]">
                    {SOURCE_LABELS[lead.sourceType] || lead.sourceType || '—'}
                  </span>
                </td>
                <td className="py-2.5 px-2">
                  <span className="text-gray-400 text-[11px]">
                    {lead.createdAt ? new Date(lead.createdAt).toLocaleDateString('zh-CN') : '—'}
                  </span>
                </td>
                <td className="py-2.5 px-2">
                  <div className="flex items-center gap-1.5">
                    <Link
                      href={`/customers/${lead.id}`}
                      className="text-[11px] text-blue-600 hover:underline"
                    >
                      详情
                    </Link>
                    <Link
                      href={`/communication?leadId=${lead.id}&phone=${encodeURIComponent(lead.contactPhone || '')}`}
                      className="text-[11px] text-gray-400 hover:text-blue-600"
                      title="沟通"
                    >
                      <MessageSquare className="w-3 h-3" />
                    </Link>
                    {lead.contactEmail && (
                      <a
                        href={`mailto:${lead.contactEmail}`}
                        className="text-[11px] text-gray-400 hover:text-blue-600"
                        title="发邮件"
                      >
                        <Mail className="w-3 h-3" />
                      </a>
                    )}
                    <Link
                      href={`/quotes/new?leadId=${lead.id}`}
                      className="text-[11px] text-gray-400 hover:text-blue-600"
                      title="生成报价"
                    >
                      <FileText className="w-3 h-3" />
                    </Link>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
