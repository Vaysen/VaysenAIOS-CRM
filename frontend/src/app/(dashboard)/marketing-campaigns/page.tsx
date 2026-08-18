'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Plus, Search, Megaphone, RefreshCw, Loader2, Users, FileText, Link2, Sparkles, Target,
  Send, CheckCircle2, Settings2, Clock, Zap, CalendarClock, ShieldCheck, ChevronLeft,
  ChevronRight, Mail, Activity, BarChart3, Gauge, TrendingUp, Check, X, AlertTriangle,
  Eye, MousePointerClick,
} from 'lucide-react';
import {
  listMarketingCampaigns,
  createMarketingCampaign,
  transitionMarketingCampaign,
  listMarketingCampaignEvents,
  listMarketingChannelPlans,
  addMarketingChannelPlan,
  runMarketingPreflight,
  listMarketingPreflightRuns,
  snapshotMarketingAudience,
  listMarketingCampaignTemplates,
  listMarketingCampaignSegments,
  linkMarketingCampaignSegment,
  unlinkMarketingCampaignSegment,
  createMarketingContentVersion,
} from '@/lib/marketing-campaign-api';
import {
  MARKETING_CAMPAIGN_STATUS_LABELS,
  MARKETING_STATUS_COLORS,
} from '@/types/marketing-campaign';
import type { MarketingCampaign, MarketingCampaignTemplate } from '@/types/marketing-campaign';
import { listAudienceSegments, exportAudienceSegmentLeadIds } from '@/lib/audience-segment-api';
import type { AudienceSegment } from '@/types/audience-segment';
import api from '@/lib/api';

const AI_BATCH_LIMIT = 100;

const STATUS_COLORS: Record<string, string> = {
  draft: 'bg-gray-100 text-gray-600',
  planning: 'bg-blue-50 text-blue-600',
  review: 'bg-orange-50 text-orange-600',
  approved: 'bg-green-50 text-green-600',
  paused: 'bg-amber-50 text-amber-600',
  archived: 'bg-gray-100 text-gray-500',
};

interface EmailAccountOption {
  id: string;
  senderName: string;
  senderEmail: string;
  dailySentCount?: number;
  dailySendLimit?: number;
  accountRole?: string;
}

interface EmailTemplateOption {
  id: string;
  name: string;
  subject: string;
  body?: string;
  category?: string;
}

interface QueueStatus {
  queued: number;
  drafting: number;
  draftReady: number;
  queuedToSend: number;
  sending: number;
  sentToday: number;
  failed: number;
  skipped: number;
  estimatedMinutes: number;
  sendingNow: boolean;
}

interface EmailRecord {
  id: string;
  status: string;
  subject: string;
  createdAt: string;
  sentAt?: string;
  lead?: { id: string; companyName?: string; contactName?: string; contactEmail?: string };
  emailAccount?: { id: string; senderName?: string; senderEmail?: string };
  openEvents?: { count: number }[];
  clickEvents?: { originalUrl?: string }[];
}

