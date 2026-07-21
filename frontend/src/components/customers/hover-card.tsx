'use client';

import { useEffect, useState, useRef } from 'react';
import Link from 'next/link';
import api from '@/lib/api';
import { Clock, Mail, FileText, Tag, MapPin, MessageSquare, Building2, Star, ExternalLink, ArrowRight, TrendingUp } from 'lucide-react';
import { cn } from '@/lib/utils';

interface Props {
  leadId: string;
  lead?: any;
}

export function CustomerHoverCard({ leadId, lead: leadProp }: Props) {
  const [activity, setActivity] = useState<any[] | null>(null);
  const [visible, setVisible] = useState(false);
  const [lead, setLead] = useState<any>(leadProp || null);
  const [popupPos, setPopupPos] = useState<{ x: number; y: number } | null>(null);
  const triggerRef = useRef<HTMLSpanElement>(null);

  const handleMouseEnter = () => {
    if (triggerRef.current) {
      const rect = triggerRef.current.getBoundingClientRect();
      setPopupPos({ x: rect.left, y: rect.bottom + 8 });
    }
    setVisible(true);
  };

  useEffect(() => {
    if (!visible) return;
    if (!lead && leadId) {
      api.get(`/leads/${leadId}`)
        .then(r => setLead(r.data))
        .catch((error) => { console.error('[Frontend] background operation failed:', error); });
    }
    if (activity === null) {
      api.get(`/leads/${leadId}/timeline`, { params: { limit: 5 } })
        .then(r => setActivity(r.data?.data || []))
        .catch(() => setActivity([]));
    }
  }, [visible, leadId]);

  if (!leadId) return null;

  const stageLabel: Record<string, string> = {
    new: '新客户', contacted: '已联系', sampling: '样品中',
    quoting: '报价中', negotiating: '谈判中', won: '已成交', lost: '暂停',
  };

  return (
    <span
      className="relative inline-block"
      ref={triggerRef}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={() => setVisible(false)}
    >
      <span className="text-[11px] text-blue-600 cursor-pointer hover:underline decoration-dotted whitespace-nowrap">
        最新动态
      </span>

      {visible && popupPos && (
        <div
          className="fixed z-[9999] w-[360px] bg-white border border-gray-200 rounded-lg shadow-xl"
          style={{ left: `${popupPos.x}px`, top: `${popupPos.y}px` }}
          onMouseEnter={() => setVisible(true)}
          onMouseLeave={() => setVisible(false)}
        >
          {/* Arrow */}
          <div className="absolute w-3 h-3 bg-white border-l border-t border-gray-200 transform rotate-45 -top-1.5 left-4" />

          <div className="p-3 max-h-[420px] overflow-y-auto">
            {/* Customer Profile Summary */}
            {lead && (
              <div className="border-b pb-2 mb-2">
                <div className="flex items-center justify-between mb-1">
                  <Link
                    href={`/customers/${leadId}`}
                    className="text-[13px] font-semibold text-gray-900 hover:text-blue-600 truncate max-w-[220px]"
                  >
                    {lead.companyName || lead.leadName || '未知'}
                  </Link>
                  <span className="text-[10px] text-gray-400">
                    {lead.updatedAt ? new Date(lead.updatedAt).toLocaleDateString('zh-CN') : ''}
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-gray-500">
                  {lead.contactName && <span>{lead.contactName}</span>}
                  {lead.country && (
                    <span className="flex items-center gap-0.5">
                      <MapPin className="w-2.5 h-2.5" />{lead.country}
                    </span>
                  )}
                  {lead.leadGrade && (
                    <span className={cn(
                      'px-1 rounded-full font-medium text-[9px]',
                      lead.leadGrade === 'A' ? 'bg-green-100 text-green-700' :
                      lead.leadGrade === 'B' ? 'bg-blue-100 text-blue-700' :
                      'bg-gray-100 text-gray-600'
                    )}>
                      {lead.leadGrade}级
                    </span>
                  )}
                  {lead.status && (
                    <span className="px-1 rounded border bg-gray-50 text-gray-500">
                      {stageLabel[lead.status] || lead.status}
                    </span>
                  )}
                </div>
              </div>
            )}

            {/* Activity Timeline */}
            <div className="mb-2">
              <p className="text-[10px] font-medium text-gray-400 mb-1.5 flex items-center gap-1">
                <Clock className="w-2.5 h-2.5" />最近动态
              </p>
              {activity === null ? (
                <p className="text-[10px] text-gray-400 py-2">加载中...</p>
              ) : activity.length === 0 ? (
                <p className="text-[10px] text-gray-400 py-2">暂无动态</p>
              ) : (
                <div className="space-y-1.5">
                  {activity.slice(0, 3).map((a: any) => (
                    <div key={a.id} className="border-l-2 border-blue-200 pl-2">
                      <p className="text-[11px] font-medium text-gray-800 truncate">{a.title}</p>
                      {a.description && (
                        <p className="text-[10px] text-gray-500 line-clamp-2 mt-0.5">{a.description}</p>
                      )}
                      <p className="text-[9px] text-gray-400 mt-0.5">
                        {new Date(a.occurredAt).toLocaleString('zh-CN')}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Related Info */}
            {lead && (
              <div className="border-t pt-2 mt-1">
                <div className="flex flex-wrap gap-1.5">
                  {lead.contactEmail && (
                    <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500 flex items-center gap-0.5">
                      <Mail className="w-2 h-2" />{lead.contactEmail}
                    </span>
                  )}
                  {(lead.tags || []).slice(0, 2).map((t: any) => (
                    <span key={t.id || t.tagId} className="text-[9px] px-1.5 py-0.5 rounded-full border bg-gray-50 text-gray-500 flex items-center gap-0.5">
                      <Tag className="w-2 h-2" />{t.tag?.displayName || t.tag?.name || '标签'}
                    </span>
                  ))}
                </div>

                {/* Quick Actions */}
                <div className="flex gap-1.5 mt-2">
                  <Link
                    href={`/customers/${leadId}`}
                    className="flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded border border-blue-200 bg-blue-50 text-blue-600 hover:bg-blue-100"
                  >
                    <ExternalLink className="w-2.5 h-2.5" />详情
                  </Link>
                  {lead.contactEmail && (
                    <a
                      href={`/communication?leadId=${leadId}`}
                      className="flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded border border-gray-200 hover:bg-gray-50 text-gray-600"
                    >
                      <MessageSquare className="w-2.5 h-2.5" />沟通
                    </a>
                  )}
                  <Link
                    href={`/quotes/new?leadId=${leadId}`}
                    className="flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded border border-gray-200 hover:bg-gray-50 text-gray-600"
                  >
                    <FileText className="w-2.5 h-2.5" />报价
                  </Link>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </span>
  );
}
