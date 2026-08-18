'use client';

import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import api from '@/lib/api';
import { Card } from '@/components/ui/card';
import {
  MapPin, Mail, Phone, MessageSquare, FileText, Clock, Users, Building2, ArrowLeft,
  Tag, Pin, X, Star, Globe, ChevronDown, ChevronRight, Sparkles, Calendar,
  TrendingUp, BarChart3, ClipboardList, FileCheck, Package, Briefcase, Activity,
  ExternalLink, MoreHorizontal, Edit3, MessageCircle, Send, Paperclip, Filter,
  Plus, Loader2, Bot, History, FileClock
} from 'lucide-react';
import { useCustomerAsset } from '@/features/customer-assets/hooks/use-customer-asset';
import {
  ContactSelector,
  ContactChannelList,
  ContactEmptyState,
  CustomerIdentityHeader,
  IdentityMergeReviewBanner,
  MergeDiffDialog,
} from '@/features/customer-assets/components';
import { useCustomerMerge } from '@/features/customer-assets/hooks/use-customer-merge';
import { formatContactName } from '@/features/customer-assets/domain/customer-links';
import { formatQuoteDate, type QuoteLeadHistoryItem } from '@/types/quote';
import { formatOpportunityAmount, formatOpportunityDate, OPPORTUNITY_STAGE_LABELS, type Opportunity, type OpportunityListResponse } from '@/types/opportunity';
import { getCustomerWorkspace, getCustomerWorkspaceAudit, getCustomerWorkspaceMessage } from '@/lib/customer-workspace-api';
import type { CustomerWorkspaceMessage, CustomerWorkspaceSummary } from '@/types/customer-workspace';
import { CustomerSalesCopilot } from '@/components/customers/customer-sales-copilot';

const STAGE_OPTIONS = [
  { key: 'new', label: '新客户' }, { key: 'contacted', label: '已联系' },
  { key: 'sampling', label: '样品中' }, { key: 'quoting', label: '报价中' },
  { key: 'negotiating', label: '谈判中' }, { key: 'won', label: '已成交' }, { key: 'lost', label: '暂停/无效' },
];

const TABS = [
  { key: 'activity', label: '动态', icon: Activity },
  { key: 'profile', label: '资料', icon: Users },
  { key: 'deals', label: '商机与交易', icon: TrendingUp },
  { key: 'tips', label: '风险与行动建议', icon: Sparkles },
  { key: 'research', label: 'AI 背调', icon: Bot },
  { key: 'docs', label: '文档', icon: FileText },
  { key: 'history', label: '操作历史', icon: History },
] as const;

type TabKey = typeof TABS[number]['key'];

/** 客户详情数据 */
interface LeadDetail {
  id: string;
  companyName: string;
  contactName: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  country?: string | null;
  website?: string | null;
  leadName?: string;
  status: string;
  leadGrade?: string;
  language?: string;
  sourceType?: string;
  isPinned?: boolean;
  tags?: Array<{ id?: string; tagId?: string; tag?: { displayName?: string; name?: string; id?: string } }>;
  profileSummary?: { hasTrustedIdentity?: boolean };
  owner?: { firstName?: string; email?: string };
  lastContactedAt?: string;
  nextFollowUpAt?: string;
  createdAt?: string;
  updatedAt?: string;
  notes?: string;
}

/** 活动时间线条目 */
interface ActivityItem {
  id: string;
  title: string;
  description?: string;
  occurredAt: string;
  type?: string;
  activityType?: string;
  attachmentName?: string;
}

