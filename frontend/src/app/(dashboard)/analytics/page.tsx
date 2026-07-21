'use client';

import { useEffect, useMemo, useState } from 'react';
import api from '@/lib/api';
import { Activity, AlertTriangle, BarChart3, Inbox, Mail, MousePointer, Send, Users } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

const ranges = [
  { label: '近7天', days: 7 },
  { label: '近30天', days: 30 },
  { label: '近90天', days: 90 },
  { label: '自定义', days: 0 },
];

const statusColors: Record<string, string> = {
  Queued: '#3b82f6',
  QueuedToSend: '#2563eb',
  Sending: '#f59e0b',
  Sent: '#10b981',
  Failed: '#ef4444',
  DraftFailed: '#dc2626',
  ValidationFailed: '#f97316',
  Skipped: '#94a3b8',
  Bounced: '#dc2626',
  Opened: '#8b5cf6',
  Clicked: '#6366f1',
  Replied: '#059669',
};

const statusLabels: Record<string, string> = {
  DraftPending: '等待AI写信',
  Drafting: 'AI写信中',
  DraftReady: '草稿已完成',
  ValidationFailed: '内容校验失败',
  QueuedToSend: '等待发送',
  Queued: '队列中',
  Sending: '发送中',
  Sent: '已发送',
  Opened: '已打开',
  Clicked: '已点击',
  Replied: '已回复',
  Failed: '失败',
  DraftFailed: 'AI写信失败',
  Bounced: '退信',
  Skipped: '已跳过',
};

