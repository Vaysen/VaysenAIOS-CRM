'use client';

import { useEffect, useMemo, useState } from 'react';
import { Activity, AlertCircle, CheckCircle2, Clock, Loader2, RefreshCw } from 'lucide-react';
import api from '@/lib/api';

interface QueueStats {
  name: string;
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  paused: number;
}

interface QueueStatusPayload {
  queues: QueueStats[];
  emailWorkflow: Record<string, number>;
  recentFailures: Array<{
    id: string;
    status: string;
    failedReason?: string;
    toEmail?: string;
    subject?: string;
    createdAt: string;
  }>;
}

const QUEUE_LABELS: Record<string, string> = {
  'email-compose': 'AI写开发信',
  'email-validate': '邮件内容校验',
  'email-send': 'SMTP发送',
  'prospect-search': 'AI全网获客',
  'deep-research': 'AI深度背调',
  maintenance: '系统维护',
};

const EMAIL_STATUS_LABELS: Record<string, string> = {
  pending: '待处理总数',
  draftPending: '等待AI写信',
  drafting: 'AI写信中',
  draftReady: '草稿已完成',
  validationFailed: '内容校验失败',
  queuedToSend: '等待发送',
  legacyQueued: '旧队列中',
  sending: '发送中',
  sent: '已发送',
  failed: '失败',
  skipped: '已跳过',
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

export default function TasksPage() {
  const [data, setData] = useState<QueueStatusPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<Date | null>(null);
  const [error, setError] = useState('');

  const load = async () => {
    try {
      setRefreshing(true);
      setError('');
      const res = await api.get('/queues/status');
      setData(res.data?.data || null);
      setLastUpdatedAt(new Date());
    } catch (err: any) {
      setError(err.response?.data?.message || '任务状态加载失败');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 5000);
    return () => window.clearInterval(timer);
  }, []);

  const totals = useMemo(() => {
    const queues = data?.queues || [];
    return queues.reduce(
      (acc, queue) => {
        acc.waiting += queue.waiting + queue.delayed;
        acc.active += queue.active;
        acc.failed += queue.failed;
        return acc;
      },
      { waiting: 0, active: 0, failed: 0 },
    );
  }, [data]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">任务中心</h1>
          <p className="mt-1 text-sm text-gray-500">
            监控 AI获客、AI写开发信、邮件发送和客户深度背调的后台队列。
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={refreshing}
          className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-60 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-800"
        >
          <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          {refreshing ? '刷新中' : '刷新'}
        </button>
      </div>

      {lastUpdatedAt && <p className="text-xs text-gray-500">最近刷新：{lastUpdatedAt.toLocaleString()}</p>}

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
          {error}
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-gray-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          正在加载任务状态...
        </div>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            <MetricCard icon={Clock} label="等待/延迟" value={totals.waiting} />
            <MetricCard icon={Activity} label="执行中" value={totals.active} />
            <MetricCard icon={AlertCircle} label="失败任务" value={totals.failed} tone="red" />
          </div>

          <section className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-base font-semibold text-gray-900 dark:text-white">队列状态</h2>
              <span className="text-xs text-gray-500">每 5 秒自动刷新</span>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200 text-sm dark:divide-gray-800">
                <thead className="text-left text-xs uppercase text-gray-500">
                  <tr>
                    <th className="px-3 py-2">任务类型</th>
                    <th className="px-3 py-2">等待</th>
                    <th className="px-3 py-2">执行中</th>
                    <th className="px-3 py-2">延迟</th>
                    <th className="px-3 py-2">失败</th>
                    <th className="px-3 py-2">已完成</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                  {(data?.queues || []).map((queue) => (
                    <tr key={queue.name}>
                      <td className="px-3 py-2 font-medium text-gray-900 dark:text-white">
                        {QUEUE_LABELS[queue.name] || queue.name}
                      </td>
                      <td className="px-3 py-2">{queue.waiting}</td>
                      <td className="px-3 py-2">{queue.active}</td>
                      <td className="px-3 py-2">{queue.delayed}</td>
                      <td className="px-3 py-2 text-red-600">{queue.failed}</td>
                      <td className="px-3 py-2 text-gray-500">{queue.completed}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
              <h2 className="mb-3 text-base font-semibold text-gray-900 dark:text-white">邮件安全发送状态</h2>
              <div className="grid grid-cols-2 gap-3 text-sm">
                {Object.entries(data?.emailWorkflow || {}).map(([key, value]) => (
                  <div key={key} className="rounded-md bg-gray-50 p-3 dark:bg-gray-800">
                    <div className="text-xs text-gray-500">{EMAIL_STATUS_LABELS[key] || key}</div>
                    <div className="mt-1 text-lg font-semibold text-gray-900 dark:text-white">{value}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
              <h2 className="mb-3 text-base font-semibold text-gray-900 dark:text-white">最近失败/跳过原因</h2>
              <div className="space-y-3">
                {(data?.recentFailures || []).length === 0 ? (
                  <div className="flex items-center gap-2 text-sm text-gray-500">
                    <CheckCircle2 className="h-4 w-4 text-green-600" />
                    暂无失败记录
                  </div>
                ) : (
                  data!.recentFailures.map((item) => (
                    <div key={item.id} className="rounded-md border border-gray-100 p-3 text-sm dark:border-gray-800">
                      <div className="flex items-center justify-between gap-3">
                        <span className="font-medium text-gray-900 dark:text-white">
                          {EMAIL_STATUS_LABELS[item.status] || item.status}
                        </span>
                        <span className="text-xs text-gray-500">{new Date(item.createdAt).toLocaleString()}</span>
                      </div>
                      <div className="mt-1 truncate text-gray-600 dark:text-gray-300">{item.subject || item.toEmail || item.id}</div>
                      <div className="mt-1 text-xs text-red-600">{item.failedReason || '暂无详细原因'}</div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function MetricCard({ icon: Icon, label, value, tone }: { icon: any; label: string; value: number; tone?: 'red' }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-gray-500">{label}</p>
          <p className="mt-2 text-2xl font-semibold text-gray-900 dark:text-white">{value}</p>
        </div>
        <Icon className={tone === 'red' ? 'h-6 w-6 text-red-500' : 'h-6 w-6 text-blue-600'} />
      </div>
    </div>
  );
}