export default function CustomerDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [lead, setLead] = useState<LeadDetail | null>(null);
  const [activities, setActivities] = useState<ActivityItem[]>([]);
  const [communication, setCommunication] = useState<Record<string, unknown>[]>([]);
  const [quotes, setQuotes] = useState<QuoteLeadHistoryItem[]>([]);
  const [opportunities, setOpportunities] = useState<Opportunity[]>([]);
  const [opportunityLoading, setOpportunityLoading] = useState(true);
  const [opportunityError, setOpportunityError] = useState<string | null>(null);
  const [availableTags, setAvailableTags] = useState<Record<string, unknown>[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<TabKey>('profile');
  const [activityFilter, setActivityFilter] = useState<string>('all');
  const [followupInput, setFollowupInput] = useState('');
  const [workspace, setWorkspace] = useState<CustomerWorkspaceSummary | null>(null);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [messageBodies, setMessageBodies] = useState<Record<string, CustomerWorkspaceMessage>>({});
  const [messageLoading, setMessageLoading] = useState<string | null>(null);
  const [auditRows, setAuditRows] = useState<Array<{ id: string; action: string; actorName?: string | null; createdAt: string; summary?: string | null }>>([]);
  const [auditLoading, setAuditLoading] = useState(false);

  // 多联系人选中状态
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null);

  // 使用 useCustomerAsset hook 加载客户资产
  const { data: customerAsset, loading: assetLoading, error: assetError, refetch: refetchAsset } = useCustomerAsset(id);

  // 合并审核 hook
  const mergeHook = useCustomerMerge();
  const [mergeDialogOpen, setMergeDialogOpen] = useState(false);

  // Collapse states for profile sections
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(new Set());
  const toggleSection = (key: string) => {
    setCollapsedSections(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const loadLead = useCallback(async () => {
    const [leadRes, activityRes, tagRes] = await Promise.allSettled([
      api.get(`/leads/${id}`),
      api.get(`/leads/${id}/timeline`, { params: { limit: 50 } }),
      api.get('/tags'),
    ]);
    if (leadRes.status === 'fulfilled') setLead(leadRes.value.data);
    if (activityRes.status === 'fulfilled') setActivities(activityRes.value.data?.data || []);
    if (tagRes.status === 'fulfilled') {
      const tagsData = tagRes.value.data?.data || tagRes.value.data || [];
      setAvailableTags(Array.isArray(tagsData) ? tagsData : []);
    }

    try {
      const [commRes, quoteRes, opportunityRes] = await Promise.allSettled([
        api.get('/communications/conversations', { params: { leadId: id } }),
        api.get<QuoteLeadHistoryItem[]>(`/quotes/lead/${id}`),
        api.get<OpportunityListResponse>('/opportunities', { params: { leadId: id, page: 1, limit: 100 } }),
      ]);
      if (commRes.status === 'fulfilled') setCommunication(commRes.value.data?.data || []);
      if (quoteRes.status === 'fulfilled') setQuotes(quoteRes.value.data || []);
      if (opportunityRes.status === 'fulfilled') { setOpportunities(opportunityRes.value.data?.data || []); setOpportunityError(null); }
      else setOpportunityError('商机加载失败，请重试。');
    } catch (error) {
      console.warn('[customer-detail] optional asset requests failed', error);
      setOpportunityError('商机加载失败，请重试。');
    } finally {
      setOpportunityLoading(false);
    }
  }, [id]);

  useEffect(() => { let c = false; loadLead().finally(() => { if (!c) setLoading(false); }); return () => { c = true; }; }, [loadLead]);

  useEffect(() => {
    let cancelled = false;
    setWorkspaceError(null);
    void getCustomerWorkspace(id).then((result) => {
      if (!cancelled) setWorkspace(result);
    }).catch((cause) => {
      if (!cancelled) setWorkspaceError(cause instanceof Error ? cause.message : '客户 360 聚合加载失败');
    });
    return () => { cancelled = true; };
  }, [id]);

  const openMessage = useCallback(async (messageId: string) => {
    if (messageBodies[messageId]) return;
    setMessageLoading(messageId);
    try {
      const message = await getCustomerWorkspaceMessage(id, messageId);
      setMessageBodies((previous) => ({ ...previous, [messageId]: message }));
    } catch (cause) {
      setWorkspaceError(cause instanceof Error ? cause.message : '消息正文加载失败');
    } finally { setMessageLoading(null); }
  }, [id, messageBodies]);

  useEffect(() => {
    if (tab !== 'history') return;
    setAuditLoading(true);
    void getCustomerWorkspaceAudit(id).then((result) => setAuditRows(result.data)).catch(() => setAuditRows([])).finally(() => setAuditLoading(false));
  }, [id, tab]);

  // 同步 customerAsset 的 selectedContactId
  useEffect(() => {
    if (customerAsset) {
      setSelectedContactId(customerAsset.selectedContactId ?? customerAsset.contacts[0]?.id ?? null);
    }
  }, [customerAsset]);

  const changeStage = async (newStatus: string) => {
    await api.patch(`/leads/${id}/status`, { status: newStatus });
    setLead((prev) => prev ? { ...prev, status: newStatus } : prev);
  };

  const togglePin = async () => {
    try {
      if (lead?.isPinned) {
        await api.delete(`/leads/${id}/pin`);
        setLead((prev) => prev ? { ...prev, isPinned: false } : prev);
      } else {
        await api.put(`/leads/${id}/pin`);
        setLead((prev) => prev ? { ...prev, isPinned: true } : prev);
      }
    } catch (error) {
      console.warn('[customer-detail] pin update failed', error);
    }
  };

  const addTag = async (tagId: string) => {
    try { await api.post(`/leads/${id}/tags`, { tagIds: [tagId] }); loadLead(); } catch (error) { console.warn('[customer-detail] add tag failed', error); }
  };

  const removeTag = async (tagId: string) => {
    try { await api.delete(`/leads/${id}/tags/${tagId}`); loadLead(); } catch (error) { console.warn('[customer-detail] remove tag failed', error); }
  };

  // 合并审核回调
  const handleReviewCandidate = useCallback(async (candidateId: string) => {
    await mergeHook.loadPreview(candidateId);
    setMergeDialogOpen(true);
  }, [mergeHook]);

  const handleMergeAll = useCallback(async () => {
    if (!mergeHook.preview) return;
    const result = await mergeHook.doMerge(mergeHook.preview.candidateId);
    if (result) {
      setMergeDialogOpen(false);
      refetchAsset();
    }
  }, [mergeHook, refetchAsset]);

  const handleMergeChoices = useCallback(async (adoptFields: string[]) => {
    if (!mergeHook.preview) return;
    const result = await mergeHook.doMerge(mergeHook.preview.candidateId, adoptFields);
    if (result) {
      setMergeDialogOpen(false);
      refetchAsset();
    }
  }, [mergeHook, refetchAsset]);

  const handleReject = useCallback(async () => {
    if (!mergeHook.preview) return;
    const ok = await mergeHook.doReject(mergeHook.preview.candidateId);
    if (ok) {
      setMergeDialogOpen(false);
      refetchAsset();
    }
  }, [mergeHook, refetchAsset]);

  // Activity filtering
  const filteredActivities = activities.filter((a) => {
    if (activityFilter === 'all') return true;
    if (activityFilter === 'email') return (a.title as string)?.includes('邮件') || a.type === 'email';
    if (activityFilter === 'ai') return a.title?.includes('AI') || a.type?.startsWith('ai_');
    return true;
  });

  // Group activities by date
  const groupedActivities = filteredActivities.reduce((groups: Record<string, ActivityItem[]>, a) => {
    const date = new Date(a.occurredAt).toLocaleDateString('zh-CN');
    if (!groups[date]) groups[date] = [];
    groups[date].push(a);
    return groups;
  }, {});

  if (loading || assetLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!lead) {
    return (
      <div className="p-6">
        <Link href="/customers" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-4">
          <ArrowLeft className="w-3.5 h-3.5" /> 返回客户列表
        </Link>
        <p className="text-sm text-gray-500">客户未找到。</p>
      </div>
    );
  }

  const companyName = (lead.companyName || lead.leadName || 'Unknown') as string;
  const companyInitial = companyName.charAt(0).toUpperCase();
  const selectedContact = customerAsset?.contacts.find(c => c.id === selectedContactId) ?? customerAsset?.contacts[0] ?? null;
  const primaryContact = customerAsset?.contacts.find(contact => contact.isPrimary) || customerAsset?.contacts[0];
  const primaryEmail = primaryContact?.contactPoints.find(point => point.type === 'email' || point.type === 'business_email');
  const primaryPhone = primaryContact?.contactPoints.find(point => point.type === 'phone' || point.type === 'whatsapp');
  const displayContactName = lead.contactName || primaryContact?.displayName || [primaryContact?.firstName, primaryContact?.lastName].filter(Boolean).join(' ');
  const displayEmail = lead.contactEmail || primaryEmail?.normalizedValue || primaryEmail?.originalValue;
  const displayPhone = lead.contactPhone || primaryPhone?.normalizedValue || primaryPhone?.originalValue;
  const identityStatus = lead.profileSummary?.hasTrustedIdentity === true
    ? { label: '已验证身份', detail: '已有可信联系方式锚点', dot: 'bg-emerald-500', text: 'text-emerald-700' }
    : lead.profileSummary?.hasTrustedIdentity === false
      ? { label: '未验证身份', detail: '尚未建立已验证身份锚点', dot: 'bg-amber-500', text: 'text-amber-700' }
      : (customerAsset?.contacts.length || displayPhone || displayEmail)
        ? { label: '身份状态未知', detail: '已有联系方式，但验证状态不可用', dot: 'bg-slate-400', text: 'text-slate-600' }
        : { label: '暂无身份数据', detail: '暂无可用身份或联系方式数据', dot: 'bg-slate-300', text: 'text-slate-500' };

  return (
    <div className="mx-auto w-full min-w-0 max-w-5xl space-y-0 overflow-x-hidden">
      {assetError && (
        <div className="mb-3 flex items-center justify-between gap-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          <span>客户资产关联加载失败：{assetError}</span>
          <button type="button" onClick={() => refetchAsset()} className="shrink-0 rounded border border-red-300 bg-white px-2 py-1 hover:bg-red-100">重试</button>
        </div>
      )}
      {workspaceError && (
        <div role="alert" className="mb-3 flex items-center justify-between gap-3 rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <span>{workspaceError}</span>
          <button type="button" onClick={() => { setWorkspaceError(null); void getCustomerWorkspace(id).then(setWorkspace).catch(() => setWorkspaceError('客户 360 聚合加载失败')); }} className="shrink-0 rounded border border-amber-300 bg-white px-2 py-1">重试</button>
        </div>
      )}
      <CustomerSalesCopilot customerId={String(id)} customerName={lead?.companyName || lead?.leadName || '当前客户'} />
      {/* ======== Header ======== */}
      <div className="bg-white rounded-lg border p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3 flex-1 min-w-0">
            {/* Avatar */}
            <div className="w-10 h-10 rounded-full bg-blue-500 text-white flex items-center justify-center font-bold text-sm shrink-0">
              {companyInitial}
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-base font-bold text-gray-900 truncate">
                  {companyName}
                </h1>
                <button aria-label="置顶客户" onClick={togglePin} className={`rounded p-0.5 ${lead?.isPinned ? 'text-amber-500' : 'text-gray-300 hover:text-gray-500'}`}>
                  <Pin className="w-3.5 h-3.5" fill={lead?.isPinned ? 'currentColor' : 'none'} />
                </button>
                <button aria-label="收藏客户" className="rounded p-0.5 text-gray-300 hover:text-gray-500">
                  <Star className="w-3.5 h-3.5" />
                </button>
              </div>

              {/* Meta tags */}
              <div className="flex flex-wrap items-center gap-1.5 mt-1 text-[11px] text-gray-500">
                <span>编号: {String(lead.id).slice(0, 8)}</span>
                {lead.country && (
                  <span className="flex items-center gap-0.5">
                    <MapPin className="w-3 h-3" />{lead.country as string}
                  </span>
                )}
                {lead.contactName && <span>{lead.contactName}</span>}
                <span>跟进人: <span className="text-blue-600">{lead.owner?.firstName || lead.owner?.email?.split('@')[0] || '—'}</span></span>
              </div>

              {/* Stage + Grade + Tags */}
              <div className="flex flex-wrap items-center gap-2 mt-2">
                <select
                  value={lead.status || 'new'}
                  onChange={(e) => changeStage(e.target.value)}
                  className="text-[11px] border rounded px-2 py-1 bg-white"
                >
                  {STAGE_OPTIONS.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
                </select>
                {lead.leadGrade && (
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                    lead.leadGrade === 'A' ? 'bg-green-100 text-green-700' :
                    lead.leadGrade === 'B' ? 'bg-blue-100 text-blue-700' :
                    'bg-gray-100 text-gray-600'
                  }`}>
                    {lead.leadGrade}级
                  </span>
                )}
                {(lead.tags || []).map((t) => (
                  <span key={(t.id || t.tagId) as string} className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded-full border bg-gray-50">
                    <Tag className="w-2.5 h-2.5" />{t.tag?.displayName || t.tag?.name || '标签'}
                    <button aria-label="移除客户标签" onClick={() => { const tagId = t.tagId || t.tag?.id; if (tagId) removeTag(tagId); }} className="text-gray-400 hover:text-red-500"><X className="w-2.5 h-2.5" /></button>
                  </span>
                ))}
                {availableTags.filter((t) => !(lead.tags || []).some((lt) => (lt.tagId || lt.tag?.id) === t.id)).length > 0 && (
                  <select onChange={(e) => { if (e.target.value) addTag(e.target.value); e.target.value = ''; }} className="text-[10px] border rounded px-1.5 py-1 bg-white text-gray-400">
                    <option value="">+ 标签</option>
                    {availableTags.filter((t) => !(lead.tags || []).some((lt) => (lt.tagId || lt.tag?.id) === t.id)).map((t) => (
                      <option key={t.id as string} value={t.id as string}>{(t.displayName || t.name) as string}</option>
                    ))}
                  </select>
                )}
              </div>
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex shrink-0 items-center gap-1 text-gray-400">
            <Link href={`/communication?leadId=${encodeURIComponent(String(id))}&phone=${encodeURIComponent(lead?.contactPhone || '')}&channel=whatsapp`} aria-label="发消息" className="rounded p-1.5 hover:bg-blue-50 hover:text-blue-500" title="发消息">
              <MessageCircle className="w-4 h-4" />
            </Link>
            <button aria-label="发邮件" className="rounded p-1.5 hover:bg-blue-50 hover:text-blue-500" title="发邮件">
              <Send className="w-4 h-4" />
            </button>
            <button aria-label="更多客户操作" className="rounded p-1.5 hover:bg-gray-50 hover:text-gray-600" title="更多">
              <MoreHorizontal className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      <div
        className="flex min-w-0 flex-wrap items-center gap-2 border-x border-b bg-slate-50 px-4 py-2 text-[11px] text-slate-600"
        data-testid="customer-identity-status"
      >
        <span className={`h-2 w-2 rounded-full ${identityStatus.dot}`} aria-hidden="true" />
        <span className={`font-medium ${identityStatus.text}`}>身份状态：{identityStatus.label}</span>
        <span className="text-slate-400">{identityStatus.detail}</span>
      </div>

      {/* ======== 待审核候选横幅 ======== */}
      {customerAsset && customerAsset.pendingMatchCount > 0 && (
        <IdentityMergeReviewBanner
          pendingMatchCount={customerAsset.pendingMatchCount}
          pendingCandidates={customerAsset.pendingCandidates}
          onReview={handleReviewCandidate}
        />
      )}
      {lead.profileSummary && !lead.profileSummary.hasTrustedIdentity && (
        <div className="px-4 py-2 border-x border-b bg-amber-50 text-amber-800 text-xs">
          此客户尚未建立已验证的邮箱/电话/WhatsApp 身份锚点；系统不会根据相似姓名或号码尾号自动合并。请补充可信联系方式，或从 WhatsApp 取得完整号码后再自动建档。
        </div>
      )}

      {/* ======== 合并审核弹窗 ======== */}
      <MergeDiffDialog
        open={mergeDialogOpen}
        preview={mergeHook.preview}
        pendingAction={mergeHook.pendingAction === 'merge' || mergeHook.pendingAction === 'reject' ? mergeHook.pendingAction : null}
        onMergeAll={handleMergeAll}
        onMergeWithChoices={handleMergeChoices}
        onReject={handleReject}
        onClose={() => setMergeDialogOpen(false)}
      />

      {/* ======== Tabs ======== */}
      <div className="bg-white rounded-lg border overflow-hidden">
        <nav className="flex overflow-x-auto border-b bg-gray-50/50 px-2" aria-label="客户详情标签">
          {TABS.map(t => (
            <button
              key={t.key}
              aria-label={t.key === 'deals' ? '商机&交易' : t.label}
              onClick={() => setTab(t.key)}
              className={`flex shrink-0 items-center gap-1.5 whitespace-nowrap px-3 py-2.5 text-[13px] font-medium border-b-2 transition-colors ${
                tab === t.key
                  ? 'border-blue-500 text-blue-700'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              <t.icon className="w-3.5 h-3.5" />
              {t.label}
            </button>
          ))}
        </nav>
        {workspace?.tabs && <div className="grid grid-cols-3 gap-2 border-b bg-slate-50 px-3 py-2 text-center text-[11px] text-slate-600 sm:grid-cols-7">{Object.entries({ activity: '动态', profile: '资料', opportunities: '商机', risks: '风险', aiResearch: 'AI 背调', documents: '文档', audit: '历史' }).map(([key, label]) => <div key={key}><div className="font-semibold text-slate-800">{workspace.tabs[key as keyof CustomerWorkspaceSummary['tabs']] ?? 0}</div><div>{label}</div></div>)}</div>}

        {/* ======== Tab Content ======== */}

        {/* --- Activity Tab --- */}
        {tab === 'activity' && (
          <div>
            {/* Action area */}
            <div className="p-4 border-b border-dashed">
              <p className="text-[12px] text-gray-500 mb-2">
                如有新的交易，可在此 <Link href={`/opportunities/new?leadId=${id}`} className="text-blue-600 hover:underline">新建商机</Link> 进行管理。
              </p>
              <div className="flex items-center gap-2 flex-wrap">
                <input
                  type="text"
                  value={followupInput}
                  onChange={(e) => setFollowupInput(e.target.value)}
                  placeholder="点击这里记录跟进细节，同步最新进展..."
                  className="flex-1 min-w-[200px] px-3 py-1.5 text-[12px] border rounded-md outline-none focus:border-blue-400 transition-colors"
                />
                <div className="flex gap-1.5">
                  <button className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] rounded border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100">
                    <Sparkles className="w-3 h-3" /> AI 撰写跟进
                  </button>
                  <button className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] rounded border bg-white text-gray-600 hover:bg-gray-50">
                    <ClipboardList className="w-3 h-3" /> 选择模板
                  </button>
                  <button className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] rounded border bg-white text-gray-600 hover:bg-gray-50">
                    <Calendar className="w-3 h-3" /> 添加日程
                  </button>
                </div>
              </div>
            </div>

            {/* Filter bar */}
            <div className="px-4 py-2 border-b flex items-center gap-4 flex-wrap">
              <div className="flex gap-1.5">
                {[
                  { key: 'all', label: '历史动态' },
                  { key: 'ai', label: 'AI 聊天旅程' },
                  { key: 'email', label: 'AI 谈单卡点' },
                ].map(f => (
                  <button
                    key={f.key}
                    onClick={() => setActivityFilter(f.key)}
                    className={`text-[11px] px-2.5 py-1 rounded-full border transition-colors ${
                      activityFilter === f.key
                        ? 'bg-blue-50 border-blue-200 text-blue-700'
                        : 'border-transparent text-gray-500 hover:bg-gray-100'
                    }`}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
              <div className="flex-1" />
              <span className="text-[11px] text-gray-400">
                全部 <span className="bg-gray-100 px-1.5 py-0.5 rounded-full font-medium text-gray-500">{filteredActivities.length}</span>
              </span>
            </div>

            {/* Timeline */}
            <div className="p-4">
              {workspace?.messages && workspace.messages.length > 0 && <div className="mb-5 rounded-lg border border-blue-100 bg-blue-50/40 p-3"><div className="mb-2 text-xs font-semibold text-blue-800">消息摘要</div><div className="space-y-2">{workspace.messages.map((message) => { const body = messageBodies[message.id]; return <div key={message.id} className="rounded border bg-white p-2 text-xs"><div className="flex items-center justify-between gap-2"><span className="truncate font-medium text-gray-700">{message.subject || message.channel || '客户消息'}</span><button type="button" onClick={() => void openMessage(message.id)} disabled={messageLoading === message.id} className="shrink-0 rounded border px-2 py-1 text-[11px] text-blue-700 disabled:opacity-50">{messageLoading === message.id ? '加载中…' : body ? '已展开' : '打开正文'}</button></div>{body ? <p className="mt-2 whitespace-pre-wrap leading-relaxed text-gray-600">{body.body}</p> : <p className="mt-1 text-gray-500">{message.preview || '正文按需加载'}</p>}</div>; })}</div></div>}
              {filteredActivities.length > 0 ? (
                <div className="space-y-6">
                  {Object.entries(groupedActivities).map(([date, acts]) => (
                    <div key={date}>
                      <div className="text-[11px] text-gray-400 font-medium mb-3 ml-1 flex items-center gap-1.5">
                        <Clock className="w-3 h-3" />
                        {date}
                        <span className="bg-gray-100 px-1.5 py-0.5 rounded-full text-[10px]">{acts.length}</span>
                      </div>
                      <div className="space-y-2">
                        {acts.map((a) => (
                          <div key={a.id} className="flex gap-3 p-3 bg-gray-50/80 border rounded-lg hover:bg-white hover:shadow-sm transition-all">
                            {/* Left: dot + time */}
                            <div className="flex flex-col items-center gap-1 shrink-0 pt-0.5">
                              <div className={`w-2 h-2 rounded-full ${
                                a.title?.includes('收到') ? 'bg-green-400' :
                                a.title?.includes('发送') ? 'bg-orange-400' :
                                a.type?.startsWith('ai_') ? 'bg-purple-400' :
                                'bg-blue-400'
                              }`} />
                              <span className="text-[9px] text-gray-400 whitespace-nowrap">
                                {new Date(a.occurredAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                              </span>
                            </div>

                            {/* Right: content */}
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between gap-2 flex-wrap mb-1">
                                <span className="text-[12px] font-medium text-gray-800">{a.title}</span>
                                {a.title?.includes('AI') && (
                                  <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-purple-50 text-purple-600 border border-purple-200 flex items-center gap-0.5">
                                    <Sparkles className="w-2 h-2" />AI 分析
                                  </span>
                                )}
                              </div>
                              {a.description && (
                                <p className="text-[11px] text-gray-600 leading-relaxed">{a.description}</p>
                              )}
                              {a.attachmentName && (
                                <div className="inline-flex items-center gap-1.5 mt-1 px-2 py-0.5 bg-gray-100 rounded text-[10px] text-gray-500">
                                  <Paperclip className="w-2.5 h-2.5" />{a.attachmentName}
                                </div>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="py-8 text-center">
                  <Activity className="w-8 h-8 mx-auto text-gray-300 mb-2" />
                  <p className="text-sm text-gray-400">暂无活动记录</p>
                </div>
              )}
            </div>
          </div>
        )}

        {/* --- Profile Tab --- (使用多联系人原子组件) */}
        {tab === 'profile' && (
          <div className="p-4 space-y-1">
            {/* 客户身份头部 */}
            {customerAsset && (
              <div className="mb-4">
                <CustomerIdentityHeader
                  companyName={customerAsset.companyName}
                  displayName={customerAsset.displayName}
                  countryIso2={customerAsset.countryIso2}
                />
              </div>
            )}

            {/* Section 1: 多联系人信息 */}
            <SectionHeader
              title="联系人信息"
              subtitle={`全部联系人(${customerAsset?.contacts.length ?? 0})`}
              collapsed={collapsedSections.has('contacts')}
              onToggle={() => toggleSection('contacts')}
            />
            {!collapsedSections.has('contacts') && (
              <div className="px-2 py-3 mb-2">
                {customerAsset && customerAsset.contacts.length > 0 ? (
                  <>
                    <ContactSelector
                      contacts={customerAsset.contacts}
                      selectedContactId={selectedContactId}
                      onSelect={setSelectedContactId}
                      defaultExpanded={customerAsset.contacts.length > 1}
                    />
                    {selectedContact && (
                      <div className="mt-3 p-2 border rounded bg-gray-50/50">
                        <p className="text-[11px] font-medium text-gray-700 mb-1">
                          {formatContactName(selectedContact)}
                        </p>
                        <ContactChannelList contactPoints={selectedContact.contactPoints} />
                      </div>
                    )}
                  </>
                ) : (
                  <ContactEmptyState />
                )}
              </div>
            )}

            {/* Section 1.5: 客户资产闭环 */}
            <SectionHeader
              title="客户资产关联"
              subtitle="联系人、渠道、会话、邮件、报价、订单"
              collapsed={collapsedSections.has('asset-links')}
              onToggle={() => toggleSection('asset-links')}
            />
            {!collapsedSections.has('asset-links') && (
              <div className="px-2 py-3 mb-2">
                <div className="grid grid-cols-3 gap-2 text-center">
                  {[
                    ['联系人', customerAsset?.contacts.length ?? 0],
                    ['渠道身份', customerAsset?.contacts.reduce((n, c) => n + c.contactPoints.length, 0) ?? 0],
                    ['会话', customerAsset?.conversations?.length ?? 0],
                    ['邮件', customerAsset?.emails?.length ?? 0],
                    ['报价', customerAsset?.quotes?.length ?? 0],
                    ['订单', customerAsset?.orders?.length ?? 0],
                  ].map(([label, count]) => (
                    <div key={String(label)} className="rounded border bg-gray-50 px-2 py-2">
                      <div className="text-base font-semibold text-gray-800">{count}</div>
                      <div className="text-[10px] text-gray-400">{label}</div>
                    </div>
                  ))}
                </div>
                <div className="mt-3 space-y-1 text-[11px] text-gray-600">
                  {(customerAsset?.conversations ?? []).slice(0, 4).map((conversation) => (
                    <div key={conversation.id} className="flex justify-between gap-2 rounded bg-gray-50 px-2 py-1">
                      <span className="truncate">{conversation.channel || '渠道'} · {conversation.subject || conversation.threadKey || conversation.id}</span>
                      <span className="shrink-0 text-gray-400">会话</span>
                    </div>
                  ))}
                  {(customerAsset?.quotes ?? []).slice(0, 4).map((quote) => (
                    <div key={quote.id} className="flex justify-between gap-2 rounded bg-blue-50/50 px-2 py-1">
                      <span className="truncate">报价 {quote.id}</span><span className="shrink-0 text-gray-400">{quote.status || '待处理'}</span>
                    </div>
                  ))}
                  {(customerAsset?.orders ?? []).slice(0, 4).map((order) => (
                    <div key={order.id} className="flex justify-between gap-2 rounded bg-green-50/50 px-2 py-1">
                      <span className="truncate">订单 {order.id}</span><span className="shrink-0 text-gray-400">{order.status || '待处理'}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Section 2: 公司常用信息 */}
            <SectionHeader
              title="公司常用信息"
              collapsed={collapsedSections.has('company')}
              onToggle={() => toggleSection('company')}
            />
            {!collapsedSections.has('company') && (
              <div className="grid grid-cols-2 gap-x-6 gap-y-2 px-2 py-2 mb-2">
                <InfoField label="公司网址" value={(lead.website as string) || (lead.companyName as string)} link />
                <InfoField label="公司名称" value={lead.companyName as string} />
                <InfoField label="简称" value="--" empty />
                <InfoField label="国家地区" value={lead.country as string} flag />
                <InfoField label="客户来源" value={lead.sourceType === 'website_inquiry' ? '网站询盘' : lead.sourceType === 'acquisition' ? '获客开发' : lead.sourceType === 'manual' ? '手动录入' : (lead.sourceType as string) || '--'} />
                <InfoField label="客户阶段" value={STAGE_OPTIONS.find(s => s.key === lead.status)?.label || (lead.status as string)} />
                <InfoField label="客户编号" value={String(lead.id).slice(0, 8)} />
                <InfoField label="客户分类" value="--" empty />
                <InfoField label="客户类别" value="包装制品类目" />
                <InfoField label="客户类型" value="--" empty />
                <InfoField label="是否主动营销" value="--" empty />
                <InfoField label="座机" value="--" empty />
                <InfoField label="公海分组" value="包装部" full />
              </div>
            )}

            {/* Section 3: 公司其他信息 */}
            <SectionHeader
              title="公司其他信息"
              collapsed={collapsedSections.has('other')}
              onToggle={() => toggleSection('other')}
            />
            {!collapsedSections.has('other') && (
              <div className="grid grid-cols-2 gap-x-6 gap-y-2 px-2 py-2 mb-2">
                <InfoField label="采购意向" value="未知" />
                <InfoField label="年采购额" value="无采购额" empty />
                <InfoField label="时区" value="--" empty />
                <InfoField label="规模" value="--" empty />
                <InfoField label="产品分组" value="--" empty />
                <InfoField label="传真" value="--" empty />
                <InfoField label="详细地址" value="--" empty full />
                <InfoField label="公司备注" value="--" empty full />
                <InfoField label="客户星级" value="--" empty />
              </div>
            )}

            {/* Section 4: 跟进信息 */}
            <SectionHeader
              title="跟进信息"
              collapsed={collapsedSections.has('followup')}
              onToggle={() => toggleSection('followup')}
            />
            {!collapsedSections.has('followup') && (
              <div className="grid grid-cols-2 gap-x-6 gap-y-2 px-2 py-2 mb-2">
                <InfoField label="最近联系时间" value={lead.lastContactedAt ? new Date(lead.lastContactedAt).toLocaleString('zh-CN') : '--'} />
                <InfoField label="最近跟进时间" value={lead.updatedAt ? new Date(lead.updatedAt).toLocaleString('zh-CN') : '--'} />
                <InfoField label="下次移交公海日期" value="--" empty />
                <InfoField label="最近进入私海时间" value={lead.createdAt ? new Date(lead.createdAt).toLocaleString('zh-CN') : '--'} />
                <InfoField label="最近进入公海时间" value="--" empty />
                <InfoField label="进入公海次数" value="0" />
                <InfoField label="最近成交日期" value="--" empty />
                <InfoField label="最近WhatsApp沟通时间" value="--" empty />
                <InfoField label="下次日程时间" value={lead.nextFollowUpAt ? new Date(lead.nextFollowUpAt).toLocaleString('zh-CN') : '--'} empty full />
              </div>
            )}

            {/* Section 5: 系统信息 */}
            <SectionHeader
              title="系统信息"
              collapsed={collapsedSections.has('system')}
              onToggle={() => toggleSection('system')}
            />
            {!collapsedSections.has('system') && (
              <div className="grid grid-cols-2 gap-x-6 gap-y-2 px-2 py-2 mb-2">
                <InfoField label="创建人" value={lead.owner?.firstName || '--'} />
                <InfoField label="创建时间" value={lead.createdAt ? new Date(lead.createdAt).toLocaleString('zh-CN') : '--'} />
                <InfoField label="最近修改人" value={lead.owner?.firstName || '--'} />
                <InfoField label="资料更新时间" value={lead.updatedAt ? new Date(lead.updatedAt).toLocaleString('zh-CN') : '--'} />
                <InfoField label="原始跟进人" value="--" empty />
                <InfoField label="客户跟进人" value={lead.owner?.firstName || '--'} />
                <InfoField label="创建方式" value="手动创建" />
                <InfoField label="关联线索" value="--" empty />
                <InfoField label="来源详情" value="--" empty full />
                <InfoField label="客群" value="--" empty />
                <InfoField label="关联客户最近同步时间" value="--" empty />
              </div>
            )}
          </div>
        )}

        {/* --- Deals Tab --- */}
        {tab === 'deals' && (
          <div className="p-6">
            <div className="text-center py-8">
              <TrendingUp className="w-10 h-10 mx-auto text-gray-300 mb-3" />
              <p className="text-sm font-medium text-gray-600">商机 & 交易</p>
              <p className="text-xs text-gray-400 mt-1">关联的商机、报价、订单和合同将在此集中展示。</p>
              <div className="mt-4 rounded-lg border border-purple-100 bg-purple-50/40 p-4 text-left">
                <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-semibold text-gray-700">商机</h3><Link href={`/opportunities/new?leadId=${id}`} className="text-xs text-blue-600 hover:underline">+ 新建商机</Link></div>
                {opportunityLoading ? <p className="mt-3 text-xs text-gray-500">正在加载商机…</p> : opportunityError ? <div className="mt-3 flex items-center justify-between gap-2 text-xs text-red-600"><span>{opportunityError}</span><button type="button" onClick={() => { setOpportunityLoading(true); loadLead(); }} className="rounded border border-red-200 bg-white px-2 py-1">重试</button></div> : opportunities.length === 0 ? <p className="mt-3 text-xs text-gray-500">该客户暂无商机。</p> : <div className="mt-3 space-y-2">{opportunities.map((opportunity) => <Link key={opportunity.id} href={`/opportunities/${opportunity.id}`} className="block rounded border bg-white p-3 hover:border-blue-300"><div className="flex justify-between gap-2"><span className="text-sm font-medium text-blue-700">{opportunity.name}</span><span className="text-xs text-gray-500">{OPPORTUNITY_STAGE_LABELS[opportunity.stage]}</span></div><div className="mt-1 flex justify-between text-xs text-gray-500"><span>{formatOpportunityAmount(opportunity.amount, opportunity.currency)} · {opportunity.probability}%</span><span>{formatOpportunityDate(opportunity.expectedCloseDate)}</span></div></Link>)}</div>}
              </div>
              {(quotes.length > 0 || (customerAsset?.quotes?.length ?? 0) > 0 || (customerAsset?.orders?.length ?? 0) > 0) && (
                <div className="mt-4 max-w-md mx-auto text-left space-y-2">
                  {quotes.map((q) => (
                    <div key={q.id as string} className="flex items-center justify-between p-2 border rounded text-[12px]">
                      <span className="font-medium text-gray-700">{q.referenceNo || '草稿'}</span>
                      <span className="text-gray-400">{formatQuoteDate(q.createdAt)}</span>
                    </div>
                  ))}
                  {(customerAsset?.quotes ?? []).map((quote) => (
                    <div key={`asset-quote-${quote.id}`} className="flex items-center justify-between p-2 border rounded text-[12px]">
                      <span className="font-medium text-gray-700">报价 {quote.id}</span>
                      <span className="text-gray-400">{quote.status || '待处理'}</span>
                    </div>
                  ))}
                  {(customerAsset?.orders ?? []).map((order) => (
                    <div key={`asset-order-${order.id}`} className="flex items-center justify-between p-2 border rounded text-[12px]">
                      <span className="font-medium text-gray-700">订单 {order.id}</span>
                      <span className="text-gray-400">{order.status || '待处理'}</span>
                    </div>
                  ))}
                </div>
              )}
              <Link href={`/quotes/new?leadId=${id}`} className="inline-block mt-3 text-xs text-blue-600 hover:underline">+ 新建报价</Link>
            </div>
          </div>
        )}

        {/* --- Tips Tab --- */}
        {tab === 'tips' && (
          <div className="p-6">
            <div className="text-center py-8">
              <Sparkles className="w-10 h-10 mx-auto text-gray-300 mb-3" />
              <p className="text-sm font-medium text-gray-600">风险与行动建议</p>
              {workspace?.risks?.length ? <div className="mx-auto mt-4 max-w-md space-y-2 text-left">{workspace.risks.map((risk) => <div key={risk.key} className="rounded border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">{risk.label}</div>)}</div> : <p className="mt-2 text-xs text-gray-400">当前没有需要处理的风险。</p>}
            </div>
          </div>
        )}

        {tab === 'research' && <div className="p-6"><div className="text-center py-8"><Bot className="mx-auto mb-3 h-10 w-10 text-gray-300" /><p className="text-sm font-medium text-gray-600">AI 背调</p><p className="mt-1 text-xs text-gray-400">AI 背调结果仅作为分析记录或待确认候选，不会覆盖正式客户事实。</p><p className="mt-2 text-xs text-gray-500">当前记录：{workspace?.tabs.aiResearch ?? 0}</p></div></div>}

        {/* --- Docs Tab --- */}
        {tab === 'docs' && (
          <div className="p-6">
            <div className="text-center py-8">
              <FileText className="w-10 h-10 mx-auto text-gray-300 mb-3" />
              <p className="text-sm font-medium text-gray-600">文档</p>
              <p className="text-xs text-gray-400 mt-1">与该客户相关的合同、PI、规格书、检验报告等文档。</p>
              <p className="text-xs text-gray-400 mt-0.5">即将上线</p>
            </div>
          </div>
        )}

        {/* --- History Tab --- */}
        {tab === 'history' && (
          <div className="p-6">
            <div><div className="mb-3 flex items-center gap-2"><History className="h-5 w-5 text-gray-400" /><h2 className="text-sm font-semibold text-gray-700">操作历史</h2></div>{auditLoading ? <p className="text-xs text-gray-500">正在加载审计记录…</p> : auditRows.length === 0 ? <p className="text-xs text-gray-400">暂无操作历史。</p> : <div className="space-y-2">{auditRows.map((row) => <div key={row.id} className="rounded border p-3 text-xs"><div className="flex justify-between gap-2"><span className="font-medium text-gray-700">{row.action}</span><span className="text-gray-400">{new Date(row.createdAt).toLocaleString('zh-CN')}</span></div><p className="mt-1 text-gray-500">{row.summary || '操作已记录'}{row.actorName ? ` · ${row.actorName}` : ''}</p></div>)}</div>}</div>
          </div>
        )}
      </div>

      {/* Footer note */}
      <div className="text-center py-3">
        <p className="text-[11px] text-gray-400">待跟进事项、AI聊天旅程、AI谈单卡点内容由AI生成</p>
      </div>
    </div>
  );
}

/* ======== Inline sub-components ======== */

function SectionHeader({ title, subtitle, collapsed, onToggle }: {
  title: string;
  subtitle?: string;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <div
      className="flex items-center justify-between py-2 border-b cursor-pointer hover:bg-gray-50/50 rounded px-2 transition-colors"
      onClick={onToggle}
    >
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-medium text-gray-800">{title}</span>
        {subtitle && <span className="text-[11px] text-gray-400">{subtitle}</span>}
      </div>
      <span className="text-gray-400 flex items-center gap-1 text-[11px]">
        {collapsed ? '展开' : '收起'}
        {collapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
      </span>
    </div>
  );
}

function InfoField({ label, value, link, empty, full, flag }: {
  label: string;
  value: string | undefined | null;
  link?: boolean;
  empty?: boolean;
  full?: boolean;
  flag?: boolean;
}) {
  const display = value || '--';
  const isEmpty = empty || !value;

  if (link && value) {
    return (
      <div className={full ? 'col-span-full' : ''}>
        <div className="text-[11px] text-gray-400">{label}</div>
        <div className="text-[12px] text-blue-600 hover:underline cursor-pointer truncate">
          {flag && <MapPin className="w-3 h-3 inline mr-0.5" />}
          {value}
        </div>
      </div>
    );
  }

  return (
    <div className={full ? 'col-span-full' : ''}>
      <div className="text-[11px] text-gray-400">{label}</div>
      <div className={`text-[12px] ${isEmpty ? 'text-gray-300' : 'text-gray-800'} truncate`}>
        {flag && <MapPin className="w-3 h-3 inline mr-0.5" />}
        {display}
      </div>
    </div>
  );
}