export default function AnalyticsPage() {
  const [rangeDays, setRangeDays] = useState(30);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [overview, setOverview] = useState<any>(null);
  const [emailTrends, setEmailTrends] = useState<any>(null);
  const [selectedOwnerUserId, setSelectedOwnerUserId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const params = useMemo(() => {
    const dateParams = rangeDays > 0 ? { days: rangeDays } : { startDate, endDate };
    return { ...dateParams, ownerUserId: selectedOwnerUserId || undefined };
  }, [rangeDays, startDate, endDate, selectedOwnerUserId]);

  useEffect(() => {
    setLoading(true);
    setError('');
    Promise.all([
      api.get('/analytics/overview', { params }),
      api.get('/analytics/email-trends', { params }),
    ])
      .then(([overviewRes, emailTrendRes]) => {
        setOverview(overviewRes.data);
        setEmailTrends(emailTrendRes.data);
      })
      .catch((err) => setError(err.response?.data?.message || '数据分析加载失败'))
      .finally(() => setLoading(false));
  }, [params]);

  const email = overview?.email || {};
  const statusData = Object.entries(email.statusDistribution || {}).map(([status, count]) => ({
    status,
    label: statusLabels[status] || status,
    count,
  }));
  const crmStageData = Object.entries(overview?.statusDistribution || {}).map(([stage, count]) => ({ stage, count }));
  const salespersonData = overview?.salespersonPerformance || [];
  const canSelectOwner = !!overview?.canSelectOwner;
  const availableSalesUsers = overview?.availableSalesUsers || [];

  if (loading) return <div className="py-12 text-center text-gray-400">正在加载数据分析...</div>;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">邮件与客户数据分析</h2>
          <p className="text-sm text-gray-500">
            按时间查看获客、客户沉淀、邮件打开点击、失败原因和业务员开发表现。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-gray-200 bg-white p-2 dark:border-gray-800 dark:bg-gray-950">
          {ranges.map((range) => (
            <button
              key={range.label}
              type="button"
              onClick={() => setRangeDays(range.days)}
              className={`rounded-lg px-3 py-1.5 text-sm ${rangeDays === range.days ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800'}`}
            >
              {range.label}
            </button>
          ))}
          {rangeDays === 0 && (
            <>
              <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800" />
              <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="rounded-lg border border-gray-300 px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800" />
            </>
          )}
          {canSelectOwner && (
            <select
              value={selectedOwnerUserId}
              onChange={(e) => setSelectedOwnerUserId(e.target.value)}
              className="rounded-lg border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-700 dark:bg-gray-800"
            >
              <option value="">全部业务员</option>
              {availableSalesUsers.map((user: any) => (
                <option key={user.id} value={user.id}>{user.name || user.email}</option>
              ))}
            </select>
          )}
        </div>
      </div>

      {error && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</div>}

      <div className="grid gap-4 md:grid-cols-5">
        <StatCard icon={Send} label="已发送邮件" value={email.sent || 0} hint={`总邮件记录 ${email.total || 0}`} />
        <StatCard icon={Mail} label="打开率" value={`${email.openRate || 0}%`} hint={`${email.opened || 0} 封已打开`} />
        <StatCard icon={MousePointer} label="点击率" value={`${email.clickRate || 0}%`} hint={`${email.clicked || 0} 封有点击`} />
        <StatCard icon={AlertTriangle} label="已跳过" value={email.skipped || 0} />
        <StatCard icon={Users} label="唯一收件人" value={email.uniqueRecipients || 0} hint={`活跃邮箱账号 ${email.activeEmailAccounts || 0}`} />
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <StatCard icon={Inbox} label="客户总数" value={overview?.totalLeads || 0} hint={`本期新增 ${overview?.newThisMonth || 0}`} />
        <StatCard icon={Activity} label="开发池待发" value={overview?.statusDistribution?.prospect_pool || 0} />
        <StatCard icon={AlertTriangle} label="失败/退信" value={email.failed || 0} />
        <StatCard icon={BarChart3} label="平均评分" value={overview?.avgLeadScore || 0} />
      </div>

      <section className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-950">
        <h3 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">业务员分析</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 text-left text-xs uppercase text-gray-500 dark:border-gray-800">
                <th className="py-2 pr-4">业务员</th>
                <th className="py-2 pr-4">分配客户</th>
                <th className="py-2 pr-4">本期新增</th>
                <th className="py-2 pr-4">开发池待发</th>
                <th className="py-2 pr-4">开发中</th>
                <th className="py-2 pr-4">已发</th>
                <th className="py-2 pr-4">本期轮次已发</th>
                <th className="py-2 pr-4">打开率</th>
                <th className="py-2 pr-4">点击率</th>
                <th className="py-2 pr-4">失败</th>
                <th className="py-2 pr-4">跳过</th>
                <th className="py-2 pr-4">平均评分</th>
              </tr>
            </thead>
            <tbody>
              {salespersonData.length ? salespersonData.map((row: any) => (
                <tr key={row.userId} className="border-b border-gray-100 last:border-0 dark:border-gray-800">
                  <td className="py-3 pr-4">
                    <div className="font-medium text-gray-900 dark:text-white">{row.name}</div>
                    <div className="text-xs text-gray-400">{row.email}</div>
                  </td>
                  <td className="py-3 pr-4">{row.assignedLeads ?? row.totalLeads}</td>
                  <td className="py-3 pr-4">{row.newThisMonth}</td>
                  <td className="py-3 pr-4">{row.prospectPool || 0}</td>
                  <td className="py-3 pr-4">{row.activeLeads}</td>
                  <td className="py-3 pr-4">{row.sent}</td>
                  <td className="py-3 pr-4">{row.currentRoundSent || 0}</td>
                  <td className="py-3 pr-4">{row.openRate}%</td>
                  <td className="py-3 pr-4">{row.clickRate}%</td>
                  <td className="py-3 pr-4">{row.failed}</td>
                  <td className="py-3 pr-4">{row.skipped || 0}</td>
                  <td className="py-3 pr-4">{row.avgScore}</td>
                </tr>
              )) : (
                <tr><td colSpan={12} className="py-8 text-center text-gray-400">暂无业务员数据</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-950">
        <h3 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">邮件趋势</h3>
        <ResponsiveContainer width="100%" height={320}>
          <LineChart data={emailTrends?.dailyEmailTrend || []}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
            <XAxis dataKey="date" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 12 }} />
            <Tooltip />
            <Line type="monotone" dataKey="queued" name="创建" stroke="#64748b" strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="sent" name="发送" stroke="#10b981" strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="opened" name="打开" stroke="#3b82f6" strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="clicked" name="点击" stroke="#f59e0b" strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="failed" name="失败" stroke="#ef4444" strokeWidth={2} dot={false} />
            <Line type="monotone" dataKey="skipped" name="跳过" stroke="#94a3b8" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <ChartCard title="邮件状态分布" data={statusData} dataKey="label" colors />
        <ChartCard title="客户阶段分布" data={crmStageData} dataKey="stage" />
      </div>
    </div>
  );
}

function StatCard({ icon: Icon, label, value, hint }: { icon: any; label: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-950">
      <div className="flex items-center gap-2 text-sm text-gray-500"><Icon className="h-4 w-4" />{label}</div>
      <div className="mt-2 text-3xl font-bold text-gray-900 dark:text-white">{value}</div>
      {hint && <div className="mt-1 text-xs text-gray-400">{hint}</div>}
    </div>
  );
}

function ChartCard({ title, data, dataKey, colors }: { title: string; data: any[]; dataKey: string; colors?: boolean }) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-950">
      <h3 className="mb-4 text-lg font-semibold text-gray-900 dark:text-white">{title}</h3>
      <ResponsiveContainer width="100%" height={300}>
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
          <XAxis dataKey={dataKey} tick={{ fontSize: 12 }} />
          <YAxis tick={{ fontSize: 12 }} />
          <Tooltip />
          <Bar dataKey="count" fill="#3b82f6" radius={[4, 4, 0, 0]}>
            {colors && data.map((item: any) => <Cell key={item.status || item[dataKey]} fill={statusColors[item.status] || '#3b82f6'} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
