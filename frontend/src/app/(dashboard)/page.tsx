'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  Bot,
  CalendarCheck,
  CircleDollarSign,
  Clock3,
  FileText,
  Loader2,
  MessageCircle,
  MousePointer,
  RefreshCw,
  Send,
  Sparkles,
  Target,
  UserPlus,
  Users,
} from 'lucide-react';
import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Card } from '@/components/ui/card';
import api from '@/lib/api';
import { useAuthStore } from '@/store/authStore';
import { getAssistantBrief, type AssistantBrief } from '@/lib/agent-api';
import { listMarketingCampaigns } from '@/lib/marketing-campaign-api';
import type { MarketingCampaign } from '@/types/marketing-campaign';
import { AGENT_KIND_LABELS, AGENT_STATUS_LABELS } from '@/types/agent';
import { cn } from '@/lib/utils';
import { getApiErrorMessage } from '@/lib/api-error';
import { GlobalClocks } from '@/components/dashboard/global-clocks';
import { FxRatesBar } from '@/components/dashboard/fx-rates';
import { DiagnosisCard } from '@/components/dashboard/diagnosis-card';
import {
  getCampaignEngagement,
  getDeliveryRuns,
  getEngagementTrends,
  getLeadSources,
  getWhatsappStats,
  type CampaignEngagementRow,
  type DeliveryRun,
  type EngagementTrendDaily,
  type LeadSourceEntry,
  type WhatsappStats,
} from '@/lib/dashboard-api';

const statusLabels: Record<string, string> = {
  new: '新客户',
  contacted: '已联系',
  qualified: '已确认',
  quoted: '已报价',
  negotiating: '谈判中',
  won: '已成交',
  lost: '已流失',
  unknown: '未分类',
};

const runStatusLabels: Record<string, string> = {
  PENDING: '排队中',
  CLAIMED: '执行中',
  SUCCEEDED: '已完成',
  FAILED: '失败',
  BLOCKED: '已拦截',
  DEAD_LETTER: '死信',
};

const sourceLabels: Record<string, string> = {
  alibaba: '阿里国际站',
  linkedin: 'LinkedIn',
  website: '独立站',
  google_ads: 'Google Ads',
  whatsapp: 'WhatsApp',
  referral: '展会/其他',
  unknown: '未标注',
};

const SOURCE_COLORS: Record<string, string> = {
  alibaba: '#f97316',
  linkedin: '#0ea5e9',
  website: '#1d4ed8',
  google_ads: '#22d3ee',
  whatsapp: '#22c55e',
  referral: '#94a3b8',
};

