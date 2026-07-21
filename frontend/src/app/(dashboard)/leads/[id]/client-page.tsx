'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useRuntimeRouteParam } from '@/lib/use-runtime-route-param';
import {
  ArrowLeft,
  Building2,
  CalendarClock,
  CheckCircle2,
  ExternalLink,
  FileText,
  Loader2,
  Mail,
  MapPin,
  Microscope,
  Pencil,
  Phone,
  Send,
  ShieldCheck,
  ShieldAlert,
  ShieldQuestion,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import api from '@/lib/api';
import { useAuthStore } from '@/store/authStore';
import { createClientUuid } from '@/lib/client-id';
import { LEAD_STAGES, STATUS_COLORS, EMAIL_VERIFY_COLORS, EMAIL_VERIFY_LABELS, EMAIL_VERIFY_ICONS, REJECTION_REASONS, PIPELINE_COLUMN_LABELS, TRUSTED_VERIFY_LEVELS } from '@/lib/lead-constants';
import { useT } from '@/i18n/use-translation';
import { sanitizeRichHtml } from '@/lib/sanitize-rich-html';
import { LanguageBadge } from '@/components/common/LanguageBadge';
import { LanguageSelector } from '@/components/common/LanguageSelector';

interface Contact {
  id: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  title?: string;
  department?: string;
  linkedinUrl?: string;
  isPrimary?: boolean;
  notes?: string;
}

interface LeadDetail {
  id: string;
  companyName: string;
  leadName?: string;
  website?: string;
  websiteDomain?: string;
  country?: string;
  language?: string;
  city?: string;
  industry?: string;
  productCategory?: string;
  businessType?: string;
  contactName?: string;
  contactTitle?: string;
  contactEmail?: string;
  contactPhone?: string;
  whatsapp?: string;
  linkedinUrl?: string;
  facebookUrl?: string;
  instagramUrl?: string;
  yearEstablished?: number;
  employeeCount?: string;
  annualRevenue?: string;
  mainProducts?: string;
  sourceUrl?: string;
  sourceType?: string;
  sourceKeyword?: string;
  sourceCountry?: string;
  confidenceScore?: number;
  leadScore?: number;
  leadGrade?: string;
  emailVerificationStatus?: string;
  emailVerificationReason?: string;
  reviewStatus?: string;
  isUncertain?: boolean;
  uncertainFields?: string[];
  status: string;
  notes?: string;
  contacts?: Contact[];
  latestDeepResearch?: {
    id: string;
    title: string;
    description?: string;
    metadata?: any;
    occurredAt: string;
  };
  deepResearchReports?: {
    id: string;
    title: string;
    description?: string;
    metadata?: any;
    occurredAt: string;
  }[];
  owner?: { id: string; firstName?: string; lastName?: string; email: string };
  lastContactedAt?: string;
  nextFollowUpAt?: string;
  createdAt: string;
  updatedAt: string;
}

function getReportPayload(value: any) {
  if (!value) return null;
  if (value.metadata?.report) return value.metadata.report;
  if (value.report) return value.report;
  return value.metadata || value;
}

function renderValue(value: any): string {
  if (value === null || value === undefined || value === '') return '-';
  if (Array.isArray(value)) return value.map(renderValue).join(', ');
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}

export default function LeadDetailPage() {
  const router = useRouter();
  const id = useRuntimeRouteParam('id');
  const { user } = useAuthStore();
  const { t } = useT();

  const [lead, setLead] = useState<LeadDetail | null>(null);
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [savingStatus, setSavingStatus] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deepResearchLoading, setDeepResearchLoading] = useState(false);
  const [report, setReport] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const currentCompany = user?.companies?.[0];
  const isViewer =
    currentCompany?.role === 'viewer' &&
    !user?.companies?.some((company: any) => company.role === 'super_admin');
  const canWrite = !isViewer;

  const fetchLead = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await api.get(`/leads/${id}`);
      setLead(res.data);
      setStatus(res.data.status || '');
    } catch (err: any) {
      setError(err.response?.data?.message || '客户资料加载失败');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchLead();
    fetchReports();
  }, [fetchLead, id]);

  const latestReport = useMemo(() => getReportPayload(lead?.latestDeepResearch), [lead]);

  const handleStatusChange = async () => {
    if (!lead || !status || status === lead.status) return;
    try {
      setSavingStatus(true);
      await api.patch(`/leads/${lead.id}/status`, { status });
      await fetchLead();
    } catch (err: any) {
      setError(err.response?.data?.message || '状态更新失败');
    } finally {
      setSavingStatus(false);
    }
  };

  const [savingLanguage, setSavingLanguage] = useState(false);

  const handleLanguageChange = async (newLang: string) => {
    if (!lead) return;
    setSavingLanguage(true);
    try {
      await api.patch(`/leads/${lead.id}/language`, { language: newLang });
      setLead({ ...lead, language: newLang });
    } catch (err) {
      console.error('Failed to update language:', err);
    } finally {
      setSavingLanguage(false);
    }
  };

  const [researchReports, setResearchReports] = useState<any[]>([]);

  const fetchReports = async () => {
    if (!id) return;
    try {
      const res = await api.get(`/leads/${id}/research-reports`);
      setResearchReports(res.data?.data || []);
    } catch (error) { console.error('[Frontend] operation failed:', error); }
  };

  const handleDeepResearch = async (type: 'full' | 'contacts' | 'market') => {
    if (!lead) return;
    try {
      setDeepResearchLoading(true);
      setError(null);
      const res = await api.post(`/leads/${lead.id}/deep-research`, {
        type,
        requestId: createClientUuid(),
      });
      if (res.data?.queued) {
        setReport({
          html: `<div style="font-family:Arial,Helvetica,sans-serif;padding:24px;"><h2 style="margin:0 0 12px 0;">Deep research queued</h2><p style="margin:0;color:#4b5563;">The background worker is collecting and verifying data. The finished report will appear in the report list when it is ready.</p></div>`,
          title: 'Deep research queued',
          metadata: { report: res.data, reportType: 'QUEUED', generatedAt: new Date().toISOString() },
        });
        await fetchReports();
        return;
      }
      // New response format: { html, json, title }
      if (res.data?.html) {
        setReport({ html: res.data.html, title: res.data.title || '', metadata: { report: res.data.json, reportType: 'DEEP_RESEARCH_FORMAT', generatedAt: new Date().toISOString() } });
      } else {
        setReport(getReportPayload(res.data));
      }
      await fetchLead();
      await fetchReports();
    } catch (err: any) {
      setError(err.response?.data?.message || 'AI 深度背调失败');
    } finally {
      setDeepResearchLoading(false);
    }
  };

  const loadHistoricalReport = async (reportId: string) => {
    try {
      const res = await api.get(`/leads/${lead?.id}/research-reports/${reportId}`);
      if (res.data?.html) {
        setReport({ html: res.data.html, title: res.data.title || '历史报告', metadata: { report: res.data.json || {}, reportType: 'DEEP_RESEARCH_FORMAT', generatedAt: new Date().toISOString() } });
      }
    } catch (error) { console.error('[Frontend] operation failed:', error); }
  };

  const handleDelete = async () => {
    if (!lead || !confirm(`确定删除客户 "${lead.companyName}" 吗？`)) return;
    try {
      setDeleting(true);
      await api.delete(`/leads/${lead.id}`);
      router.push('/leads');
    } catch (err: any) {
      setError(err.response?.data?.message || '删除失败');
    } finally {
      setDeleting(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-24 text-sm text-gray-500">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        正在加载客户资料...
      </div>
    );
  }

  if (!lead) {
    return (
      <div className="space-y-4">
        <BackLink />
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
          {error || '客户不存在'}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <BackLink />
          <div>
            <h2 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">
              {lead.companyName}
            </h2>
            <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
              {[lead.country, lead.city, lead.industry].filter(Boolean).join(' / ') || '客户资料卡'}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {canWrite && (
            <div className="flex flex-wrap items-center gap-1">
              <button
                onClick={() => handleDeepResearch('full')}
                disabled={deepResearchLoading}
                className="inline-flex items-center gap-2 rounded-lg border border-emerald-300 px-3 py-2 text-sm font-medium text-emerald-700 hover:bg-emerald-50 disabled:opacity-50 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-900/20"
              >
                {deepResearchLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Microscope className="h-4 w-4" />}
                AI 深度背调
              </button>
              <button
                onClick={() => handleDeepResearch('contacts')}
                disabled={deepResearchLoading}
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
              >
                深挖联系人
              </button>
              <button
                onClick={() => handleDeepResearch('market')}
                disabled={deepResearchLoading}
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
              >
                市场分析
              </button>
            </div>
          )}
          {latestReport && (
            <button
              onClick={() => setReport(latestReport)}
              className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              <FileText className="h-4 w-4" />
              打开背调报告
            </button>
          )}
          {lead.contactEmail && canWrite && (
            <Link
              href={`/emails/send?leadId=${lead.id}`}
              className="inline-flex items-center gap-2 rounded-lg border border-blue-300 px-3 py-2 text-sm font-medium text-blue-700 hover:bg-blue-50 dark:border-blue-800 dark:text-blue-300 dark:hover:bg-blue-900/20"
            >
              <Send className="h-4 w-4" />
              写邮件
            </Link>
          )}
          {canWrite && (
            <Link
              href={`/leads/${lead.id}/edit`}
              className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              <Pencil className="h-4 w-4" />
              编辑
            </Link>
          )}
          {canWrite && (
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="inline-flex items-center gap-2 rounded-lg border border-red-300 px-3 py-2 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50 dark:border-red-800 dark:text-red-300 dark:hover:bg-red-900/20"
            >
              {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              删除
            </button>
          )}
        </div>
      </div>

      {researchReports.length > 0 && (
        <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
          <h3 className="mb-2 text-sm font-semibold text-gray-700 dark:text-gray-300">报告存档 ({researchReports.length})</h3>
          <div className="flex flex-wrap gap-2">
            {researchReports.map((r) => (
              <button key={r.id} onClick={() => loadHistoricalReport(r.id)}
                className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800">
                <span className="font-medium text-gray-700 dark:text-gray-300">{r.type === 'full' ? '深度背调' : r.type === 'contacts' ? '联系人' : '市场'}</span>
                <span className="ml-2 text-gray-400">{new Date(r.createdAt).toLocaleDateString('zh-CN')}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
          {error}
        </div>
      )}

      <div className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
        <div className="flex flex-wrap items-center gap-4">
          <span className={`rounded-full px-3 py-1 text-xs font-medium ${STATUS_COLORS[lead.status] || 'bg-gray-100 text-gray-700'}`}>
            {t(`leads.stages.${lead.status}`)}
          </span>
          {lead.leadGrade && (
            <span className="text-sm text-gray-600 dark:text-gray-400">
              评分：<strong className="text-gray-900 dark:text-white">{lead.leadGrade}</strong>
              {lead.leadScore !== undefined ? ` (${lead.leadScore})` : ''}
            </span>
          )}
          {lead.confidenceScore !== undefined && (
            <span className="text-sm text-gray-600 dark:text-gray-400">可信度：{lead.confidenceScore}%</span>
          )}
          <div className="flex-1" />
          {canWrite && (
            <div className="flex items-center gap-2">
              <select
                value={status}
                onChange={(event) => setStatus(event.target.value)}
                className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-900 dark:text-white"
              >
                {LEAD_STAGES.map((stage) => (
                  <option key={stage} value={stage}>
                    {t(`leads.stages.${stage}`)}
                  </option>
                ))}
              </select>
              <button
                onClick={handleStatusChange}
                disabled={savingStatus || status === lead.status}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {savingStatus ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                更新状态
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel title="公司信息" icon={<Building2 className="h-5 w-5 text-gray-400" />}>
          <InfoRow label="公司名称" value={lead.companyName} />
          <InfoRow label="网站" value={lead.website} link />
          <InfoRow label="域名" value={lead.websiteDomain} />
          <InfoRow label="国家/地区" value={[lead.country, lead.city].filter(Boolean).join(' / ')} />
          <div className="flex items-center justify-between py-1.5">
            <span className="text-sm text-gray-500">客户语言</span>
            {lead.language ? (
              <LanguageBadge language={lead.language} size="md" showNative />
            ) : (
              <span className="text-sm text-gray-400">未设置</span>
            )}
          </div>
          <div className="mt-1">
            <LanguageSelector
              value={lead.language}
              onChange={handleLanguageChange}
              size="sm"
            />
            {savingLanguage && <span className="text-[10px] text-gray-400 ml-2">保存中...</span>}
          </div>
          <InfoRow label="行业" value={lead.industry} />
          <InfoRow label="客户画像" value={lead.productCategory} />
          <InfoRow label="业务类型" value={lead.businessType} />
          <InfoRow label="成立年份" value={lead.yearEstablished?.toString()} />
          <InfoRow label="员工规模" value={lead.employeeCount} />
          <InfoRow label="年营收" value={lead.annualRevenue} />
          <InfoRow label="主营产品" value={lead.mainProducts} multiline />
        </Panel>

        <Panel title="联系人信息" icon={<Mail className="h-5 w-5 text-gray-400" />}>
          <InfoRow label="主要联系人" value={lead.contactName} />
          <InfoRow label="职位" value={lead.contactTitle} />
          <InfoRow label="邮箱" value={lead.contactEmail} mail />
          <InfoRow label="电话" value={lead.contactPhone} />
          <InfoRow label="WhatsApp" value={lead.whatsapp} />
          <InfoRow label="LinkedIn" value={lead.linkedinUrl} link />
          <InfoRow label="Facebook" value={lead.facebookUrl} link />
          <InfoRow label="Instagram" value={lead.instagramUrl} link />
        </Panel>

        <Panel title="品牌联系人" icon={<Users className="h-5 w-5 text-gray-400" />}>
          {lead.contacts?.length ? (
            <div className="space-y-3">
              {lead.contacts.map((contact) => {
                const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ') || '未命名联系人';
                return (
                  <div key={contact.id} className="rounded-lg border border-gray-100 p-3 text-sm dark:border-gray-800">
                    <div className="flex items-center justify-between gap-2">
                      <p className="font-medium text-gray-900 dark:text-white">{name}</p>
                      {contact.isPrimary && <span className="rounded-full bg-blue-50 px-2 py-0.5 text-xs text-blue-700">主联系人</span>}
                    </div>
                    <p className="mt-1 text-gray-500 dark:text-gray-400">{[contact.title, contact.department].filter(Boolean).join(' / ') || '-'}</p>
                    {contact.email && <p className="mt-1 text-gray-600 dark:text-gray-300">{contact.email}</p>}
                    {contact.phone && <p className="mt-1 text-gray-500 dark:text-gray-400">{contact.phone}</p>}
                    {contact.notes && <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">{contact.notes}</p>}
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-gray-500">AI 深挖或导入后，会在这里合并同品牌不同联系人。</p>
          )}
        </Panel>

        <Panel title="开发信息" icon={<CalendarClock className="h-5 w-5 text-gray-400" />}>
          <InfoRow label="来源类型" value={lead.sourceType} />
          <InfoRow label="来源链接" value={lead.sourceUrl} link />
          <InfoRow label="负责人" value={lead.owner ? `${lead.owner.firstName || ''} ${lead.owner.lastName || ''} ${lead.owner.email}`.trim() : undefined} />
          <InfoRow label="最后联系" value={formatDate(lead.lastContactedAt)} />
          <InfoRow label="下次跟进" value={formatDate(lead.nextFollowUpAt)} />
          <InfoRow label="创建时间" value={formatDate(lead.createdAt)} />
          <InfoRow label="更新时间" value={formatDate(lead.updatedAt)} />
        </Panel>
      </div>

      {/* ====== 证据链 & 验证状态（Phase 2 新增） ====== */}
      <Panel title="证据链 & 验证状态" icon={<ShieldCheck className="h-5 w-5 text-gray-400" />}>
        <div className="grid gap-3 md:grid-cols-2">
          {/* 邮箱验证状态 */}
          <div className="rounded-lg border border-gray-100 dark:border-gray-800 p-3">
            <div className="flex items-center gap-2 mb-2">
              {lead.emailVerificationStatus && TRUSTED_VERIFY_LEVELS.includes(lead.emailVerificationStatus) ? (
                <ShieldCheck className="h-4 w-4 text-green-500" />
              ) : lead.emailVerificationStatus === 'failed' ? (
                <ShieldAlert className="h-4 w-4 text-red-500" />
              ) : (
                <ShieldQuestion className="h-4 w-4 text-amber-500" />
              )}
              <span className="text-sm font-medium text-gray-900 dark:text-white">邮箱验证</span>
            </div>
            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${EMAIL_VERIFY_COLORS[lead.emailVerificationStatus || 'unverified'] || ''}`}>
              {EMAIL_VERIFY_ICONS[lead.emailVerificationStatus || 'unverified']} {EMAIL_VERIFY_LABELS[lead.emailVerificationStatus || 'unverified'] || '未验证'}
            </span>
            {lead.emailVerificationReason && (
              <p className="mt-1 text-xs text-gray-500">
                原因：{REJECTION_REASONS[lead.emailVerificationReason] || lead.emailVerificationReason}
              </p>
            )}
          </div>

          {/* 审核状态 */}
          <div className="rounded-lg border border-gray-100 dark:border-gray-800 p-3">
            <div className="text-sm font-medium text-gray-900 dark:text-white mb-2">管线审核</div>
            <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
              lead.reviewStatus === 'approved' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' :
              lead.reviewStatus === 'rejected' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' :
              'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400'
            }`}>
              {lead.reviewStatus === 'approved' ? '✅ 已通过' : lead.reviewStatus === 'rejected' ? '❌ 已拒绝' : '⏳ 待审核'}
            </span>
          </div>

          {/* 数据来源 */}
          <div className="rounded-lg border border-gray-100 dark:border-gray-800 p-3 md:col-span-2">
            <div className="text-sm font-medium text-gray-900 dark:text-white mb-2">数据来源</div>
            <div className="grid gap-2 text-xs md:grid-cols-3">
              <div>
                <span className="text-gray-400">来源类型：</span>
                <span className="text-gray-700 dark:text-gray-300">{lead.sourceType || '-'}</span>
              </div>
              <div>
                <span className="text-gray-400">搜索关键词：</span>
                <span className="text-gray-700 dark:text-gray-300">{lead.sourceKeyword || '-'}</span>
              </div>
              <div>
                <span className="text-gray-400">来源国家：</span>
                <span className="text-gray-700 dark:text-gray-300">{lead.sourceCountry || '-'}</span>
              </div>
              <div className="md:col-span-3">
                <span className="text-gray-400">来源 URL：</span>
                {lead.sourceUrl ? (
                  <a href={lead.sourceUrl.startsWith('http') ? lead.sourceUrl : `https://${lead.sourceUrl}`} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline inline-flex items-center gap-1">
                    {lead.sourceUrl} <ExternalLink className="h-3 w-3" />
                  </a>
                ) : (
                  <span className="text-gray-400">-</span>
                )}
              </div>
            </div>
          </div>

          {/* 数据可信度 */}
          <div className="rounded-lg border border-gray-100 dark:border-gray-800 p-3">
            <div className="text-sm font-medium text-gray-900 dark:text-white mb-2">数据可信度</div>
            <div className="flex items-center gap-3">
              {lead.confidenceScore != null && (
                <div className="flex items-center gap-1">
                  <div className="h-2 w-20 rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
                    <div className={`h-full rounded-full ${lead.confidenceScore >= 80 ? 'bg-green-500' : lead.confidenceScore >= 50 ? 'bg-amber-500' : 'bg-red-500'}`} style={{ width: `${lead.confidenceScore}%` }} />
                  </div>
                  <span className="text-xs font-medium text-gray-700 dark:text-gray-300">{lead.confidenceScore}%</span>
                </div>
              )}
              {lead.isUncertain && (
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 dark:bg-amber-900/20 px-2 py-0.5 text-xs text-amber-700 dark:text-amber-400">
                  <ShieldAlert className="h-3 w-3" />存在不确定字段
                </span>
              )}
            </div>
            {lead.uncertainFields && lead.uncertainFields.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {lead.uncertainFields.map((f) => (
                  <span key={f} className="rounded bg-amber-50 dark:bg-amber-900/10 px-1.5 py-0.5 text-[10px] text-amber-600">{f}</span>
                ))}
              </div>
            )}
          </div>

          {/* 开发建议 */}
          <div className="rounded-lg border border-gray-100 dark:border-gray-800 p-3">
            <div className="text-sm font-medium text-gray-900 dark:text-white mb-2">开发建议</div>
            {lead.emailVerificationStatus && TRUSTED_VERIFY_LEVELS.includes(lead.emailVerificationStatus) && lead.reviewStatus !== 'rejected' ? (
              <p className="text-xs text-green-600 dark:text-green-400">✅ 邮箱已验证，可安全进入自动开发链路</p>
            ) : lead.reviewStatus === 'rejected' ? (
              <p className="text-xs text-red-600 dark:text-red-400">🚫 已拒绝：{REJECTION_REASONS[lead.emailVerificationReason || ''] || lead.emailVerificationReason || '不满足开发条件'}</p>
            ) : (
              <p className="text-xs text-amber-600 dark:text-amber-400">⚠️ 建议人工复核后决定是否开发</p>
            )}
          </div>
        </div>
      </Panel>

      <Panel title="跟进备注" icon={<FileText className="h-5 w-5 text-gray-400" />}>
        <p className="whitespace-pre-wrap text-sm leading-6 text-gray-700 dark:text-gray-300">
          {lead.notes || '暂无备注。AI 深挖完成后，系统会把关键背调结论同步写入这里。'}
        </p>
      </Panel>

      <Panel title="AI 深挖报告存档" icon={<FileText className="h-5 w-5 text-gray-400" />}>
        {lead.deepResearchReports?.length ? (
          <div className="space-y-2">
            {lead.deepResearchReports.map((item) => (
              <button
                key={item.id}
                onClick={() => setReport(getReportPayload(item))}
                className="flex w-full items-center justify-between rounded-lg border border-gray-100 p-3 text-left text-sm hover:bg-gray-50 dark:border-gray-800 dark:hover:bg-gray-900"
              >
                <span>
                  <span className="font-medium text-gray-900 dark:text-white">{item.title}</span>
                  <span className="ml-2 text-xs text-gray-400">{formatDate(item.occurredAt)}</span>
                </span>
                <FileText className="h-4 w-4 text-gray-400" />
              </button>
            ))}
          </div>
        ) : (
          <p className="text-sm text-gray-500">暂无报告。可以使用上方 AI 深度背调、深挖联系人或市场分析生成。</p>
        )}
      </Panel>

      {report && <ReportModal report={report} onClose={() => setReport(null)} />}
    </div>
  );
}

function BackLink() {
  return (
    <Link href="/leads" className="inline-flex items-center gap-1 rounded-lg p-2 text-sm text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800">
      <ArrowLeft className="h-5 w-5" />
      返回
    </Link>
  );
}

function Panel({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-950">
      <h3 className="mb-4 flex items-center gap-2 text-lg font-semibold text-gray-900 dark:text-white">
        {icon}
        {title}
      </h3>
      {children}
    </section>
  );
}

function InfoRow({
  label,
  value,
  link,
  mail,
  multiline,
}: {
  label: string;
  value?: string;
  link?: boolean;
  mail?: boolean;
  multiline?: boolean;
}) {
  const display = value || '-';
  return (
    <div className="grid grid-cols-[112px_1fr] gap-3 border-b border-gray-100 py-2 last:border-0 dark:border-gray-800">
      <span className="text-sm text-gray-500 dark:text-gray-400">{label}</span>
      <span className={`text-sm text-gray-900 dark:text-gray-100 ${multiline ? 'whitespace-pre-wrap leading-6' : 'break-words'}`}>
        {link && value ? (
          <a href={value.startsWith('http') ? value : `https://${value}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-blue-600 hover:underline">
            {value}
            <ExternalLink className="h-3 w-3" />
          </a>
        ) : mail && value ? (
          <a href={`mailto:${value}`} className="inline-flex items-center gap-1 text-blue-600 hover:underline">
            <Mail className="h-3 w-3" />
            {value}
          </a>
        ) : (
          display
        )}
      </span>
    </div>
  );
}

function ReportModal({ report, onClose }: { report: any; onClose: () => void }) {
  const sections = Object.entries(report || {});
  const html = typeof report?.html === 'string' ? report.html : '';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="max-h-[88vh] w-full max-w-5xl overflow-hidden rounded-xl bg-white shadow-xl dark:bg-gray-950">
        <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4 dark:border-gray-800">
          <div>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">AI 客户深度背调报告</h3>
            <p className="mt-1 text-xs text-gray-500">未确认信息会在报告中标记为 unconfirmed，避免 AI 幻觉直接进入客户档案。</p>
          </div>
          <button onClick={onClose} className="rounded-lg p-2 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="max-h-[72vh] overflow-y-auto px-6 py-5">
          {html ? (
            <div
              className="prose prose-sm max-w-none text-gray-800 dark:prose-invert dark:text-gray-200"
              dangerouslySetInnerHTML={{ __html: sanitizeRichHtml(html) }}
            />
          ) : sections.length ? (
            <div className="space-y-5">
              {sections.map(([key, value]) => (
                <div key={key} className="rounded-lg border border-gray-100 p-4 dark:border-gray-800">
                  <h4 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">{key}</h4>
                  {typeof value === 'object' && value !== null ? (
                    <div className="space-y-2">
                      {Object.entries(value).map(([childKey, childValue]) => (
                        <div key={childKey} className="grid gap-2 text-sm md:grid-cols-[180px_1fr]">
                          <span className="font-medium text-gray-600 dark:text-gray-400">{childKey}</span>
                          <pre className="whitespace-pre-wrap break-words font-sans text-gray-800 dark:text-gray-200">{renderValue(childValue)}</pre>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="whitespace-pre-wrap text-sm leading-6 text-gray-800 dark:text-gray-200">{renderValue(value)}</p>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-gray-500">暂无报告内容。</p>
          )}
        </div>
      </div>
    </div>
  );
}

function formatDate(value?: string) {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
