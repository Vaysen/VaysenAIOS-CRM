'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import api from '@/lib/api';
import { MapPin, Mail, Building2, Tag, Clock, ExternalLink, FileText, MessageSquare, Send, Phone, Globe, Briefcase } from 'lucide-react';

interface Props {
  lead: any;
  onClose?: () => void;
}

const STAGE_LABELS: Record<string, string> = {
  new: '新客户', contacted: '已联系', sampling: '样品中',
  quoting: '报价中', negotiating: '谈判中', won: '已成交', lost: '暂停',
};

const SOURCE_LABELS: Record<string, string> = {
  website_inquiry: '独立站询盘',
  alibaba_inquiry: '阿里询盘',
  acquisition: '获客开发',
  manual: '手动录入',
  whatsapp_click: 'WhatsApp',
  google: 'Google',
  facebook: 'Facebook',
  exhibition: '展会',
  referral: '客户推荐',
};

export function KanbanHoverCard({ lead, onClose }: Props) {
  const [detail, setDetail] = useState<any>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!lead?.id || loaded) return;
    setLoaded(true);
    api.get(`/leads/${lead.id}`)
      .then(r => setDetail(r.data))
      .catch(() => setDetail(null));
  }, [lead?.id]);

  const data = detail || lead;
  const stageLabel = STAGE_LABELS[data.status] || data.status || '新客户';
  const sourceLabel = SOURCE_LABELS[data.sourceType] || data.sourceType || '—';

  return (
    <div
      className="absolute z-[9999] w-[340px] bg-white rounded-lg shadow-2xl border border-gray-200 p-4"
      style={{
        top: '-10px',
        left: 'calc(100% + 12px)',
        pointerEvents: 'auto',
      }}
      onMouseLeave={onClose}
    >
      {/* Arrow pointer */}
      <div className="absolute w-3 h-3 bg-white border-l border-t border-gray-200 transform rotate-45 top-5 -left-1.5" />

      {/* Header */}
      <div className="flex items-start justify-between border-b pb-2.5 mb-2.5">
        <div>
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-bold text-gray-900">{data.companyName || data.leadName || '未知'}</span>
            {data.leadGrade && (
              <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold ${
                data.leadGrade === 'A' ? 'bg-green-100 text-green-700' :
                data.leadGrade === 'B' ? 'bg-blue-100 text-blue-700' :
                'bg-gray-100 text-gray-600'
              }`}>
                {data.leadGrade}级
              </span>
            )}
          </div>
          {data.contactName && (
            <p className="text-[10px] text-gray-500 mt-0.5">
              <Briefcase className="w-2.5 h-2.5 inline mr-0.5" />
              {data.contactName}{detail?.contactTitle ? ` (${detail.contactTitle})` : ''}
            </p>
          )}
        </div>
        <span className={`text-[9px] px-1.5 py-0.5 rounded border ${
          data.status === 'won' ? 'bg-green-50 text-green-700 border-green-200' :
          data.status === 'new' ? 'bg-blue-50 text-blue-700 border-blue-200' :
          'bg-gray-50 text-gray-500 border-gray-200'
        }`}>
          {stageLabel}
        </span>
      </div>

      {/* Body */}
      <div className="space-y-1.5 text-[11px]">
        {data.country && (
          <div className="flex items-start gap-2">
            <span className="text-gray-400 w-14 shrink-0">国家地区</span>
            <span className="text-gray-700 flex items-center gap-1"><MapPin className="w-3 h-3 text-gray-400" />{data.country}</span>
          </div>
        )}

        <div className="flex items-start gap-2">
          <span className="text-gray-400 w-14 shrink-0">客户来源</span>
          <span className="text-gray-700">{sourceLabel}</span>
        </div>

        {data.contactEmail && (
          <div className="flex items-start gap-2">
            <span className="text-gray-400 w-14 shrink-0">联系方式</span>
            <a href={`mailto:${data.contactEmail}`} className="text-blue-600 hover:underline flex items-center gap-1">
              <Mail className="w-3 h-3" />{data.contactEmail}
            </a>
          </div>
        )}

        {data.contactPhone && (
          <div className="flex items-start gap-2">
            <span className="text-gray-400 w-14 shrink-0">电话</span>
            <span className="text-gray-700 flex items-center gap-1"><Phone className="w-3 h-3 text-gray-400" />{data.contactPhone}</span>
          </div>
        )}

        {(data.website || detail?.website) && (
          <div className="flex items-start gap-2">
            <span className="text-gray-400 w-14 shrink-0">官网</span>
            <a href={detail?.website || data.website} target="_blank" className="text-blue-600 hover:underline flex items-center gap-1 truncate max-w-[220px]">
              <Globe className="w-3 h-3 shrink-0" />{detail?.website || data.website}
            </a>
          </div>
        )}

        {(data.tags || []).length > 0 && (
          <div className="flex items-start gap-2">
            <span className="text-gray-400 w-14 shrink-0">客户标签</span>
            <div className="flex flex-wrap gap-1">
              {(data.tags || []).slice(0, 5).map((t: any) => (
                <span key={t.id || t.tagId} className="text-[9px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-600 border">
                  {t.tag?.displayName || t.tag?.name || '标签'}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Latest activity if available */}
        {detail?.latestActivity && (
          <div className="flex items-start gap-2">
            <span className="text-gray-400 w-14 shrink-0">最近动态</span>
            <span className="text-gray-500 text-[10px] truncate">{detail.latestActivity}</span>
          </div>
        )}

        {/* Owner info */}
        {data.owner?.firstName && (
          <div className="flex items-start gap-2">
            <span className="text-gray-400 w-14 shrink-0">跟进人</span>
            <span className="text-blue-600">{data.owner.firstName}</span>
          </div>
        )}
      </div>

      {/* Footer Actions */}
      <div className="mt-3 pt-3 border-t flex gap-2">
        <Link
          href={`/customers/${data.id}`}
          className="flex-1 flex items-center justify-center gap-1 py-1.5 text-[10px] rounded border border-gray-200 text-gray-600 hover:border-blue-300 hover:text-blue-600 hover:bg-blue-50 transition-colors"
        >
          <ExternalLink className="w-3 h-3" />查看详情
        </Link>
        <Link
          href={`/follow-ups?leadId=${data.id}`}
          className="flex-1 flex items-center justify-center gap-1 py-1.5 text-[10px] rounded border border-gray-200 text-gray-600 hover:border-blue-300 hover:text-blue-600 hover:bg-blue-50 transition-colors"
        >
          <FileText className="w-3 h-3" />写跟进
        </Link>
        <Link
          href={data.contactEmail ? `mailto:${data.contactEmail}` : `/communication?leadId=${data.id}`}
          className="flex-1 flex items-center justify-center gap-1 py-1.5 text-[10px] rounded bg-blue-600 text-white hover:bg-blue-700 transition-colors"
        >
          <Send className="w-3 h-3" />发邮件
        </Link>
      </div>
    </div>
  );
}
