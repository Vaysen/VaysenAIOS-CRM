'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import api from '@/lib/api';
import { useAuthStore } from '@/store/authStore';
import { GRADE_COLORS, EMAIL_VERIFY_COLORS, EMAIL_VERIFY_LABELS, EMAIL_VERIFY_ICONS, PIPELINE_COLUMNS, PIPELINE_COLUMN_LABELS, REJECTION_REASONS, TRUSTED_VERIFY_LEVELS } from '@/lib/lead-constants';
import { CalendarClock, ExternalLink, Mail, MousePointer, Reply, Search, Send, ShieldCheck, ShieldAlert, ShieldQuestion, UserPlus, X, ChevronDown, Loader2, Filter } from 'lucide-react';

interface Prospect {
  id: string;
  companyName: string;
  contactName?: string;
  contactEmail?: string;
  country?: string;
  website?: string;
  leadGrade?: string;
  leadScore?: number;
  status: string;
  reviewStatus?: string;
  emailVerificationStatus?: string;
  emailVerificationReason?: string;
  sourceUrl?: string;
  sourceType?: string;
  confidenceScore?: number;
  isUncertain?: boolean;
  uncertainFields?: string[];
  owner?: { id: string; firstName?: string; lastName?: string; email: string };
  emailStats?: {
    sent: number;
    opened: number;
    clicked: number;
    replied: number;
    bounced: number;
    firstSentAt?: string;
    lastSentAt?: string;
    lastSubject?: string;
    lastToEmail?: string;
  };
}

/** 按 evidence 管线分组逻辑 */
function assignPipelineColumn(p: Prospect): 'ready_for_outreach' | 'manual_review' | 'rejected' {
  // 已明确拒绝
  if (p.reviewStatus === 'rejected') return 'rejected';
  // 待审核 → 人工复核
  if (p.reviewStatus === 'pending') return 'manual_review';
  // 邮箱验证失败
  if (p.emailVerificationStatus === 'failed') return 'manual_review';
  // 可开发：邮箱经过可信验证 + 不是 rejected
  if (p.emailVerificationStatus && TRUSTED_VERIFY_LEVELS.includes(p.emailVerificationStatus)) {
    return 'ready_for_outreach';
  }
  // 有不确定标记 → 人工复核
  if (p.isUncertain) return 'manual_review';
  // 完全没有验证状态 → 人工复核
  if (!p.emailVerificationStatus || p.emailVerificationStatus === 'unverified') return 'manual_review';
  // 兜底 → 人工复核
  return 'manual_review';
}

const roundLabels: Record<string, string> = { '0': '0', '1': '1', '2': '2', '3': '3' };

