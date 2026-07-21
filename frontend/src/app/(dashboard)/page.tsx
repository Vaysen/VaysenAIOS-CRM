'use client';

import { useEffect, useMemo, useState } from 'react';
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
  RefreshCw,
  Sparkles,
  Target,
  UserPlus,
  Users,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { useAuthStore } from '@/store/authStore';
import { getAssistantBrief, type AssistantBrief } from '@/lib/agent-api';
import { AGENT_KIND_LABELS, AGENT_STATUS_LABELS } from '@/types/agent';
import { cn } from '@/lib/utils';
import { getApiErrorMessage } from '@/lib/api-error';

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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = async () => {
    if (!companyId) return;
    setLoading(true);
    setError('');
    try {
      setBrief(await getAssistantBrief(companyId));
    } catch (err: unknown) {
      setError(getApiErrorMessage(err, '暂时无法读取首页数据'));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [companyId]);

  const pipeline = useMemo(
    () => Object.entries(brief?.leadStatusCounts || {}).sort((a, b) => b[1] - a[1]),
    [brief],
  );
  const maxStage = Math.max(1, ...pipeline.map(([, count]) => count));
  const m = brief?.metrics;
  const greeting =
    new Date().getHours() < 12 ? '早上好' : new Date().getHours() < 18 ? '下午好' : '晚上好';

  if (loading)
    return (
      <div className="flex min-h-[60vh] items-center justify-center gap-2 text-sm text-slate-500">
        <Loader2 className="h-5 w-5 animate-spin text-indigo-600" />
        正在读取真实业务数据……
      </div>
    );

  return (
    <div className="mx-auto max-w-[1500px] space-y-5">
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

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <MetricCard
          href="/leads"
          icon={Users}
          label="客户总数"
          value={m?.leads || 0}
          note={`今日新增 ${m?.newLeads || 0}`}
          tone="indigo"
        />
        <MetricCard
          href="/follow-ups"
          icon={CalendarCheck}
          label="今日待办"
          value={m?.todayReminders || 0}
          note={`全部待办 ${m?.pendingReminders || 0}`}
          tone="blue"
        />
        <MetricCard
          href="/follow-ups"
          icon={Clock3}
          label="逾期事项"
          value={m?.overdueReminders || 0}
          note={m?.overdueReminders ? '需要优先处理' : '当前无逾期'}
          tone="red"
        />
        <MetricCard
          href="/quotes"
          icon={CircleDollarSign}
          label="待处理报价"
          value={m?.draftQuotes || 0}
          note="草稿与待审核"
          tone="amber"
        />
        <MetricCard
          href="/ai-workbench"
          icon={Bot}
          label="AI 进行中"
          value={m?.activeAgentRuns || 0}
          note="可在事务板查看"
          tone="violet"
        />
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

        <Card className="overflow-hidden border-slate-200">
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
  tone: 'indigo' | 'blue' | 'red' | 'amber' | 'violet';
}) {
  const tones = {
    indigo: 'bg-indigo-50 text-indigo-700',
    blue: 'bg-sky-50 text-sky-700',
    red: 'bg-red-50 text-red-700',
    amber: 'bg-amber-50 text-amber-700',
    violet: 'bg-violet-50 text-violet-700',
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