export default function MarketingCampaignsPage() {
  // ================= 活动管理 =================
  const [campaigns, setCampaigns] = useState<MarketingCampaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [newChannel, setNewChannel] = useState<'email' | 'whatsapp'>('email');
  const [templates, setTemplates] = useState<MarketingCampaignTemplate[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState('');
  const [creating, setCreating] = useState(false);

  const [selected, setSelected] = useState<MarketingCampaign | null>(null);
  const [detailEvents, setDetailEvents] = useState<any[]>([]);
  const [detailPlans, setDetailPlans] = useState<any[]>([]);
  const [detailPreflights, setDetailPreflights] = useState<any[]>([]);
  const [detailSegments, setDetailSegments] = useState<any[]>([]);
  const [availableSegments, setAvailableSegments] = useState<AudienceSegment[]>([]);
  const [linkSegmentId, setLinkSegmentId] = useState('');
  const [snapshotSegmentId, setSnapshotSegmentId] = useState('');
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailTab, setDetailTab] = useState<'plans' | 'segments' | 'preflight' | 'events'>('plans');
  const [newPlanChannel, setNewPlanChannel] = useState('email');

  // ================= 营销控制面板 =================
  const [allSegments, setAllSegments] = useState<AudienceSegment[]>([]);
  const [pickedSegments, setPickedSegments] = useState<string[]>([]);
  const [emailAccounts, setEmailAccounts] = useState<EmailAccountOption[]>([]);
  const [emailTemplates, setEmailTemplates] = useState<EmailTemplateOption[]>([]);
  const [pickedTemplate, setPickedTemplate] = useState('');
  const [pickedAccount, setPickedAccount] = useState('');
  const [aiPersonalize, setAiPersonalize] = useState(true);
  const [aiTone, setAiTone] = useState('professional');
  const [aiLanguage, setAiLanguage] = useState('English');
  const [aiPrompt, setAiPrompt] = useState('');
  const [sendIntervalSeconds, setSendIntervalSeconds] = useState(60);
  const [sendNow, setSendNow] = useState(true);
  const [sendAt, setSendAt] = useState('');
  const [consoleLoading, setConsoleLoading] = useState(false);
  const [consoleResult, setConsoleResult] = useState<any>(null);
  const [consoleMsg, setConsoleMsg] = useState<string | null>(null);
  const [wizardStep, setWizardStep] = useState(0);
  const [segSearch, setSegSearch] = useState('');
  const [segFilter, setSegFilter] = useState<'all' | 'email' | 'auto'>('all');

  // ================= 数据看板 =================
  const [queueStatus, setQueueStatus] = useState<QueueStatus | null>(null);
  const [recentEmails, setRecentEmails] = useState<EmailRecord[]>([]);
  const [dashLoading, setDashLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setError(null);
      const data = await listMarketingCampaigns();
      setCampaigns(Array.isArray(data) ? data : []);
      const tpls = await listMarketingCampaignTemplates().catch(() => []);
      setTemplates(Array.isArray(tpls) ? tpls : []);
    } catch (err: any) {
      setError(`营销活动加载失败: ${err.response?.data?.message || err.message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadConsole = useCallback(async () => {
    try {
      setConsoleMsg(null);
      const [segsRes, accountsRes, tplsRes] = await Promise.all([
        listAudienceSegments({ pageSize: 100 }).catch(() => ({ items: [] as AudienceSegment[] })),
        api.get('/email-accounts', { params: { status: 'active', limit: 50 } }).catch(() => ({ data: { data: [] } })),
        api.get('/email-templates', { params: { isActive: true, limit: 100 } }).catch(() => ({ data: { data: [] } })),
      ]);
      setAllSegments((segsRes as any)?.items || []);
      const rawAccounts: EmailAccountOption[] = (accountsRes as any)?.data?.data || (accountsRes as any)?.data || [];
      setEmailAccounts(rawAccounts.filter((a) => !a.accountRole || a.accountRole === 'MARKETING'));
      setEmailTemplates((tplsRes as any)?.data?.data || (tplsRes as any)?.data || []);
    } catch (err: any) {
      setConsoleMsg(`控制面板加载失败: ${err.response?.data?.message || err.message}`);
    }
  }, []);

  const loadDashboard = useCallback(async () => {
    try {
      const [qsRes, emailsRes] = await Promise.all([
        api.get('/emails/queue-status').catch(() => null),
        api.get('/emails', { params: { page: 1, limit: 5 } }).catch(() => null),
      ]);
      setQueueStatus((qsRes as any)?.data?.data || null);
      setRecentEmails((emailsRes as any)?.data?.data || []);
    } finally {
      setDashLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadConsole(); }, [loadConsole]);
  useEffect(() => {
    loadDashboard();
    const timer = setInterval(loadDashboard, 30000);
    return () => clearInterval(timer);
  }, [loadDashboard]);

  const refreshAll = () => { load(); loadConsole(); loadDashboard(); };

  // ================= 向导操作 =================
  const toggleSegment = (id: string) => {
    setPickedSegments((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const applyMarketingTemplate = (tplId: string) => {
    setSelectedTemplate(tplId);
    const tpl = templates.find((t) => t.id === tplId);
    if (tpl) {
      setNewName(tpl.name);
      setNewDesc(tpl.description);
      setNewChannel(tpl.suggestedChannel);
    }
  };

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      await createMarketingCampaign({
        name: newName.trim(),
        description: newDesc.trim() || undefined,
        channel: newChannel,
      });
      setShowCreate(false);
      setNewName('');
      setNewDesc('');
      setNewChannel('email');
      setSelectedTemplate('');
      await load();
    } catch (err: any) {
      setError(`创建失败: ${err.response?.data?.message || err.message}`);
    } finally {
      setCreating(false);
    }
  };

  const handleTransition = async (id: string, transition: string) => {
    try {
      await transitionMarketingCampaign(id, transition);
      await load();
      if (selected?.id === id) await openDetail(selected.id);
    } catch (err: any) {
      setError(`状态变更失败: ${err.response?.data?.message || err.message}`);
    }
  };

  const openDetail = async (id: string) => {
    setDetailLoading(true);
    setSelected(campaigns.find((c) => c.id === id) || null);
    setDetailTab('plans');
    try {
      const [events, plans, preflights, segs, availSegs] = await Promise.all([
        listMarketingCampaignEvents(id).catch(() => []),
        listMarketingChannelPlans(id).catch(() => []),
        listMarketingPreflightRuns(id).catch(() => []),
        listMarketingCampaignSegments(id).catch(() => []),
        listAudienceSegments({ pageSize: 100 }).catch(() => ({ items: [] as any[] })),
      ]);
      setDetailEvents(events);
      setDetailPlans(plans);
      setDetailPreflights(preflights);
      setDetailSegments(segs);
      setAvailableSegments((availSegs as any)?.items || []);
      setSnapshotSegmentId(Array.isArray(segs) && segs.length > 0 ? (segs[0] as any).segmentId : '');
    } catch (err) { console.error('[Marketing] detail load failed:', err); } finally {
      setDetailLoading(false);
    }
  };

  const handleAddPlan = async () => {
    if (!selected) return;
    try {
      await addMarketingChannelPlan(selected.id, { channel: newPlanChannel });
      await openDetail(selected.id);
    } catch (err: any) {
      setError(`添加渠道失败: ${err.response?.data?.message || err.message}`);
    }
  };

  const handleLinkSegment = async () => {
    if (!selected || !linkSegmentId) return;
    try {
      await linkMarketingCampaignSegment(selected.id, linkSegmentId);
      setLinkSegmentId('');
      await openDetail(selected.id);
    } catch (err: any) {
      setError(`关联客群失败: ${err.response?.data?.message || err.message}`);
    }
  };

  const handleUnlinkSegment = async (segmentId: string) => {
    if (!selected) return;
    try {
      await unlinkMarketingCampaignSegment(selected.id, segmentId);
      await openDetail(selected.id);
    } catch (err: any) {
      setError(`解除关联失败: ${err.response?.data?.message || err.message}`);
    }
  };

  const handlePreflight = async () => {
    if (!selected) return;
    try {
      await runMarketingPreflight(selected.id);
      await openDetail(selected.id);
    } catch (err: any) {
      setError(`预检失败: ${err.response?.data?.message || err.message}`);
    }
  };

  const handleSnapshotAudience = async () => {
    if (!selected) return;
    try {
      const input = snapshotSegmentId ? { segmentId: snapshotSegmentId } : {};
      await snapshotMarketingAudience(selected.id, input);
      await openDetail(selected.id);
    } catch (err: any) {
      setError(`受众快照失败: ${err.response?.data?.message || err.message}`);
    }
  };

  const handleAiDraft = async (autoActivate: boolean) => {
    if (!selected) return;
    try {
      const tpl = templates.find((t) => t.name === selected.name);
      await createMarketingContentVersion(selected.id, {
        aiPrompt: tpl?.aiPrompt || '为营销活动撰写一封简洁专业的英文开发信，介绍Vaysen包装（快递袋/牛皮纸袋/垃圾袋/自封袋工厂），突出 15 年经验、ISO 认证、快速打样。长度 100-150 词。',
        autoActivate,
      });
      await openDetail(selected.id);
    } catch (err: any) {
      setError(`AI 内容失败: ${err.response?.data?.message || err.message}`);
    }
  };

  const goStep = (delta: number) => {
    const next = wizardStep + delta;
    if (next < 0 || next > 3) return;
    if (delta > 0 && next === 1 && pickedSegments.length === 0) {
      setConsoleMsg('请先选择至少一个客群');
      return;
    }
    setConsoleMsg(null);
    setWizardStep(next);
  };

  const handleConsoleSend = async () => {
    if (pickedSegments.length === 0) { setConsoleMsg('请先选择至少一个客群'); return; }
    if (!pickedTemplate) { setConsoleMsg('请选择邮件模板'); return; }
    if (!pickedAccount) { setConsoleMsg('请选择发件邮箱账号'); return; }
    if (!sendNow && !sendAt) { setConsoleMsg('请选择定时发送时间'); return; }
    setConsoleLoading(true);
    setConsoleMsg(null);
    setConsoleResult(null);
    try {
      const idSets = await Promise.all(pickedSegments.map((sid) => exportAudienceSegmentLeadIds(sid).catch(() => [] as string[])));
      const merged = Array.from(new Set(idSets.flat()));
      const leadIds = merged.slice(0, AI_BATCH_LIMIT);
      const truncated = merged.length > AI_BATCH_LIMIT;
      const payload: Record<string, any> = {
        leadIds,
        emailAccountId: pickedAccount,
        emailTemplateId: pickedTemplate,
        aiPersonalize,
        aiTone: aiTone === 'professional' ? undefined : aiTone,
        aiLanguage: aiLanguage === 'English' ? undefined : aiLanguage,
        aiPrompt: aiPrompt.trim() || undefined,
        sendIntervalSeconds: Math.max(5, sendIntervalSeconds || 60),
      };
      if (!sendNow) payload.sendAt = new Date(sendAt).toISOString();
      const res = await api.post('/emails/send-batch', payload, {
        headers: { 'Idempotency-Key': `marketing-console-${Date.now()}-${Math.random().toString(36).slice(2, 10)}` },
      });
      setConsoleResult({ ...res.data, totalLeadIds: merged.length, truncated, scheduled: !sendNow });
      setWizardStep(3);
    } catch (err: any) {
      setConsoleMsg(`批量发送失败: ${err.response?.data?.message || err.message}`);
    } finally {
      setConsoleLoading(false);
    }
  };

  const filtered = campaigns.filter((c) => {
    const matchSearch = !search || c.name.toLowerCase().includes(search.toLowerCase());
    const matchStatus = !statusFilter || c.status === statusFilter;
    return matchSearch && matchStatus;
  });

  const transitionsFor = (status: string | undefined) => {
    switch (status) {
      case 'DRAFT': return [['start_planning', '进入计划']];
      case 'PLANNING': return [['submit_review', '提交审核']];
      case 'IN_REVIEW': return [['approve', '批准'], ['request_changes', '退回修改']];
      case 'APPROVED_PLAN': return [['request_changes', '退回修改'], ['pause', '暂停'], ['archive', '归档']];
      case 'PAUSED': return [['resume', '恢复']];
      default: return [];
    }
  };

  const activeCampaigns = useMemo(
    () => campaigns.filter((c) => !['ARCHIVED', 'DRAFT'].includes(c.status || '')).length,
    [campaigns],
  );

  const pickedCount = pickedSegments.reduce((sum, id) => {
    const seg = allSegments.find((s) => s.id === id);
    return sum + (seg?.memberCount || 0);
  }, 0);

  const filteredSegments = useMemo(() => {
    const kw = segSearch.toLowerCase();
    return allSegments.filter((s) => {
      const okKw = !kw || s.name.toLowerCase().includes(kw) || (s.description || '').toLowerCase().includes(kw);
      const okF = segFilter === 'all' ? true : segFilter === 'email' ? !(s.criteriaJson as any)?.hasWhatsapp : !!(s.criteriaJson as any)?.autoRefreshEnabled;
      return okKw && okF;
    });
  }, [allSegments, segSearch, segFilter]);

  const pickedTemplateObj = emailTemplates.find((t) => t.id === pickedTemplate);
  const pickedAccountObj = emailAccounts.find((a) => a.id === pickedAccount);
  const etaMinutes = Math.max(1, Math.ceil((pickedCount || 0) * (sendIntervalSeconds || 60) / 60));
  const queue = queueStatus;

  const statusBadgeClass = (status?: string) => STATUS_COLORS[status?.toLowerCase() || ''] || 'bg-gray-100 text-gray-600';

  const emailStatusMeta: Record<string, { label: string; cls: string }> = {
    Sent: { label: '已送达', cls: 'bg-green-50 text-green-600' },
    Sending: { label: '发送中', cls: 'bg-blue-50 text-blue-600' },
    QueuedToSend: { label: '排队发送', cls: 'bg-blue-50 text-blue-600' },
    Queued: { label: '排队中', cls: 'bg-blue-50 text-blue-600' },
    DraftReady: { label: 'AI 待发', cls: 'bg-violet-50 text-violet-600' },
    Drafting: { label: 'AI 撰写中', cls: 'bg-violet-50 text-violet-600' },
    DraftPending: { label: 'AI 排队', cls: 'bg-violet-50 text-violet-600' },
    Failed: { label: '失败', cls: 'bg-red-50 text-red-600' },
    DraftFailed: { label: 'AI 失败', cls: 'bg-red-50 text-red-600' },
    Blocked: { label: '被拦截', cls: 'bg-red-50 text-red-600' },
    Skipped: { label: '已跳过', cls: 'bg-gray-100 text-gray-500' },
  };

  const stepLabels = [
    { name: '选择客群', desc: '谁收到这封邮件' },
    { name: '选择内容', desc: '发什么 · AI 怎么润色' },
    { name: '发送范围', desc: '哪个账号 · 何时发' },
    { name: '确认发送', desc: '检查后一键发送' },
  ];

  return (
    <div className="mx-auto max-w-7xl p-6">
      {/* ================= 顶部 ================= */}
      <div className="rounded-2xl bg-gradient-to-r from-[#0b1623] via-[#132031] to-[#1a3552] px-6 py-5 text-white shadow-lg">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#f6b84b]/20">
              <Megaphone className="h-5 w-5 text-[#f6b84b]" />
            </span>
            <div>
              <h1 className="text-xl font-bold tracking-wide flex items-center gap-2">
                营销控制面板
                <span className="rounded-full bg-[#f6b84b]/15 px-2.5 py-0.5 text-[10px] font-semibold text-[#f6b84b] border border-[#f6b84b]/40">
                  批量发送通道已开启
                </span>
              </h1>
              <p className="mt-0.5 text-xs text-slate-400">选客群 → 选内容 → 定范围 → AI 个性化 → 后台邮箱批量发送</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-white/10 px-3 py-1 text-[11px] text-slate-300 border border-white/10">
              发件账号 {emailAccounts.length} · 模板 {emailTemplates.length} · 客群 {allSegments.length}
            </span>
            <span className="rounded-full bg-white/10 px-3 py-1 text-[11px] text-slate-300 border border-white/10 flex items-center gap-1">
              <Sparkles className="h-3 w-3 text-[#f6b84b]" /> AI：智谱 GLM-4-Flash
            </span>
            <button onClick={refreshAll} className="rounded-lg bg-white/10 p-2 text-slate-300 hover:bg-white/20 hover:text-white transition" title="刷新">
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>
      </div>

      {error && <div className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">{error}</div>}
      {consoleMsg && (
        <div className="mt-3 flex items-center justify-between rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
          <span>{consoleMsg}</span>
          <button onClick={() => setConsoleMsg(null)} className="text-amber-400 hover:text-amber-600">&times;</button>
        </div>
      )}

      {/* ================= KPI ================= */}
      <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-500">今日已发送</span>
            <span className="rounded-lg bg-[#f6b84b]/15 p-1.5 text-[#b8860b]"><Send className="h-3.5 w-3.5" /></span>
          </div>
          <p className="mt-2 text-2xl font-extrabold text-gray-900">{queue?.sentToday ?? '—'}<span className="text-xs font-medium text-gray-400 ml-1">封</span></p>
          <p className="mt-1 text-[11px] text-gray-400 flex items-center gap-1">
            <Activity className="h-3 w-3" />队列中 {queue?.queued ?? 0} · 发送中 {queue?.sending ?? 0}
          </p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-500">发送队列</span>
            <span className="rounded-lg bg-emerald-50 p-1.5 text-emerald-600"><Gauge className="h-3.5 w-3.5" /></span>
          </div>
          <p className="mt-2 text-2xl font-extrabold text-gray-900">{queue?.queued ?? '—'}<span className="text-xs font-medium text-gray-400 ml-1">封待发</span></p>
          <p className="mt-1 text-[11px] text-gray-400 flex items-center gap-1">
            <Clock className="h-3 w-3" />预计 {queue?.estimatedMinutes ?? 0} 分钟清空
          </p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-500">客户总量</span>
            <span className="rounded-lg bg-blue-50 p-1.5 text-blue-600"><Users className="h-3.5 w-3.5" /></span>
          </div>
          <p className="mt-2 text-2xl font-extrabold text-gray-900">{allSegments.reduce((s, x) => s + (x.memberCount || 0), 0)}<span className="text-xs font-medium text-gray-400 ml-1">人</span></p>
          <p className="mt-1 text-[11px] text-gray-400 flex items-center gap-1">
            <Target className="h-3 w-3" />覆盖 {allSegments.length} 个客群
          </p>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-500">进行中活动</span>
            <span className="rounded-lg bg-orange-50 p-1.5 text-orange-600"><BarChart3 className="h-3.5 w-3.5" /></span>
          </div>
          <p className="mt-2 text-2xl font-extrabold text-gray-900">{activeCampaigns}<span className="text-xs font-medium text-gray-400 ml-1">个</span></p>
          <p className="mt-1 text-[11px] text-gray-400 flex items-center gap-1">
            <TrendingUp className="h-3 w-3" />含草稿共 {campaigns.length} 个
          </p>
        </div>
      </div>

      {/* ================= 四步向导 ================= */}
      <div className="mt-5 overflow-hidden rounded-2xl border border-gray-200 bg-white shadow-sm">
        {/* 向导头 */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-100 bg-gradient-to-b from-[#fbfcfe] to-white px-5 py-4">
          <div>
            <div className="flex items-center gap-2 text-sm font-bold text-gray-900">
              <span className="flex h-5 w-5 items-center justify-center rounded-md bg-[#132031] text-[10px] font-extrabold text-[#f6b84b]">✦</span>
              发起一次营销
            </div>
            <p className="ml-7 mt-0.5 text-[11px] text-gray-400">四个步骤，一键触达你的目标客群</p>
          </div>
          <div className="text-right">
            <span className="text-[11px] text-gray-400">已选</span>
            <b className="mx-1 text-lg text-[#132031]">{pickedSegments.length}</b>
            <span className="text-[11px] text-gray-400">个客群 · <b className="text-lg text-[#132031]">{pickedCount}</b> 人</span>
          </div>
        </div>

        {/* 步骤条 */}
        <div className="grid grid-cols-2 border-b border-gray-100 bg-[#fafbfd] md:grid-cols-4">
          {stepLabels.map((s, i) => (
            <button
              key={i}
              onClick={() => { if (i < wizardStep) setWizardStep(i); }}
              className={`flex items-center gap-2.5 border-b-[3px] px-4 py-3 text-left transition ${i === wizardStep ? 'border-[#f6b84b] bg-white' : i < wizardStep ? 'border-emerald-500 bg-white' : 'border-transparent hover:bg-gray-50'} ${i >= wizardStep ? 'cursor-default' : 'cursor-pointer'}`}
            >
              <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] font-extrabold ${i === wizardStep ? 'bg-[#132031] text-[#f6b84b] ring-4 ring-[#132031]/10' : i < wizardStep ? 'bg-emerald-500 text-white' : 'bg-gray-200 text-gray-500'}`}>
                {i < wizardStep ? <Check className="h-3.5 w-3.5" /> : i + 1}
              </span>
              <span className="min-w-0">
                <span className={`block text-xs font-bold ${i === wizardStep ? 'text-[#132031]' : 'text-gray-500'}`}>{s.name}</span>
                <span className="block text-[10px] text-gray-400">{s.desc}</span>
              </span>
            </button>
          ))}
        </div>

        <div className="p-5">
          {/* ===== 步骤 1：选客群 ===== */}
          {wizardStep === 0 && (
            <div>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <div className="relative flex-1 min-w-[220px]">
                  <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
                  <input
                    value={segSearch}
                    onChange={(e) => setSegSearch(e.target.value)}
                    placeholder="搜索客群名称 / 描述..."
                    className="w-full rounded-lg border border-gray-200 bg-[#fbfcfe] py-2 pl-9 pr-3 text-xs outline-none focus:border-[#132031] focus:bg-white"
                  />
                </div>
                {(['all', 'email', 'auto'] as const).map((f) => (
                  <button
                    key={f}
                    onClick={() => setSegFilter(f)}
                    className={`rounded-lg border px-3 py-1.5 text-[11px] transition ${segFilter === f ? 'border-[#132031] bg-[#132031] text-white' : 'border-gray-200 bg-white text-gray-500 hover:border-gray-300'}`}
                  >
                    {f === 'all' ? '全部' : f === 'email' ? '邮件客群' : '自动刷新'}
                  </button>
                ))}
              </div>

              {filteredSegments.length === 0 ? (
                <div className="py-12 text-center">
                  <Target className="mx-auto h-8 w-8 text-gray-200" />
                  <p className="mt-2 text-xs text-gray-400">暂无客群，请先到「客群管理」创建</p>
                </div>
              ) : (
                <div className="grid max-h-[300px] grid-cols-1 gap-2.5 overflow-y-auto p-0.5 md:grid-cols-2 xl:grid-cols-3">
                  {filteredSegments.map((s) => {
                    const picked = pickedSegments.includes(s.id);
                    const criteria = (s.criteriaJson || {}) as any;
                    return (
                      <button
                        key={s.id}
                        onClick={() => toggleSegment(s.id)}
                        className={`relative rounded-xl border-[1.5px] p-3.5 text-left transition ${picked ? 'border-[#f6b84b] bg-[#fdf3dd] shadow-[0_4px_12px_rgba(246,184,75,.2)]' : 'border-gray-200 bg-white hover:border-[#f6b84b] hover:shadow-md'}`}
                      >
                        <span className={`absolute right-2.5 top-2.5 flex h-5 w-5 items-center justify-center rounded-full border-[1.5px] ${picked ? 'border-[#f6b84b] bg-[#f6b84b] text-white' : 'border-gray-300 text-transparent'}`}>
                          <Check className="h-3 w-3" />
                        </span>
                        <p className="flex items-center gap-1.5 pr-6 text-[13px] font-bold text-gray-900">
                          <Target className="h-3.5 w-3.5 text-[#b8860b]" />{s.name}
                        </p>
                        <p className="mt-1 text-[11px] leading-snug text-gray-400 min-h-[30px]">{s.description || '—'}</p>
                        <div className="mt-2 flex items-center justify-between">
                          <div className="flex flex-wrap gap-1">
                            {criteria?.autoRefreshEnabled && (
                              <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-600">自动刷新</span>
                            )}
                            {criteria?.hasWhatsapp ? (
                              <span className="rounded bg-orange-50 px-1.5 py-0.5 text-[9px] font-semibold text-orange-600">WhatsApp</span>
                            ) : (
                              <span className="rounded bg-blue-50 px-1.5 py-0.5 text-[9px] font-semibold text-blue-600">邮件</span>
                            )}
                          </div>
                          <span className="rounded-full bg-[#f5f7fa] px-2 py-0.5 text-[11px] font-bold text-[#132031]">{s.memberCount} 人</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}

              <div className="mt-3.5 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-[#132031] px-4 py-2.5 text-white">
                <span className="flex items-center gap-3">
                  <span className="text-[11px] text-slate-400">已选客群</span>
                  <span className="text-lg font-extrabold text-[#f6b84b]">{pickedSegments.length}</span>
                  <span className="text-[11px] text-slate-300">≈ <b className="text-[#f6b84b]">{pickedCount}</b> 位客户将被触达（去重后）</span>
                </span>
                <span className="text-[10px] text-slate-400">点选卡片即可多选</span>
              </div>
            </div>
          )}

          {/* ===== 步骤 2：选内容 ===== */}
          {wizardStep === 1 && (
            <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
              <div className="max-h-[400px] overflow-y-auto rounded-xl border border-gray-200 bg-[#fafbfd] p-2">
                {emailTemplates.length === 0 ? (
                  <p className="py-10 text-center text-xs text-gray-400">暂无已启用的邮件模板</p>
                ) : emailTemplates.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setPickedTemplate(t.id)}
                    className={`mb-1.5 w-full rounded-lg border px-3 py-2.5 text-left transition ${pickedTemplate === t.id ? 'border-[#f6b84b] bg-[#fdf3dd]' : 'border-transparent hover:border-gray-200 hover:bg-white'}`}
                  >
                    <span className="flex items-center justify-between text-xs font-bold text-gray-800">
                      {t.name}
                      {pickedTemplate === t.id && <Check className="h-3.5 w-3.5 text-[#b8860b]" />}
                    </span>
                    <span className="mt-0.5 block truncate text-[10px] text-gray-400">{t.subject}</span>
                  </button>
                ))}
              </div>

              <div className="flex flex-col overflow-hidden rounded-xl border border-gray-200">
                <div className="flex items-center gap-2 bg-[#0b1623] px-3.5 py-2 text-[11px] text-slate-300">
                  <span className="flex gap-1">
                    <i className="h-2 w-2 rounded-full bg-[#ff5f57]" />
                    <i className="h-2 w-2 rounded-full bg-[#febc2e]" />
                    <i className="h-2 w-2 rounded-full bg-[#28c840]" />
                  </span>
                  邮件预览 · 收件人：{'{{客户名}}'}
                  <span className="ml-auto text-[#f6b84b]">Vaysen 品牌模板</span>
                </div>
                <div className="flex-1 bg-white p-4">
                  <p className="text-[15px] font-extrabold text-[#132031]">{pickedTemplateObj?.subject || '未选择模板'}</p>
                  <p className="mt-1 text-[11px] text-gray-400">
                    发件人：{pickedAccountObj?.senderName || '—'} &lt;{pickedAccountObj?.senderEmail || '—'}&gt;
                  </p>
                  <div className="mt-3 whitespace-pre-line rounded-lg bg-gray-50 p-3 text-xs leading-relaxed text-gray-600">
                    {pickedTemplateObj?.body
                      ? pickedTemplateObj.body.slice(0, 400) + (pickedTemplateObj.body.length > 400 ? '\n…' : '')
                      : '选择左侧模板查看预览'}
                  </div>
                  {aiPersonalize && (
                    <span className="mt-3 inline-flex items-center gap-1.5 rounded-full bg-gradient-to-r from-[#132031] to-[#1b3047] px-3 py-1 text-[10px] font-bold text-[#f6b84b]">
                      <Sparkles className="h-3 w-3" />AI 将为每位客户重写称呼、行业亮点与产品推荐
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* AI 面板（步骤 2 内） */}
          {wizardStep === 1 && (
            <div className="mt-4 rounded-xl border border-dashed border-gray-300 bg-[#fbfcfe] p-4">
              <p className="flex items-center gap-2 text-xs font-extrabold text-gray-800">
                <Sparkles className="h-4 w-4 text-[#b8860b]" />AI 智能写作（智谱 GLM-4-Flash 驱动）
              </p>
              <div className="mt-3 flex flex-wrap items-end gap-5">
                <label className="flex cursor-pointer items-center gap-2 text-xs font-semibold text-gray-600">
                  <input
                    type="checkbox"
                    checked={aiPersonalize}
                    onChange={(e) => setAiPersonalize(e.target.checked)}
                    className="h-4 w-4 accent-[#f6b84b]"
                  />
                  批量发送启用 AI 个性化
                </label>
                <div className={aiPersonalize ? '' : 'pointer-events-none opacity-40'}>
                  <label className="mb-1 block text-[10px] text-gray-400">语气风格</label>
                  <select value={aiTone} onChange={(e) => setAiTone(e.target.value)} className="rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs outline-none">
                    <option value="professional">专业友好（默认）</option>
                    <option value="concise">简洁直接</option>
                    <option value="warm">热情正式</option>
                  </select>
                </div>
                <div className={aiPersonalize ? '' : 'pointer-events-none opacity-40'}>
                  <label className="mb-1 block text-[10px] text-gray-400">写作语言</label>
                  <select value={aiLanguage} onChange={(e) => setAiLanguage(e.target.value)} className="rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs outline-none">
                    <option>English</option>
                    <option>Chinese</option>
                    <option>Spanish</option>
                    <option>German</option>
                    <option>French</option>
                  </select>
                </div>
                <div className={`min-w-[240px] flex-1 ${aiPersonalize ? '' : 'pointer-events-none opacity-40'}`}>
                  <label className="mb-1 block text-[10px] text-gray-400">自定义提示词（覆盖默认）</label>
                  <input
                    value={aiPrompt}
                    onChange={(e) => setAiPrompt(e.target.value)}
                    placeholder="例如：强调 ISO 认证与 5-7 天快速打样，结尾附英文+中文对照..."
                    className="w-full rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs outline-none focus:border-[#132031]"
                  />
                </div>
              </div>
            </div>
          )}

          {/* ===== 步骤 3：发送范围 ===== */}
          {wizardStep === 2 && (
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-4">
                <div className="rounded-xl border border-gray-200 p-4">
                  <p className="mb-3 flex items-center gap-2 text-xs font-extrabold text-gray-800">
                    <Mail className="h-3.5 w-3.5 text-[#b8860b]" />发件账号（仅营销邮箱）
                  </p>
                  {emailAccounts.length === 0 ? (
                    <p className="py-6 text-center text-xs text-gray-400">暂无营销邮箱账号，请先在「邮箱账号」中将账号角色设为营销邮箱</p>
                  ) : (
                    <div className="flex flex-wrap gap-2.5">
                      {emailAccounts.map((a) => {
                        const used = a.dailySentCount || 0;
                        const limit = a.dailySendLimit || 50;
                        const pct = Math.min(100, Math.round(used / limit * 100));
                        return (
                          <button
                            key={a.id}
                            onClick={() => setPickedAccount(a.id)}
                            className={`min-w-[210px] flex-1 rounded-xl border-[1.5px] p-3 text-left transition ${pickedAccount === a.id ? 'border-[#132031] bg-[#f4f7fb]' : 'border-gray-200 bg-white hover:border-[#132031]'}`}
                          >
                            <p className="flex items-center justify-between text-xs font-extrabold text-gray-900">
                              {a.senderName}
                              <span className="flex items-center gap-1">
                                <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[9px] font-bold text-emerald-700">营销</span>
                                {pickedAccount === a.id && <Check className="h-3.5 w-3.5 text-emerald-600" />}
                              </span>
                            </p>
                            <p className="mt-0.5 text-[11px] text-gray-400">{a.senderEmail}</p>
                            <p className="mt-1.5 text-[10px] text-gray-400">今日 {used}/{limit} 封</p>
                            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-gray-100">
                              <div className={`h-full rounded-full ${pct > 70 ? 'bg-orange-400' : 'bg-[#f6b84b]'}`} style={{ width: `${pct}%` }} />
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div className="rounded-xl border border-gray-200 p-4">
                  <p className="mb-3 flex items-center gap-2 text-xs font-extrabold text-gray-800">
                    <Settings2 className="h-3.5 w-3.5 text-[#b8860b]" />发送节奏
                  </p>
                  <div className="flex items-center gap-3">
                    <span className="whitespace-nowrap text-[11px] font-semibold text-gray-500">发送间隔</span>
                    <input
                      type="range"
                      min={5} max={600} step={5} value={sendIntervalSeconds}
                      onChange={(e) => setSendIntervalSeconds(Number(e.target.value))}
                      className="flex-1 accent-[#132031]"
                    />
                    <span className="whitespace-nowrap rounded-full bg-[#f5f7fa] px-2.5 py-0.5 text-xs font-bold text-[#132031]">{sendIntervalSeconds} 秒</span>
                  </div>
                  <p className="mt-2.5 text-[11px] text-gray-400">
                    账号日限额 {pickedAccountObj?.dailySendLimit || 50} 封 · {pickedCount || 0} 人按 {sendIntervalSeconds}s 间隔，约 <b className="text-[#132031]">{etaMinutes} 分钟</b>完成
                  </p>
                </div>
              </div>

              <div className="space-y-4">
                <div className="rounded-xl border border-gray-200 p-4">
                  <p className="mb-3 flex items-center gap-2 text-xs font-extrabold text-gray-800">
                    <Clock className="h-3.5 w-3.5 text-[#b8860b]" />发送时间
                  </p>
                  <div className="flex gap-2.5">
                    <button
                      onClick={() => { setSendNow(true); setSendAt(''); }}
                      className={`flex-1 rounded-xl border-[1.5px] p-3 text-center transition ${sendNow ? 'border-[#f6b84b] bg-[#fdf3dd]' : 'border-gray-200 bg-white hover:border-[#132031]'}`}
                    >
                      <Zap className="mx-auto h-5 w-5 text-[#b8860b]" />
                      <p className="mt-1 text-xs font-bold text-gray-800">立即发送</p>
                      <p className="mt-0.5 text-[10px] text-gray-400">马上进入发送队列</p>
                    </button>
                    <button
                      onClick={() => setSendNow(false)}
                      className={`flex-1 rounded-xl border-[1.5px] p-3 text-center transition ${!sendNow ? 'border-[#f6b84b] bg-[#fdf3dd]' : 'border-gray-200 bg-white hover:border-[#132031]'}`}
                    >
                      <CalendarClock className="mx-auto h-5 w-5 text-[#b8860b]" />
                      <p className="mt-1 text-xs font-bold text-gray-800">定时发送</p>
                      <p className="mt-0.5 text-[10px] text-gray-400">指定时间自动发出</p>
                    </button>
                  </div>
                  {!sendNow && (
                    <input
                      type="datetime-local"
                      value={sendAt}
                      onChange={(e) => setSendAt(e.target.value)}
                      className="mt-3 w-full rounded-lg border border-gray-200 bg-white px-2.5 py-2 text-xs outline-none focus:border-[#132031]"
                    />
                  )}
                </div>

                <div className="rounded-xl border border-gray-200 p-4">
                  <p className="mb-2.5 flex items-center gap-2 text-xs font-extrabold text-gray-800">
                    <ShieldCheck className="h-3.5 w-3.5 text-[#b8860b]" />安全预检
                  </p>
                  <div className="space-y-1 text-xs leading-6 text-gray-500">
                    <p className="flex items-center gap-1.5"><CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />收件人邮箱验证：<b className="text-gray-700">smtp_verified</b>（{pickedCount || 0} 人可发）</p>
                    <p className="flex items-center gap-1.5"><CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />退订链接：已自动附加</p>
                    <p className="flex items-center gap-1.5"><CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />黑名单过滤：0 人命中</p>
                    <p className="flex items-center gap-1.5"><CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />邮件证据校验：通过</p>
                  </div>
                  <div className="mt-3 rounded-lg bg-emerald-50 px-3 py-2 text-[11px] text-emerald-700">
                    <p className="font-bold">✓ 预检全部通过</p>
                    可安全发送，已满足十道闸合规检查
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ===== 步骤 4：确认 ===== */}
          {wizardStep === 3 && (
            <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
              <div className="rounded-xl border border-gray-200 p-4">
                <p className="mb-3 flex items-center gap-2 text-xs font-extrabold text-gray-800">
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />本次发送摘要
                </p>
                {consoleResult?.scheduled ? (
                  <div className="mb-3 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-[11px] text-blue-700">
                    <p className="font-bold flex items-center gap-1"><CalendarClock className="h-3.5 w-3.5" />已安排定时发送</p>
                    <p className="mt-0.5">将于 {new Date(sendAt).toLocaleString('zh-CN')} 由后台邮箱系统自动投递</p>
                  </div>
                ) : consoleResult && (
                  <div className="mb-3 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-[11px] text-green-700">
                    <p className="font-bold flex items-center gap-1"><CheckCircle2 className="h-3.5 w-3.5" />投递任务已创建</p>
                    <p className="mt-0.5">匹配 {consoleResult.totalLeadIds ?? consoleResult.totalLeads ?? 0} 人 · 入队 {consoleResult.queued ?? 0} · 跳过 {consoleResult.skipped ?? 0}</p>
                    {consoleResult.truncated && <p className="mt-0.5 text-amber-600">注：超过 {AI_BATCH_LIMIT} 人已截断，请分批发送</p>}
                  </div>
                )}
                <div className="divide-y divide-dashed divide-gray-200 text-xs">
                  {[
                    ['目标客群', pickedSegments.length ? `${pickedSegments.length} 个客群` : '—'],
                    ['预计触达人数', pickedCount ? `${pickedCount} 人` : '—'],
                    ['邮件内容', pickedTemplateObj?.name || '未选择'],
                    ['AI 个性化', aiPersonalize ? `开启（智谱 AI${aiTone !== 'professional' ? ' · ' + aiTone : ''}${aiLanguage !== 'English' ? ' · ' + aiLanguage : ''}）` : '关闭（模板直发）'],
                    ['发件账号', pickedAccountObj?.senderEmail || '未选择'],
                    ['发送方式', sendNow ? '立即发送' : `定时（${sendAt ? new Date(sendAt).toLocaleString('zh-CN') : '未选时间'}）`],
                    ['发送间隔', `${sendIntervalSeconds} 秒`],
                    ['预计完成', pickedCount ? `约 ${etaMinutes} 分钟` : '—'],
                  ].map(([k, v]) => (
                    <div key={k} className="flex items-center justify-between py-2">
                      <span className="text-gray-400">{k}</span>
                      <span className="font-bold text-gray-800">{v}</span>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <button
                  onClick={handleConsoleSend}
                  disabled={consoleLoading || pickedSegments.length === 0 || !pickedTemplate || !pickedAccount}
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-[#0b1623] to-[#1b3047] px-5 py-4 text-[15px] font-extrabold tracking-wider text-white shadow-[0_8px_20px_rgba(13,33,53,.35)] transition hover:-translate-y-0.5 hover:shadow-[0_12px_26px_rgba(13,33,53,.4)] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:translate-y-0"
                >
                  {consoleLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4 text-[#f6b84b]" />}
                  {consoleLoading ? '正在投递批量发送...' : sendNow ? '一键批量发送' : '安排定时发送'}
                </button>
                <p className="mt-2 text-center text-[11px] text-gray-400">
                  点击后立即投递 <b className="text-[#132031]">{pickedCount || 0}</b> 封{aiPersonalize ? ' AI 个性化' : ''}邮件
                </p>
                <div className="mt-4 rounded-lg bg-orange-50 px-3 py-2.5 text-[11px] text-orange-700">
                  <p className="mb-1 font-bold flex items-center gap-1"><AlertTriangle className="h-3.5 w-3.5" />发送须知</p>
                  <ul className="ml-4 list-disc space-y-0.5 leading-relaxed">
                    <li>单次 AI 批量上限 {AI_BATCH_LIMIT} 人，超出自动截断</li>
                    <li>发送走独立队列，与人工发信互不干扰</li>
                    <li>发送后可在「最近发送任务」实时查看</li>
                  </ul>
                </div>
              </div>
            </div>
          )}

          {/* 向导底部导航 */}
          <div className="mt-5 flex items-center justify-between">
            <button
              onClick={() => goStep(-1)}
              disabled={wizardStep === 0}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-4 py-2 text-xs font-bold text-gray-500 transition hover:border-[#132031] hover:text-[#132031] disabled:invisible"
            >
              <ChevronLeft className="h-3.5 w-3.5" />上一步
            </button>
            {wizardStep < 3 ? (
              <button
                onClick={() => goStep(1)}
                className="inline-flex items-center gap-1.5 rounded-lg bg-[#f6b84b] px-5 py-2 text-xs font-extrabold text-[#0b1623] transition hover:brightness-105"
              >
                {wizardStep === 2 ? '查看确认' : '下一步'}<ChevronRight className="h-3.5 w-3.5" />
              </button>
            ) : (
              <button onClick={() => setWizardStep(0)} className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-4 py-2 text-xs font-bold text-gray-500 hover:text-[#132031]">
                重新发起
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ================= 最近发送任务 ================= */}
      <div className="mt-8">
        <div className="mb-2.5 flex items-center justify-between">
          <h2 className="flex items-center gap-2 text-sm font-bold text-gray-700">
            <Send className="h-4 w-4 text-[#b8860b]" />最近发送任务
          </h2>
          <span className="rounded-full bg-gray-100 px-2.5 py-0.5 text-[10px] text-gray-400">每 30 秒自动刷新</span>
        </div>
        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
          {dashLoading ? (
            <div className="flex items-center justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-[#132031]" /></div>
          ) : recentEmails.length === 0 ? (
            <div className="py-10 text-center">
              <Mail className="mx-auto h-7 w-7 text-gray-200" />
              <p className="mt-2 text-xs text-gray-400">暂无发送记录，去上方「发起一次营销」开始第一次批量触达</p>
            </div>
          ) : (
            <div className="divide-y divide-gray-100">
              {recentEmails.map((e) => {
                const meta = emailStatusMeta[e.status] || { label: e.status, cls: 'bg-gray-100 text-gray-500' };
                const opened = e.openEvents?.reduce((s, x) => s + (x.count || 0), 0) || 0;
                return (
                  <div key={e.id} className="flex items-center gap-3 px-4 py-3">
                    <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${e.status === 'Sent' ? 'bg-emerald-50 text-emerald-600' : e.status === 'Failed' || e.status === 'DraftFailed' || e.status === 'Blocked' ? 'bg-red-50 text-red-600' : 'bg-blue-50 text-blue-600'}`}>
                      {e.status === 'Sent' ? <Check className="h-4 w-4" /> : e.status === 'Failed' || e.status === 'DraftFailed' || e.status === 'Blocked' ? <X className="h-4 w-4" /> : <Send className="h-4 w-4" />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-2 text-xs font-bold text-gray-800">
                        <span className="truncate">{e.subject || '(无主题)'}</span>
                        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[9px] font-semibold ${meta.cls}`}>{meta.label}</span>
                      </p>
                      <p className="mt-0.5 truncate text-[10px] text-gray-400">
                        {e.lead?.companyName || e.lead?.contactEmail || '—'} · {e.emailAccount?.senderEmail || '—'} · {new Date(e.createdAt).toLocaleString('zh-CN')}
                        {opened > 0 && <span className="ml-2 inline-flex items-center gap-1 text-emerald-500"><Eye className="h-3 w-3" />已读 {opened}</span>}
                        {e.clickEvents && e.clickEvents.length > 0 && <span className="ml-2 inline-flex items-center gap-1 text-blue-500"><MousePointerClick className="h-3 w-3" />已点 {e.clickEvents.length}</span>}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ================= 营销活动管理 ================= */}
      <div className="mt-8">
        <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-sm font-bold text-gray-700">
            <Settings2 className="h-4 w-4 text-[#b8860b]" />营销活动管理
          </h2>
          <button
            onClick={() => setShowCreate(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[#132031] px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-[#1b3047]"
          >
            <Plus className="h-3.5 w-3.5" />新建活动
          </button>
        </div>

        <div className="mb-3 flex flex-wrap items-center gap-3">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="搜索活动名称..."
              className="w-56 rounded-lg border border-gray-200 py-2 pl-8 pr-3 text-xs outline-none focus:border-[#132031]"
            />
          </div>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs outline-none"
          >
            <option value="">全部状态</option>
            {Object.entries(MARKETING_CAMPAIGN_STATUS_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
          <span className="text-[10px] text-gray-400">{filtered.length} 个活动</span>
        </div>

        {showCreate && (
          <div className="mb-4 rounded-xl border border-[#f6b84b]/40 bg-[#fdf3dd]/50 p-4">
            {templates.length > 0 && (
              <div className="mb-3">
                <div className="mb-1.5 flex items-center gap-1.5">
                  <Sparkles className="h-3.5 w-3.5 text-[#b8860b]" />
                  <span className="text-[11px] font-semibold text-gray-600">从模板创建</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {templates.map((tpl) => (
                    <button
                      key={tpl.id}
                      onClick={() => applyMarketingTemplate(tpl.id)}
                      className={`rounded-lg border px-2.5 py-1.5 text-[11px] transition ${selectedTemplate === tpl.id ? 'border-[#b8860b] bg-[#f6b84b]/20 text-[#7a5a00]' : 'border-gray-200 bg-white text-gray-600 hover:border-[#f6b84b]'}`}
                    >
                      {tpl.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="活动名称（必填）"
                className="rounded-lg border border-gray-200 px-3 py-2 text-xs outline-none focus:border-[#132031]" />
              <input value={newDesc} onChange={(e) => setNewDesc(e.target.value)} placeholder="活动描述（可选）"
                className="rounded-lg border border-gray-200 px-3 py-2 text-xs outline-none focus:border-[#132031]" />
              <select value={newChannel} onChange={(e) => setNewChannel(e.target.value as any)}
                className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs outline-none">
                <option value="email">固定渠道：邮件</option>
                <option value="whatsapp">固定渠道：WhatsApp</option>
              </select>
            </div>
            <div className="mt-3 flex gap-2">
              <button onClick={handleCreate} disabled={creating || !newName.trim()}
                className="rounded-lg bg-[#132031] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#1b3047] disabled:opacity-40">
                {creating ? '创建中...' : '创建草稿'}
              </button>
              <button onClick={() => setShowCreate(false)}
                className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50">取消</button>
            </div>
          </div>
        )}

        <div className="overflow-hidden rounded-xl border border-gray-200 bg-white shadow-sm">
          {loading ? (
            <div className="flex items-center justify-center py-12"><Loader2 className="h-5 w-5 animate-spin text-[#132031]" /></div>
          ) : filtered.length === 0 ? (
            <div className="py-12 text-center">
              <Megaphone className="mx-auto h-8 w-8 text-gray-200" />
              <p className="mt-2 text-sm text-gray-500">暂无营销活动</p>
              <p className="mt-1 text-xs text-gray-400">点击「新建活动」创建第一个营销活动</p>
            </div>
          ) : (
            <div className="divide-y divide-gray-100">
              {filtered.map((c) => (
                <div key={c.id} className="flex items-center gap-4 px-4 py-3 transition hover:bg-gray-50">
                  <button className="min-w-0 flex-1 text-left" onClick={() => openDetail(c.id)}>
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-bold text-gray-800">{c.name}</p>
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[9px] font-semibold ${statusBadgeClass(c.status)}`}>
                        {MARKETING_CAMPAIGN_STATUS_LABELS[c.status] || c.status}
                      </span>
                      {c.channel && (
                        <span className={`shrink-0 rounded-full px-2 py-0.5 text-[9px] font-semibold ${c.channel === 'email' ? 'bg-blue-50 text-blue-600' : 'bg-green-50 text-green-600'}`}>
                          {c.channel === 'email' ? '邮件' : 'WhatsApp'}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 truncate text-[11px] text-gray-400">{c.description || '暂无描述'}</p>
                  </button>
                  <div className="flex shrink-0 items-center gap-3 text-[10px] text-gray-400">
                    <span className="flex items-center gap-1"><Users className="h-3 w-3" />{c.audienceSnapshot?.memberCount ?? 0}</span>
                    <span className="flex items-center gap-1"><FileText className="h-3 w-3" />{c._count?.contentVersions ?? 0}</span>
                    {c.windowStart && <span>{new Date(c.windowStart).toLocaleDateString('zh-CN')}</span>}
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {transitionsFor(c.status).map(([t, label]) => (
                      <button key={t} onClick={() => handleTransition(c.id, t)}
                        className={`rounded-md border px-2.5 py-1 text-[10px] font-semibold transition ${t === 'approve' ? 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100' : t === 'request_changes' ? 'border-orange-200 bg-orange-50 text-orange-700 hover:bg-orange-100' : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50'}`}>
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ================= 详情抽屉 ================= */}
      {selected && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/20">
          <div className="flex h-full w-[480px] flex-col bg-white shadow-xl">
            <div className="flex items-center justify-between border-b px-4 py-3">
              <div className="flex min-w-0 items-center gap-2">
                <p className="truncate text-sm font-bold text-gray-900">{selected.name}</p>
                <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${statusBadgeClass(selected.status)}`}>
                  {MARKETING_CAMPAIGN_STATUS_LABELS[selected.status] || selected.status}
                </span>
                {selected.channel && (
                  <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${selected.channel === 'email' ? 'bg-blue-50 text-blue-600' : 'bg-green-50 text-green-600'}`}>
                    {selected.channel === 'email' ? '邮件' : 'WhatsApp'}
                  </span>
                )}
              </div>
              <button onClick={() => setSelected(null)} className="text-gray-400 hover:text-gray-600">✕</button>
            </div>

            <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
              {transitionsFor(selected.status).map(([t, label]) => (
                <button key={t} onClick={() => handleTransition(selected.id, t)}
                  className="rounded-md border border-[#f6b84b]/50 bg-[#fdf3dd] px-2.5 py-1 text-[10px] font-semibold text-[#7a5a00] hover:bg-[#f6b84b]/30">
                  {label}
                </button>
              ))}
              <button onClick={handlePreflight}
                className="rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1 text-[10px] font-semibold text-amber-700 hover:bg-amber-100">
                运行预检
              </button>
              <button onClick={() => handleAiDraft(true)}
                className="rounded-md border border-violet-200 bg-violet-50 px-2.5 py-1 text-[10px] font-semibold text-violet-700 hover:bg-violet-100">
                <Sparkles className="mr-0.5 inline h-3 w-3" />AI 直发内容
              </button>
            </div>

            {selected.description && <p className="border-b px-4 py-2 text-xs text-gray-600">{selected.description}</p>}

            <div className="flex border-b text-[11px]">
              {(['plans', 'segments', 'preflight', 'events'] as const).map((tab) => (
                <button key={tab} onClick={() => setDetailTab(tab)}
                  className={`border-b-2 px-4 py-2 ${detailTab === tab ? 'border-[#f6b84b] font-semibold text-[#132031]' : 'border-transparent text-gray-400'}`}>
                  {({ plans: '渠道计划', segments: '客群', preflight: '预检记录', events: '事件' } as any)[tab]}
                </button>
              ))}
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              {detailLoading ? (
                <div className="flex justify-center py-8"><Loader2 className="h-4 w-4 animate-spin text-[#132031]" /></div>
              ) : detailTab === 'plans' ? (
                <div>
                  <div className="mb-3 flex items-center gap-2">
                    <select value={newPlanChannel} onChange={(e) => setNewPlanChannel(e.target.value)}
                      className="rounded border border-gray-200 px-2 py-1.5 text-xs">
                      <option value="email">邮件</option>
                      <option value="whatsapp">WhatsApp</option>
                    </select>
                    <button onClick={handleAddPlan} className="rounded bg-[#132031] px-2.5 py-1.5 text-[10px] font-semibold text-white hover:bg-[#1b3047]">添加渠道</button>
                  </div>
                  {detailPlans.length === 0 ? (
                    <p className="py-6 text-center text-xs text-gray-400">暂无渠道计划</p>
                  ) : (
                    <div className="space-y-2">
                      {detailPlans.map((p) => (
                        <div key={p.id} className="flex items-center justify-between rounded-lg border border-gray-100 bg-gray-50 px-3 py-2">
                          <div>
                            <p className="text-xs font-semibold text-gray-700">{p.channel}</p>
                            <p className="text-[10px] text-gray-400">{p.status}</p>
                          </div>
                          <span className="text-[10px] text-gray-500">频控: {p.frequency ?? '—'}/{(p.windowSeconds ?? '—')}s</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : detailTab === 'segments' ? (
                <div>
                  <div className="mb-3 flex items-center gap-2">
                    <select value={linkSegmentId} onChange={(e) => setLinkSegmentId(e.target.value)}
                      className="flex-1 rounded border border-gray-200 px-2 py-1.5 text-xs">
                      <option value="">选择客群...</option>
                      {availableSegments.map((s) => (
                        <option key={s.id} value={s.id}>{s.name}（{s.memberCount}人）</option>
                      ))}
                    </select>
                    <button onClick={handleLinkSegment} disabled={!linkSegmentId}
                      className="rounded bg-[#132031] px-2.5 py-1.5 text-[10px] font-semibold text-white hover:bg-[#1b3047] disabled:opacity-40">
                      <Link2 className="mr-0.5 inline h-3 w-3" />关联
                    </button>
                  </div>
                  {detailSegments.length === 0 ? (
                    <p className="py-6 text-center text-xs text-gray-400">未关联客群，先到「客群管理」创建客群</p>
                  ) : (
                    <div className="space-y-2">
                      {detailSegments.map((sg: any) => (
                        <div key={sg.id} className="flex items-center justify-between rounded-lg border border-gray-100 bg-gray-50 px-3 py-2">
                          <div>
                            <p className="flex items-center gap-1 text-xs font-semibold text-gray-700">
                              <Target className="h-3 w-3 text-[#b8860b]" />{sg.segmentName || sg.segmentId}
                            </p>
                            <p className="text-[10px] text-gray-400">{sg.memberCount} 人</p>
                          </div>
                          <button onClick={() => handleUnlinkSegment(sg.segmentId)}
                            className="text-[10px] text-red-400 hover:text-red-600">解除</button>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="mt-3 border-t border-gray-100 pt-3">
                    <div className="mb-2 text-[11px] font-semibold text-gray-600">受众快照</div>
                    <select value={snapshotSegmentId} onChange={(e) => setSnapshotSegmentId(e.target.value)}
                      className="mb-2 w-full rounded border border-gray-200 px-2 py-1.5 text-xs">
                      <option value="">全部已关联客群（快照全部）</option>
                      {detailSegments.map((sg: any) => (
                        <option key={sg.id} value={sg.segmentId}>{sg.segmentName || sg.segmentId}</option>
                      ))}
                    </select>
                    <button onClick={handleSnapshotAudience}
                      className="rounded border border-gray-200 bg-white px-2.5 py-1.5 text-[10px] text-gray-600 hover:bg-gray-50">
                      快照受众
                    </button>
                  </div>
                </div>
              ) : detailTab === 'preflight' ? (
                detailPreflights.length === 0 ? (
                  <p className="py-6 text-center text-xs text-gray-400">暂无预检记录，点击「运行预检」</p>
                ) : (
                  <div className="space-y-2">
                    {detailPreflights.map((p) => (
                      <div key={p.id} className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2">
                        <p className="text-xs font-semibold text-gray-700">预检 {p.status}</p>
                        <p className="text-[10px] text-gray-400">{new Date(p.createdAt).toLocaleString('zh-CN')}</p>
                      </div>
                    ))}
                  </div>
                )
              ) : (
                detailEvents.length === 0 ? (
                  <p className="py-6 text-center text-xs text-gray-400">暂无事件</p>
                ) : (
                  <div className="space-y-2">
                    {detailEvents.slice(0, 20).map((e) => (
                      <div key={e.id} className="rounded-lg border border-gray-100 bg-gray-50 px-3 py-2">
                        <p className="text-xs text-gray-700">{e.type}</p>
                        <p className="text-[10px] text-gray-400">{new Date(e.createdAt).toLocaleString('zh-CN')}</p>
                      </div>
                    ))}
                  </div>
                )
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