export default function ProspectsPage() {
  const { user } = useAuthStore();
  const [prospects, setProspects] = useState<Prospect[]>([]);
  const [salesUsers, setSalesUsers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [countryFilter, setCountryFilter] = useState('');
  const [hasEmailHistory, setHasEmailHistory] = useState('');
  const [outreachRoundFilter, setOutreachRoundFilter] = useState('0');
  const [engagementFilter, setEngagementFilter] = useState('');
  const [emailVerificationStatusFilter, setEmailVerificationStatusFilter] = useState('');
  const [sourceTypeFilter, setSourceTypeFilter] = useState('');
  const [leadGradeFilter, setLeadGradeFilter] = useState('');
  const [ownerUserId, setOwnerUserId] = useState('');
  const [showOwnerFilter, setShowOwnerFilter] = useState(false);
  const [displayTimeZone, setDisplayTimeZone] = useState('Asia/Shanghai');
  const [page, setPage] = useState(1);
  const [meta, setMeta] = useState({ total: 0, totalPages: 0 });
  const [error, setError] = useState('');
  const [promotingId, setPromotingId] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [selectedProspect, setSelectedProspect] = useState<Prospect | null>(null);

  const fetchProspects = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.get('/leads', {
        params: {
          page,
          limit: 60,
          status: 'prospect_pool',
          search: search || undefined,
          country: countryFilter || undefined,
          hasEmailHistory: hasEmailHistory || undefined,
          outreachRound: outreachRoundFilter || undefined,
          engagement: engagementFilter || undefined,
          emailVerificationStatus: emailVerificationStatusFilter || undefined,
          sourceType: sourceTypeFilter || undefined,
          leadGrade: leadGradeFilter || undefined,
          ownerUserId: ownerUserId || undefined,
          sortBy: 'score',
        },
      });
      setProspects(res.data.data || []);
      setMeta(res.data.meta || { total: 0, totalPages: 0 });
    } catch (err: any) {
      setError(err.response?.data?.message || '开发池加载失败');
    } finally {
      setLoading(false);
    }
  }, [page, search, countryFilter, hasEmailHistory, outreachRoundFilter, engagementFilter, emailVerificationStatusFilter, sourceTypeFilter, leadGradeFilter, ownerUserId]);

  useEffect(() => { fetchProspects(); }, [fetchProspects]);

  useEffect(() => {
    const companyId = user?.companies?.[0]?.id;
    const canViewOthers = user?.companies?.some((c: any) => ['super_admin', 'company_admin', 'sales_manager'].includes(c.role));
    if (!companyId || !canViewOthers) return;
    api.get(`/companies/${companyId}/users`)
      .then((res) => setSalesUsers(res.data.data || []))
      .catch(() => setSalesUsers([]));
  }, [user]);

  const visibleProspects = useMemo(() => {
    return prospects.filter((p) => {
      const sent = p.emailStats?.sent || 0;
      const round = String(Math.min(sent, 3));
      if (outreachRoundFilter && round !== outreachRoundFilter) return false;
      if (engagementFilter === 'opened' && !(p.emailStats?.opened || 0)) return false;
      if (engagementFilter === 'clicked' && !(p.emailStats?.clicked || 0)) return false;
      if (engagementFilter === 'replied' && !(p.emailStats?.replied || 0)) return false;
      return true;
    });
  }, [engagementFilter, outreachRoundFilter, prospects]);

  /** 三栏分组 */
  const pipeline = useMemo(() => {
    const columns: Record<string, Prospect[]> = { ready_for_outreach: [], manual_review: [], rejected: [] };
    visibleProspects.forEach((p) => {
      const col = assignPipelineColumn(p);
      columns[col].push(p);
    });
    return columns;
  }, [visibleProspects]);

  const summary = useMemo(() => {
    return {
      total: visibleProspects.length,
      ready: pipeline.ready_for_outreach.length,
      review: pipeline.manual_review.length,
      rejected: pipeline.rejected.length,
      sent: visibleProspects.filter((p) => (p.emailStats?.sent || 0) > 0).length,
      replied: visibleProspects.filter((p) => (p.emailStats?.replied || 0) > 0).length,
    };
  }, [visibleProspects, pipeline]);

  const promoteToCustomer = async (id: string) => {
    if (!confirm('确认将该客户转入客户管理？')) return;
    setPromotingId(id);
    try {
      await api.patch(`/leads/${id}/status`, { status: 'new' });
      await fetchProspects();
    } catch (err: any) {
      setError(err.response?.data?.message || '转入客户管理失败');
    } finally {
      setPromotingId('');
    }
  };

  const formatSentTime = (value?: string) => {
    if (!value) return '-';
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: displayTimeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value));
  };

  const buildSendHref = useCallback((leadId?: string) => {
    const params = new URLSearchParams({ source: 'prospects' });
    if (leadId) params.set('leadId', leadId);
    if (search) params.set('search', search);
    if (countryFilter) params.set('country', countryFilter);
    if (hasEmailHistory) params.set('hasEmailHistory', hasEmailHistory);
    if (outreachRoundFilter) params.set('outreachRound', outreachRoundFilter);
    if (engagementFilter) params.set('engagement', engagementFilter);
    if (engagementFilter === 'replied') params.set('includeReplied', 'true');
    if (emailVerificationStatusFilter) params.set('emailVerificationStatus', emailVerificationStatusFilter);
    if (sourceTypeFilter) params.set('sourceType', sourceTypeFilter);
    if (leadGradeFilter) params.set('leadGrade', leadGradeFilter);
    if (ownerUserId) params.set('ownerUserId', ownerUserId);
    return `/emails/send?${params.toString()}`;
  }, [countryFilter, emailVerificationStatusFilter, engagementFilter, hasEmailHistory, leadGradeFilter, outreachRoundFilter, ownerUserId, search, sourceTypeFilter]);

  const activeFilterCount = [
    countryFilter,
    hasEmailHistory,
    outreachRoundFilter !== '0' ? outreachRoundFilter : '',
    engagementFilter,
    emailVerificationStatusFilter,
    sourceTypeFilter,
    leadGradeFilter,
    ownerUserId,
  ].filter(Boolean).length;

  return (
    <div className="space-y-6">
      {/* 页面顶部 */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">AI获客 · 邮件开发池</h2>
          <p className="text-gray-500 dark:text-gray-400">
            Evidence-first 管线：只有邮箱经过可信验证的客户才出现在「可开发」列。占位号码和无效信息会被自动拦截到「已拒绝」。
          </p>
        </div>
        <Link href={buildSendHref()} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">
          <Send className="h-4 w-4" />
          批量发送开发信
        </Link>
      </div>

      {error && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600">{error}</div>}

      {/* 统计卡片 */}
      <div className="grid gap-4 md:grid-cols-6">
        {[
          ['开发池总数', summary.total, 'text-gray-900'],
          ['可开发', summary.ready, 'text-green-600'],
          ['人工复核', summary.review, 'text-amber-600'],
          ['已拒绝', summary.rejected, 'text-red-600'],
          ['已发过邮件', summary.sent, 'text-blue-600'],
          ['已回复', summary.replied, 'text-emerald-600'],
        ].map(([label, value, color]) => (
          <div key={label as string} className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
            <p className="text-sm text-gray-500">{label as string}</p>
            <p className={`mt-2 text-2xl font-bold ${color} dark:text-white`}>{value as number}</p>
          </div>
        ))}
      </div>

      {/* 搜索 & 筛选 */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-md">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
          <input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="搜索公司名、邮箱、网站..." className="w-full rounded-lg border border-gray-300 bg-white py-2 pl-10 pr-3 text-sm outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-800 dark:text-white" />
        </div>
        <button
          onClick={() => setShowFilters(!showFilters)}
          className={`inline-flex items-center gap-1 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${showFilters || activeFilterCount > 0 ? 'border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-900/20 dark:text-blue-400' : 'border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800'}`}
        >
          <Filter className="h-4 w-4" />筛选{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
        </button>
        <select value={displayTimeZone} onChange={(e) => setDisplayTimeZone(e.target.value)} className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-800 dark:text-white">
          <option value="Asia/Shanghai">中国时间</option>
          <option value="America/New_York">美国东部</option>
          <option value="America/Los_Angeles">美国西部</option>
          <option value="Europe/London">英国</option>
          <option value="Europe/Paris">欧洲中部</option>
          <option value="Australia/Sydney">澳大利亚</option>
        </select>
      </div>

      {showFilters && (
        <div className="flex flex-wrap gap-3 rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
          <input value={countryFilter} onChange={(e) => { setCountryFilter(e.target.value); setPage(1); }} placeholder="国家筛选" className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-800 dark:text-white" />
          <select value={hasEmailHistory} onChange={(e) => { setHasEmailHistory(e.target.value); setPage(1); }} className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-800 dark:text-white">
            <option value="">全部发件状态</option>
            <option value="true">只看已发过</option>
          </select>
          <select value={outreachRoundFilter} onChange={(e) => { setOutreachRoundFilter(e.target.value); setPage(1); }} className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-800 dark:text-white">
            <option value="0">第 0 轮</option>
            <option value="1">第 1 轮</option>
            <option value="2">第 2 轮</option>
            <option value="3">第 3 轮</option>
          </select>
          <select value={engagementFilter} onChange={(e) => { setEngagementFilter(e.target.value); setPage(1); }} className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-800 dark:text-white">
            <option value="">全部互动</option>
            <option value="opened">已打开</option>
            <option value="clicked">已点击</option>
            <option value="replied">已回复</option>
          </select>
          <select value={emailVerificationStatusFilter} onChange={(e) => { setEmailVerificationStatusFilter(e.target.value); setPage(1); }} className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-800 dark:text-white">
            <option value="">全部邮箱验证</option>
            {Object.entries(EMAIL_VERIFY_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
          <input value={sourceTypeFilter} onChange={(e) => { setSourceTypeFilter(e.target.value); setPage(1); }} placeholder="来源类型" className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-800 dark:text-white" />
          <select value={leadGradeFilter} onChange={(e) => { setLeadGradeFilter(e.target.value); setPage(1); }} className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-800 dark:text-white">
            <option value="">全部等级</option>
            <option value="A">A</option>
            <option value="B">B</option>
            <option value="C">C</option>
            <option value="D">D</option>
          </select>
          {salesUsers.length > 0 && (
            <select value={ownerUserId} onChange={(e) => { setOwnerUserId(e.target.value); setPage(1); }} className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-800 dark:text-white">
              <option value="">全部业务员</option>
              {salesUsers.map((item: any) => (
                <option key={item.userId} value={item.userId}>
                  {`${item.user?.firstName || ''} ${item.user?.lastName || ''}`.trim() || item.user?.email}
                </option>
              ))}
            </select>
          )}
          {activeFilterCount > 0 && (
            <button onClick={() => { setCountryFilter(''); setHasEmailHistory(''); setOutreachRoundFilter('0'); setEngagementFilter(''); setEmailVerificationStatusFilter(''); setSourceTypeFilter(''); setLeadGradeFilter(''); setOwnerUserId(''); setPage(1); }} className="text-sm text-red-500 hover:text-red-700 self-center">清除筛选</button>
          )}
        </div>
      )}

      {/* ═══════ 三栏流水线 ═══════ */}
      {loading ? (
        <div className="flex items-center justify-center py-20 text-gray-400"><Loader2 className="mr-2 h-5 w-5 animate-spin" />加载中...</div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          {PIPELINE_COLUMNS.map((col) => {
            const items = pipeline[col.key] || [];
            return (
              <div key={col.key} className={`rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 overflow-hidden flex flex-col ${col.color} border-t-4`}>
                {/* 列头 */}
                <div className={`px-4 py-3 ${col.bg}`}>
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-gray-900 dark:text-white">{col.label}</h3>
                    <span className="rounded-full bg-gray-200 dark:bg-gray-700 px-2 py-0.5 text-xs font-medium text-gray-700 dark:text-gray-300">{items.length}</span>
                  </div>
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{col.description}</p>
                </div>

                {/* 卡片列表 */}
                <div className="flex-1 overflow-y-auto max-h-[70vh] p-2 space-y-2">
                  {items.length === 0 ? (
                    <div className="py-12 text-center text-sm text-gray-400">暂无客户</div>
                  ) : (
                    items.map((p) => {
                      const sent = p.emailStats?.sent || 0;
                      const round = String(Math.min(sent, 3));
                      return (
                        <div
                          key={p.id}
                          className="rounded-lg border border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900/50 p-3 hover:shadow-sm transition-shadow cursor-pointer"
                          onClick={() => setSelectedProspect(p)}
                        >
                          {/* 标题行 */}
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              <Link href={`/leads/${p.id}`} onClick={(e) => e.stopPropagation()} className="font-medium text-sm text-blue-600 dark:text-blue-400 hover:underline truncate block">
                                {p.companyName}
                              </Link>
                              <div className="mt-0.5 flex items-center gap-2 text-xs text-gray-400">
                                <span>{p.country || '-'}</span>
                                {p.website && (
                                  <a href={p.website.startsWith('http') ? p.website : `https://${p.website}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1 hover:text-blue-500">
                                    <ExternalLink className="h-3 w-3" />官网
                                  </a>
                                )}
                              </div>
                            </div>
                            {p.leadGrade && (
                              <span className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${GRADE_COLORS[p.leadGrade] || ''}`}>{p.leadGrade}</span>
                            )}
                          </div>

                          {/* 邮箱 + 验证状态 */}
                          <div className="mt-2 flex items-center gap-2">
                            <span className="text-xs text-gray-600 dark:text-gray-300 truncate flex-1">
                              {p.contactEmail || <span className="text-gray-400 italic">无邮箱</span>}
                            </span>
                            {p.emailVerificationStatus && (
                              <span className={`inline-flex items-center gap-1 shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${EMAIL_VERIFY_COLORS[p.emailVerificationStatus] || ''}`} title={EMAIL_VERIFY_LABELS[p.emailVerificationStatus]}>
                                {EMAIL_VERIFY_ICONS[p.emailVerificationStatus]}{EMAIL_VERIFY_LABELS[p.emailVerificationStatus]}
                              </span>
                            )}
                          </div>

                          {/* 证据来源 + 归属人 */}
                          <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[10px] text-gray-400">
                            {p.owner && (
                              <span className="rounded bg-indigo-50 dark:bg-indigo-900/20 px-1.5 py-0.5 text-indigo-600 font-medium" title={`归属: ${p.owner.firstName || ''} ${p.owner.lastName || ''} (${p.owner.email})`}>
                                👤 {p.owner.firstName || p.owner.email?.split('@')[0]}
                              </span>
                            )}
                            {p.sourceType && <span className="rounded bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5">📌 {p.sourceType}</span>}
                            {p.confidenceScore != null && <span className="rounded bg-blue-50 dark:bg-blue-900/20 px-1.5 py-0.5 text-blue-600">匹配 {p.confidenceScore}%</span>}
                            {p.isUncertain && <span className="rounded bg-amber-50 dark:bg-amber-900/20 px-1.5 py-0.5 text-amber-600">⚠️ 待确认</span>}
                          </div>

                          {/* 拒绝原因（仅已拒绝列） */}
                          {col.key === 'rejected' && p.emailVerificationReason && (
                            <div className="mt-2 rounded bg-red-50 dark:bg-red-900/10 px-2 py-1 text-xs text-red-600 dark:text-red-400">
                              🚫 {REJECTION_REASONS[p.emailVerificationReason] || p.emailVerificationReason}
                            </div>
                          )}

                          {/* 互动数据 */}
                          <div className="mt-2 flex items-center justify-between border-t border-gray-100 dark:border-gray-800 pt-2">
                            <div className="flex items-center gap-2 text-xs text-gray-500">
                              <span className="inline-flex items-center gap-1"><Mail className="h-3 w-3" />{p.emailStats?.opened || 0}</span>
                              <span className="inline-flex items-center gap-1 text-blue-500"><MousePointer className="h-3 w-3" />{p.emailStats?.clicked || 0}</span>
                              <span className="inline-flex items-center gap-1 text-green-600"><Reply className="h-3 w-3" />{p.emailStats?.replied || 0}</span>
                            </div>
                            <div className="flex items-center gap-1">
                              <span className="rounded-full bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 text-[10px] text-gray-600">第{roundLabels[round]}轮</span>
                              <button
                                onClick={(e) => { e.stopPropagation(); promoteToCustomer(p.id); }}
                                disabled={promotingId === p.id}
                                className="rounded p-1 text-gray-400 hover:bg-green-50 hover:text-green-600 disabled:opacity-50"
                                title="转入客户管理"
                              >
                                <UserPlus className="h-3.5 w-3.5" />
                              </button>
                              <Link href={buildSendHref(p.id)} onClick={(e) => e.stopPropagation()} className="rounded p-1 text-gray-400 hover:bg-blue-50 hover:text-blue-600" title="发送邮件">
                                <Send className="h-3.5 w-3.5" />
                              </Link>
                            </div>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 详情弹窗 */}
      {selectedProspect && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setSelectedProspect(null)}>
          <div className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-gray-200 bg-white p-6 shadow-xl dark:border-gray-800 dark:bg-gray-950" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-start justify-between">
              <div>
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{selectedProspect.companyName}</h3>
                <p className="text-sm text-gray-500">{selectedProspect.country} · {selectedProspect.leadGrade || '未评分'}</p>
              </div>
              <button onClick={() => setSelectedProspect(null)} className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="grid gap-3 text-sm md:grid-cols-2">
              <DetailRow label="邮箱" value={selectedProspect.contactEmail} />
              <DetailRow label="验证状态" value={selectedProspect.emailVerificationStatus ? `${EMAIL_VERIFY_ICONS[selectedProspect.emailVerificationStatus]} ${EMAIL_VERIFY_LABELS[selectedProspect.emailVerificationStatus]}` : '未验证'} />
              <DetailRow label="验证原因" value={selectedProspect.emailVerificationReason ? REJECTION_REASONS[selectedProspect.emailVerificationReason] || selectedProspect.emailVerificationReason : '-'} />
              <DetailRow label="来源类型" value={selectedProspect.sourceType || '-'} />
              <DetailRow label="来源 URL" value={selectedProspect.sourceUrl || '-'} link />
              <DetailRow label="数据可信度" value={selectedProspect.confidenceScore != null ? `${selectedProspect.confidenceScore}%` : '-'} />
              <DetailRow label="是否有不确定字段" value={selectedProspect.isUncertain ? `⚠️ 是 (${(selectedProspect.uncertainFields || []).join(', ')})` : '否'} />
              <DetailRow label="管线位置" value={PIPELINE_COLUMN_LABELS[assignPipelineColumn(selectedProspect)]} />
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Link href={`/leads/${selectedProspect.id}`} className="rounded-lg border border-gray-300 px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800">查看完整档案</Link>
              <button onClick={() => { promoteToCustomer(selectedProspect.id); setSelectedProspect(null); }} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">转入客户管理</button>
            </div>
          </div>
        </div>
      )}

      {/* 翻页 */}
      {meta.totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-gray-500">
          <span>共 {meta.total} 条</span>
          <div className="flex gap-2">
            <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="rounded border px-3 py-1 disabled:opacity-50">上一页</button>
            <button disabled={page >= meta.totalPages} onClick={() => setPage((p) => p + 1)} className="rounded border px-3 py-1 disabled:opacity-50">下一页</button>
          </div>
        </div>
      )}
    </div>
  );
}

function DetailRow({ label, value, link }: { label: string; value?: string; link?: boolean }) {
  return (
    <div className="rounded-lg bg-gray-50 dark:bg-gray-900 p-3">
      <div className="text-xs text-gray-400">{label}</div>
      <div className="mt-1 break-words text-gray-800 dark:text-gray-200">
        {link && value ? (
          <a href={value.startsWith('http') ? value : `https://${value}`} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline inline-flex items-center gap-1">
            {value} <ExternalLink className="h-3 w-3" />
          </a>
        ) : value || '-'}
      </div>
    </div>
  );
}