function formatTime(value?: string | null) {
  if (!value) return '—';
  return new Date(value).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function DashboardPage() {
  const { user, activeCompanyId } = useAuthStore();
  const companyId = activeCompanyId || user?.companies?.[0]?.id || '';
  const [brief, setBrief] = useState<AssistantBrief | null>(null);
  const [overview, setOverview] = useState<any>(null);
  const [engagementTrends, setEngagementTrends] = useState<EngagementTrendDaily[]>([]);
  const [sources, setSources] = useState<LeadSourceEntry[]>([]);
  const [whatsappStats, setWhatsappStats] = useState<WhatsappStats | null>(null);
  const [campaigns, setCampaigns] = useState<MarketingCampaign[]>([]);
  const [campaignEngagement, setCampaignEngagement] = useState<CampaignEngagementRow[]>([]);
  const [deliveryRuns, setDeliveryRuns] = useState<DeliveryRun[]>([]);
  const [emailTrends, setEmailTrends] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const loadingRef = useRef(false);

  const load = useCallback(async () => {
    if (!companyId || loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setError('');
    try {
      const [briefRes, overviewRes, emailTrendRes, engagementRes, sourcesRes, whatsappRes, campaignsRes, deliveryRes] =
        await Promise.allSettled([
          getAssistantBrief(companyId),
          api.get('/analytics/overview', { params: { days: 30 } }),
          api.get('/analytics/email-trends', { params: { days: 30 } }),
          getEngagementTrends(companyId, 14),
          getLeadSources(companyId),
          getWhatsappStats(companyId),
          listMarketingCampaigns(),
          getDeliveryRuns(companyId, 10),
        ]);

      if (briefRes.status === 'fulfilled') setBrief(briefRes.value);
      if (overviewRes.status === 'fulfilled') setOverview(overviewRes.value?.data ?? null);
      if (emailTrendRes.status === 'fulfilled') {
        const data = emailTrendRes.value?.data;
        setEmailTrends(
          Array.isArray((data as any)?.dailyEmailTrend) ? (data as any).dailyEmailTrend : [],
        );
      }
      if (engagementRes.status === 'fulfilled') setEngagementTrends(engagementRes.value);
      if (sourcesRes.status === 'fulfilled') setSources(sourcesRes.value);
      if (whatsappRes.status === 'fulfilled') setWhatsappStats(whatsappRes.value);
      if (campaignsRes.status === 'fulfilled') setCampaigns(campaignsRes.value);
      if (deliveryRes.status === 'fulfilled') {
        setDeliveryRuns(deliveryRes.value.runs);
        if (deliveryRes.value.runs.length && !campaignEngagement.length) {
          const eng = await getCampaignEngagement(companyId, 8).catch(() => []);
          setCampaignEngagement(eng);
        }
      }
    } catch (err: unknown) {
      setError(getApiErrorMessage(err, '暂时无法读取首页数据'));
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => {
    void load();
  }, [load]);

  const pipeline = useMemo(
    () => Object.entries(brief?.leadStatusCounts || {}).sort((a, b) => b[1] - a[1]),
    [brief],
  );
  const maxStage = Math.max(1, ...pipeline.map(([, count]) => count));
  const m = brief?.metrics;
  const email = overview?.email || {};
  const greeting =
    new Date().getHours() < 12 ? '早上好' : new Date().getHours() < 18 ? '下午好' : '晚上好';

  const funnel = useMemo(() => {
    const sent = email.sent || 0;
    const opened = email.opened || 0;
    const clicked = email.clicked || 0;
    const replied = email.replied || 0;
    const won = pipeline.find(([status]) => status === 'won')?.[1] || 0;
    const stages = [
      { label: '已触达', value: sent, color: 'bg-indigo-500' },
      { label: '已打开', value: opened, color: 'bg-violet-500' },
      { label: '已点击', value: clicked, color: 'bg-blue-500' },
      { label: '已回复', value: replied, color: 'bg-sky-500' },
      { label: '已成交', value: won, color: 'bg-emerald-500' },
    ];
    const maxValue = Math.max(1, sent);
    return stages.map((stage) => ({ ...stage, pct: (stage.value / maxValue) * 100 }));
  }, [email, pipeline]);

  const trendAvg = useMemo(() => {
    if (!engagementTrends.length) return { openRate: 0, clickRate: 0, replyRate: 0 };
    const avg = (key: 'openRate' | 'clickRate' | 'replyRate') =>
      engagementTrends.reduce((sum, item) => sum + (item[key] || 0), 0) / engagementTrends.length;
    return { openRate: avg('openRate'), clickRate: avg('clickRate'), replyRate: avg('replyRate') };
  }, [engagementTrends]);

  const campaignChannelCount = useMemo(
    () => ({
      email: campaigns.filter((c) => c.channel === 'email').length,
      whatsapp: campaigns.filter((c) => c.channel === 'whatsapp').length,
    }),
    [campaigns],
  );

  const campaignStatusData = useMemo(() => {
    const counts: Record<string, number> = {};
    campaigns.forEach((c) => {
      counts[c.status] = (counts[c.status] || 0) + 1;
    });
    return Object.entries(counts).map(([status, count]) => ({ status, count }));
  }, [campaigns]);

  const campaignStatusLabels: Record<string, string> = {
    DRAFT: '草稿',
    ACTIVE: '进行中',
    COMPLETED: '已完成',
    ARCHIVED: '已归档',
    PAUSED: '已暂停',
    FAILED: '已失败',
  };

  const sourceData = useMemo(
    () =>
      sources.slice(0, 6).map((entry) => ({
        ...entry,
        label: sourceLabels[entry.source] || entry.source,
      })),
    [sources],
  );

  const countryData = useMemo(() => {
    const raw = Array.isArray(overview?.countryDistribution)
      ? overview.countryDistribution
      : Array.isArray(overview?.countryTop)
        ? overview.countryTop
        : [];
    return raw.slice(0, 10);
  }, [overview]);

  if (loading && !brief)
    return (
      <div className="flex min-h-[60vh] items-center justify-center gap-2 text-sm text-slate-500">
        <Loader2 className="h-5 w-5 animate-spin text-indigo-600" />
        正在读取真实业务数据……
      </div>
    );

  return (
    <div className="mx-auto max-w-[1500px] space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <GlobalClocks />
        <FxRatesBar />
      </div>

      <section className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-slate-500">
            {greeting}，{user?.firstName || '茶茶'}
          </p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-slate-950">
            今天的业务驾驶舱
          </h1>
          <p className="mt-1 text-xs text-slate-400">
            只展示 CRM 真实数据，不再混入演示客户或虚构趋势。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => void load()}
            className="inline-flex items-center gap-1.5 rounded-lg border bg-white px-3 py-2 text-xs text-slate-600 hover:bg-slate-50"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            刷新
          </button>
          <Link
            href="/ai-workbench"
            className="inline-flex items-center gap-1.5 rounded-lg bg-slate-950 px-3 py-2 text-xs font-semibold text-white"
          >
            <Sparkles className="h-3.5 w-3.5" />
            打开 AI 业务助理
          </Link>
        </div>
      </section>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <DiagnosisCard companyId={companyId} />

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4 xl:grid-cols-8">
        <MetricCard
          href="/leads"
          icon={Users}
          label="客户总数"
          value={m?.leads ?? 0}
          note={`今日新增 ${m?.newLeads ?? 0}`}
          tone="indigo"
        />
        <MetricCard
          href="/follow-ups"
          icon={CalendarCheck}
          label="今日待办"
          value={m?.todayReminders ?? 0}
          note={`全部待办 ${m?.pendingReminders ?? 0}`}
          tone="blue"
        />
        <MetricCard
          href="/follow-ups"
          icon={Clock3}
          label="逾期事项"
          value={m?.overdueReminders ?? 0}
          note={m?.overdueReminders ? '需要优先处理' : '当前无逾期'}
          tone="red"
        />
        <MetricCard
          href="/quotes"
          icon={CircleDollarSign}
          label="待处理报价"
          value={m?.draftQuotes ?? 0}
          note="草稿与待审核"
          tone="amber"
        />
        <MetricCard
          href="/ai-workbench"
          icon={Bot}
          label="AI 进行中"
          value={m?.activeAgentRuns ?? 0}
          note="可在事务板查看"
          tone="violet"
        />
        <MetricCard
          href="/analytics"
          icon={Send}
          label="已发邮件"
          value={email.sent ?? 0}
          note={`打开率 ${email.openRate ?? 0}%`}
          tone="emerald"
        />
        <MetricCard
          href="/analytics"
          icon={MousePointer}
          label="邮件打开"
          value={email.opened ?? 0}
          note={`点击 ${email.clicked ?? 0} · 回复 ${email.replied ?? 0}`}
          tone="cyan"
        />
        <MetricCard
          href="/whatsapp/chat"
          icon={MessageCircle}
          label="WhatsApp 会话"
          value={whatsappStats?.conversations ?? 0}
          note={`未读 ${whatsappStats?.unreadConversations ?? 0}`}
          tone="green"
        />
      </section>

      <section className="grid gap-4 xl:grid-cols-5">
        <Card className="border-slate-200 xl:col-span-2">
          <div className="flex items-center justify-between border-b px-5 py-4">
            <div>
              <h2 className="font-semibold text-slate-900">触达漏斗</h2>
              <p className="mt-1 text-xs text-slate-400">邮件触达 → 打开 → 点击 → 回复 → 成交</p>
            </div>
            <Link href="/analytics" className="text-xs font-medium text-indigo-700">
              数据分析
            </Link>
          </div>
          <div className="space-y-3 p-5">
            {funnel.map((stage) => (
              <div key={stage.label}>
                <div className="mb-1 flex items-center justify-between text-xs">
                  <span className="text-slate-600">{stage.label}</span>
                  <span className="font-semibold text-slate-800">{stage.value}</span>
                </div>
                <div className="h-2.5 overflow-hidden rounded-full bg-slate-100">
                  <div
                    className={cn('h-full rounded-full transition-all duration-500', stage.color)}
                    style={{ width: `${stage.pct}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card className="border-slate-200">
          <div className="border-b px-5 py-4">
            <h2 className="font-semibold text-slate-900">询盘来源渠道</h2>
            <p className="mt-1 text-xs text-slate-400">客户来源分布</p>
          </div>
          <div className="p-5">
            {sourceData.length ? (
              <>
                <div className="h-44">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie
                        data={sourceData}
                        dataKey="count"
                        nameKey="label"
                        innerRadius="55%"
                        outerRadius="85%"
                        paddingAngle={2}
                        strokeWidth={2}
                      >
                        {sourceData.map((entry) => (
                          <Cell
                            key={entry.source}
                            fill={SOURCE_COLORS[entry.source] || '#94a3b8'}
                          />
                        ))}
                      </Pie>
                      <Tooltip formatter={(value: unknown) => `${value} 条`} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <div className="mt-2 space-y-1.5">
                  {sourceData.map((entry) => (
                    <div key={entry.source} className="flex items-center justify-between text-xs">
                      <span className="flex items-center gap-1.5 text-slate-600">
                        <span
                          className="h-2 w-2 rounded-full"
                          style={{ background: SOURCE_COLORS[entry.source] || '#94a3b8' }}
                        />
                        {entry.label}
                      </span>
                      <span className="font-semibold text-slate-800">
                        {entry.count}
                        <span className="ml-1 text-[10px] font-normal text-slate-400">
                          {entry.pct?.toFixed(1) ?? 0}%
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <EmptyState icon={Users} text="暂无询盘来源数据" action="查看客户" href="/leads" />
            )}
          </div>
        </Card>

        <Card className="border-slate-200 xl:col-span-2">
          <div className="border-b px-5 py-4">
            <h2 className="font-semibold text-slate-900">海外市场分布 Top10</h2>
            <p className="mt-1 text-xs text-slate-400">客户国家/地区排名</p>
          </div>
          <div className="p-5">
            {countryData.length ? (
              <div className="space-y-2">
                {countryData.map((row: any, index: number) => {
                  const count = Number(row.count ?? 0);
                  const max = Math.max(1, ...countryData.map((r: any) => Number(r.count ?? 0)));
                  return (
                    <div key={row.country || index} className="flex items-center gap-3">
                      <span className="w-5 text-right text-[10px] text-slate-400">{index + 1}</span>
                      <span className="w-20 truncate text-xs text-slate-600">{row.country}</span>
                      <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-slate-100">
                        <div
                          className={cn(
                            'h-full rounded-full transition-all duration-500',
                            index < 3 ? 'bg-indigo-500' : 'bg-indigo-200',
                          )}
                          style={{ width: `${(count / max) * 100}%` }}
                        />
                      </div>
                      <span className="w-10 text-right text-xs font-semibold text-slate-800">
                        {count}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <EmptyState icon={Users} text="暂无市场分布数据" action="查看客户" href="/leads" />
            )}
          </div>
        </Card>
      </section>

      <section className="grid gap-4 xl:grid-cols-3">
        <Card className="border-slate-200 xl:col-span-2">
          <div className="flex items-center justify-between border-b px-5 py-4">
            <div>
              <h2 className="font-semibold text-slate-900">邮件互动率趋势</h2>
              <p className="mt-1 text-xs text-slate-400">近 14 天打开/点击/回复率（柱 = 发送量）</p>
            </div>
            <Link href="/analytics" className="text-xs font-medium text-indigo-700">
              数据分析
            </Link>
          </div>
          <div className="h-64 p-5">
            {engagementTrends.length ? (
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={engagementTrends}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                  <YAxis yAxisId="left" tick={{ fontSize: 10 }} />
                  <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 10 }} unit="%" />
                  <Tooltip />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar yAxisId="left" dataKey="sent" name="发送量" fill="#c7d2fe" radius={[3, 3, 0, 0]} barSize={10} />
                  <Line yAxisId="right" type="monotone" dataKey="openRate" name="打开率" stroke="#6366f1" strokeWidth={2} dot={false} />
                  <Line yAxisId="right" type="monotone" dataKey="clickRate" name="点击率" stroke="#0ea5e9" strokeWidth={2} dot={false} />
                  <Line yAxisId="right" type="monotone" dataKey="replyRate" name="回复率" stroke="#10b981" strokeWidth={2} dot={false} />
                </ComposedChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-full items-center justify-center text-xs text-slate-400">
                暂无互动数据
              </div>
            )}
          </div>
          <div className="grid grid-cols-3 divide-x border-t">
            <RateSummary label="平均打开率" value={trendAvg.openRate} tone="indigo" />
            <RateSummary label="平均点击率" value={trendAvg.clickRate} tone="sky" />
            <RateSummary label="平均回复率" value={trendAvg.replyRate} tone="emerald" />
          </div>
        </Card>

        <Card className="border-slate-200">
          <div className="flex items-center justify-between border-b px-5 py-4">
            <div>
              <h2 className="font-semibold text-slate-900">营销活动状态</h2>
              <p className="mt-1 text-xs text-slate-400">当前渠道与状态分布</p>
            </div>
            <Link href="/marketing-campaigns" className="text-xs font-medium text-indigo-700">
              管理活动
            </Link>
          </div>
          <div className="p-5">
            <div className="flex gap-2">
              <span className="rounded-lg bg-sky-50 px-3 py-2 text-xs font-semibold text-sky-700">
                邮件 {campaignChannelCount.email}
              </span>
              <span className="rounded-lg bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700">
                WhatsApp {campaignChannelCount.whatsapp}
              </span>
            </div>
            <div className="mt-4 space-y-3">
              {campaignStatusData.length ? (
                campaignStatusData.map(({ status, count }) => (
                  <div key={status}>
                    <div className="mb-1 flex items-center justify-between text-xs">
                      <span className="text-slate-600">{campaignStatusLabels[status] || status}</span>
                      <span className="font-semibold text-slate-800">{count}</span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-violet-500"
                        style={{
                          width: `${(count / Math.max(1, campaigns.length)) * 100}%`,
                        }}
                      />
                    </div>
                  </div>
                ))
              ) : (
                <p className="py-4 text-center text-xs text-slate-400">暂无营销活动</p>
              )}
            </div>
            {campaignEngagement.length > 0 && (
              <div className="mt-4 rounded-lg border border-slate-100 bg-slate-50 p-3">
                <p className="mb-2 text-[10px] font-medium text-slate-400">最近活动互动（邮件）</p>
                {campaignEngagement.slice(0, 4).map((row) => (
                  <div key={row.id} className="flex items-center justify-between py-1 text-xs">
                    <span className="max-w-[55%] truncate text-slate-600">{row.name}</span>
                    <span className="text-slate-500">
                      打开率 <b className="text-slate-800">{row.openRate ?? 0}%</b>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Card>
      </section>

      <section className="grid gap-4 xl:grid-cols-2">
        <Card className="border-slate-200">
          <div className="flex items-center justify-between border-b px-5 py-4">
            <div>
              <h2 className="font-semibold text-slate-900">最近投放运行</h2>
              <p className="mt-1 text-xs text-slate-400">营销活动批量执行记录</p>
            </div>
            <Link href="/marketing-campaigns" className="text-xs font-medium text-indigo-700">
              全部活动
            </Link>
          </div>
          <div className="divide-y">
            {deliveryRuns.length ? (
              deliveryRuns.map((run) => (
                <div key={run.id} className="flex items-center gap-3 px-5 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-800">
                      {run.campaignName || '未命名活动'}
                    </p>
                    <p className="mt-0.5 text-[11px] text-slate-400">
                      {run.channel === 'whatsapp' ? 'WhatsApp' : '邮件'} ·{' '}
                      {run.processedCount}/{run.totalCount} · {formatTime(run.executedAt)}
                    </p>
                  </div>
                  <span
                    className={cn(
                      'shrink-0 rounded-full px-2 py-1 text-[10px]',
                      run.status === 'SUCCEEDED'
                        ? 'bg-emerald-50 text-emerald-700'
                        : run.status === 'FAILED'
                          ? 'bg-red-50 text-red-700'
                          : run.status === 'BLOCKED'
                            ? 'bg-amber-50 text-amber-700'
                            : run.status === 'CLAIMED'
                              ? 'bg-indigo-50 text-indigo-700'
                              : 'bg-slate-100 text-slate-600',
                    )}
                  >
                    {runStatusLabels[run.status] || run.status}
                  </span>
                </div>
              ))
            ) : (
              <EmptyState
                icon={Target}
                text="还没有投放运行记录"
                action="去创建营销活动"
                href="/marketing-campaigns"
              />
            )}
          </div>
        </Card>

        <Card className="border-slate-200">
          <div className="flex items-center justify-between border-b px-5 py-4">
            <div>
              <h2 className="font-semibold text-slate-900">邮件发送趋势</h2>
              <p className="mt-1 text-xs text-slate-400">近 30 天发送 / 打开 / 点击 / 失败</p>
            </div>
            <Link href="/analytics" className="text-xs font-medium text-indigo-700">
              数据分析
            </Link>
          </div>
          <div className="h-72 p-5">
            {emailTrends.length ? (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={emailTrends}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} />
                  <Tooltip />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Line type="monotone" dataKey="sent" name="发送" stroke="#10b981" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="opened" name="打开" stroke="#6366f1" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="clicked" name="点击" stroke="#f59e0b" strokeWidth={2} dot={false} />
                  <Line type="monotone" dataKey="failed" name="失败" stroke="#ef4444" strokeWidth={2} dot={false} />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-full items-center justify-center text-xs text-slate-400">
                暂无邮件趋势数据
              </div>
            )}
          </div>
        </Card>
      </section>

      <section className="grid gap-5 xl:grid-cols-[1.2fr_.8fr]">
        <Card className="overflow-hidden border-slate-200">
          <div className="flex items-center justify-between border-b px-5 py-4">
            <div>
              <h2 className="font-semibold text-slate-900">今日行动队列</h2>
              <p className="mt-1 text-xs text-slate-400">按到期时间和优先级排列</p>
            </div>
            <Link href="/follow-ups" className="text-xs font-medium text-indigo-700">
              查看全部
            </Link>
          </div>
          <div className="divide-y">
            {brief?.reminders?.length ? (
              brief.reminders.slice(0, 8).map((item) => {
                const overdue = new Date(item.dueAt).getTime() < Date.now();
                return (
                  <Link
                    href={`/follow-ups/${item.id}`}
                    key={item.id}
                    className="flex items-center gap-3 px-5 py-3.5 hover:bg-slate-50"
                  >
                    <span
                      className={cn(
                        'h-2.5 w-2.5 rounded-full',
                        item.priority === 'High'
                          ? 'bg-red-500'
                          : item.priority === 'Medium'
                            ? 'bg-amber-400'
                            : 'bg-slate-300',
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-slate-800">{item.title}</p>
                      <p className="mt-1 truncate text-xs text-slate-400">
                        {item.reason || '跟进客户并补充记录'}
                      </p>
                    </div>
                    <div
                      className={cn(
                        'shrink-0 text-right text-[11px]',
                        overdue ? 'text-red-600' : 'text-slate-400',
                      )}
                    >
                      <p>{overdue ? '已逾期' : '计划时间'}</p>
                      <p>{formatTime(item.dueAt)}</p>
                    </div>
                    <ArrowRight className="h-4 w-4 text-slate-300" />
                  </Link>
                );
              })
            ) : (
              <EmptyState
                icon={CalendarCheck}
                text="当前没有待办事项"
                action="新建跟进"
                href="/follow-ups"
              />
            )}
          </div>
        </Card>

        <Card className="border-slate-200 p-5">
          <h2 className="font-semibold text-slate-900">快捷开始</h2>
          <div className="mt-4 grid gap-2">
            <QuickAction href="/leads/new" icon={UserPlus} title="新增客户" />
            <QuickAction href="/whatsapp/chat" icon={MessageCircle} title="打开 WhatsApp" />
            <QuickAction href="/quotes/new" icon={FileText} title="新建报价单" />
            <QuickAction href="/ai-workbench" icon={Target} title="让助理整理客户" />
          </div>
          <div className="mt-4 rounded-xl bg-indigo-50 p-3 text-xs leading-5 text-indigo-900">
            <Sparkles className="mr-1 inline h-3.5 w-3.5" />
            右下角悬浮球可在任何页面随时呼出助理。
          </div>
        </Card>
      </section>

      <section className="grid gap-5 lg:grid-cols-3">
        <Card className="overflow-hidden border-slate-200 lg:col-span-2">
          <div className="flex items-center justify-between border-b px-5 py-4">
            <div>
              <h2 className="font-semibold text-slate-900">AI 助理工作状态</h2>
              <p className="mt-1 text-xs text-slate-400">所有任务均可追溯，外发操作逐次确认</p>
            </div>
            <Link href="/ai-workbench" className="text-xs font-medium text-indigo-700">
              进入工作台
            </Link>
          </div>
          <div className="divide-y">
            {brief?.runs?.length ? (
              brief.runs.slice(0, 6).map((run) => (
                <div key={run.id} className="flex items-center gap-3 px-5 py-3">
                  <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-50 text-indigo-700">
                    <Bot className="h-4 w-4" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-slate-800">
                      {AGENT_KIND_LABELS[run.kind]}
                    </p>
                    <p className="mt-0.5 text-[11px] text-slate-400">{formatTime(run.createdAt)}</p>
                  </div>
                  <span
                    className={cn(
                      'rounded-full px-2 py-1 text-[10px]',
                      run.status === 'COMPLETED'
                        ? 'bg-emerald-50 text-emerald-700'
                        : run.status === 'FAILED'
                          ? 'bg-red-50 text-red-700'
                          : 'bg-indigo-50 text-indigo-700',
                    )}
                  >
                    {AGENT_STATUS_LABELS[run.status]}
                  </span>
                </div>
              ))
            ) : (
              <EmptyState
                icon={Bot}
                text="AI 助理还没有工作记录"
                action="交代一项工作"
                href="/ai-workbench"
              />
            )}
          </div>
        </Card>

        <Card className="border-slate-200">
          <div className="border-b px-5 py-4">
            <h2 className="font-semibold text-slate-900">客户阶段分布</h2>
            <p className="mt-1 text-xs text-slate-400">来自当前公司客户资产</p>
          </div>
          <div className="space-y-3 p-5">
            {pipeline.length ? (
              pipeline.map(([status, count]) => (
                <div key={status}>
                  <div className="mb-1 flex items-center justify-between text-xs">
                    <span className="text-slate-600">{statusLabels[status] || status}</span>
                    <span className="font-semibold text-slate-800">{count}</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-violet-500"
                      style={{ width: `${Math.max(5, (count / maxStage) * 100)}%` }}
                    />
                  </div>
                </div>
              ))
            ) : (
              <EmptyState
                icon={Users}
                text="还没有客户数据"
                action="导入客户"
                href="/leads/import"
              />
            )}
          </div>
        </Card>
      </section>

      <p className="text-right text-[10px] text-slate-400">
        数据更新时间：{formatTime(brief?.generatedAt)}
      </p>
    </div>
  );
}

function MetricCard({
  href,
  icon: Icon,
  label,
  value,
  note,
  tone,
}: {
  href: string;
  icon: typeof Users;
  label: string;
  value: number;
  note: string;
  tone: 'indigo' | 'blue' | 'red' | 'amber' | 'violet' | 'emerald' | 'cyan' | 'green';
}) {
  const tones = {
    indigo: 'bg-indigo-50 text-indigo-700',
    blue: 'bg-sky-50 text-sky-700',
    red: 'bg-red-50 text-red-700',
    amber: 'bg-amber-50 text-amber-700',
    violet: 'bg-violet-50 text-violet-700',
    emerald: 'bg-emerald-50 text-emerald-700',
    cyan: 'bg-cyan-50 text-cyan-700',
    green: 'bg-green-50 text-green-700',
  };
  return (
    <Link
      href={href}
      className="group rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
    >
      <div className="flex items-center justify-between">
        <div className={cn('flex h-9 w-9 items-center justify-center rounded-lg', tones[tone])}>
          <Icon className="h-4 w-4" />
        </div>
        <ArrowRight className="h-4 w-4 text-slate-300 transition group-hover:translate-x-0.5" />
      </div>
      <p className="mt-4 text-2xl font-bold text-slate-950">{value}</p>
      <p className="mt-1 text-xs font-medium text-slate-600">{label}</p>
      <p className="mt-1 text-[10px] text-slate-400">{note}</p>
    </Link>
  );
}

function RateSummary({ label, value, tone }: { label: string; value: number; tone: string }) {
  const tones: Record<string, string> = {
    indigo: 'text-indigo-600',
    sky: 'text-sky-600',
    emerald: 'text-emerald-600',
  };
  return (
    <div className="px-5 py-3">
      <p className="text-[10px] text-slate-400">{label}</p>
      <p className={cn('mt-0.5 text-lg font-bold', tones[tone] || 'text-slate-700')}>
        {value.toFixed(1)}%
      </p>
    </div>
  );
}

function QuickAction({
  href,
  icon: Icon,
  title,
}: {
  href: string;
  icon: typeof Users;
  title: string;
}) {
  return (
    <Link
      href={href}
      className="flex items-center gap-3 rounded-lg border px-3 py-2.5 text-sm text-slate-700 hover:border-indigo-200 hover:bg-indigo-50"
    >
      <Icon className="h-4 w-4 text-indigo-600" />
      <span className="flex-1">{title}</span>
      <ArrowRight className="h-3.5 w-3.5 text-slate-300" />
    </Link>
  );
}

function EmptyState({
  icon: Icon,
  text,
  action,
  href,
}: {
  icon: typeof Users;
  text: string;
  action: string;
  href: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-5 py-10 text-center">
      <Icon className="h-8 w-8 text-slate-200" />
      <p className="mt-2 text-xs text-slate-400">{text}</p>
      <Link href={href} className="mt-3 text-xs font-medium text-indigo-700">
        {action}
      </Link>
    </div>
  );
}
