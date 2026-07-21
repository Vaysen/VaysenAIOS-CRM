'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import api from '@/lib/api';
import { Card } from '@/components/ui/card';
import {
  Mail, MousePointerClick, CheckCircle, Ban, Archive, Users, TrendingUp, Send, AlertCircle,
  ArrowRight, Clock, Eye, FileText, Inbox, RefreshCw, Settings, Trash2, Sparkles
} from 'lucide-react';

/* ========== Email Monitoring — status config ========== */

const STATUS_COLORS: Record<string, string> = {
  Draft: 'bg-gray-100 text-gray-700',
  DraftPending: 'bg-sky-100 text-sky-700',
  Drafting: 'bg-cyan-100 text-cyan-700',
  DraftReady: 'bg-blue-100 text-blue-700',
  ValidationFailed: 'bg-orange-100 text-orange-700',
  QueuedToSend: 'bg-blue-100 text-blue-700',
  Queued: 'bg-blue-100 text-blue-700',
  Sending: 'bg-yellow-100 text-yellow-700',
  Sent: 'bg-green-100 text-green-700',
  Failed: 'bg-red-100 text-red-700',
  DraftFailed: 'bg-red-100 text-red-700',
  Bounced: 'bg-red-200 text-red-800',
  Opened: 'bg-purple-100 text-purple-700',
  Clicked: 'bg-indigo-100 text-indigo-700',
  Replied: 'bg-emerald-100 text-emerald-700',
  Deleted: 'bg-gray-200 text-gray-700',
  Skipped: 'bg-amber-100 text-amber-700',
};

const STATUS_OPTIONS = [
  'Draft', 'DraftPending', 'Drafting', 'DraftReady', 'ValidationFailed',
  'QueuedToSend', 'Queued', 'Sending', 'Sent', 'Opened', 'Clicked',
  'Replied', 'Failed', 'DraftFailed', 'Bounced', 'Skipped',
];

const STATUS_LABELS: Record<string, string> = {
  Draft: '草稿', DraftPending: '等待AI写信', Drafting: 'AI写信中',
  DraftReady: '草稿已完成', ValidationFailed: '内容校验失败',
  QueuedToSend: '等待发送', Queued: '队列中', Sending: '发送中',
  Sent: '已发送', Opened: '已打开', Clicked: '已点击', Replied: '已回复',
  Failed: '失败', DraftFailed: 'AI写信失败', Bounced: '退信',
  Skipped: '已跳过', Deleted: '已删除',
};

/* ========== Acquisition Pool config ========== */

const POOLS = [
  { key: 'total', label: '全部线索', icon: <Users className="w-4 h-4" />, color: 'bg-blue-50 text-blue-700' },
  { key: 'unverified', label: '未验证邮箱', icon: <AlertCircle className="w-4 h-4" />, color: 'bg-gray-50 text-gray-600' },
  { key: 'sendable', label: '可发送', icon: <Send className="w-4 h-4" />, color: 'bg-cyan-50 text-cyan-700' },
  { key: 'sent', label: '已发送', icon: <Mail className="w-4 h-4" />, color: 'bg-amber-50 text-amber-700' },
  { key: 'opened', label: '已打开', icon: <MousePointerClick className="w-4 h-4" />, color: 'bg-green-50 text-green-700' },
  { key: 'replied', label: '已回复', icon: <CheckCircle className="w-4 h-4" />, color: 'bg-green-100 text-green-800' },
  { key: 'unsubscribed', label: '已退订', icon: <Ban className="w-4 h-4" />, color: 'bg-red-50 text-red-600' },
  { key: 'invalid', label: '无效/退信', icon: <Archive className="w-4 h-4" />, color: 'bg-red-100 text-red-700' },
];

/* ========== Page Component ========== */

export default function AcquisitionPage() {
  const router = useRouter();

  // Pool stats
  const [stats, setStats] = useState<Record<string, number>>({ total: 0 });
  const [loading, setLoading] = useState(true);

  // Email monitoring state
  const [emails, setEmails] = useState<any[]>([]);
  const [teamStats, setTeamStats] = useState<any[]>([]);
  const [queueStatus, setQueueStatus] = useState<any>(null);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [emailFilter, setEmailFilter] = useState('');
  const [emailPage, setEmailPage] = useState(1);
  const [emailMeta, setEmailMeta] = useState({ page: 1, limit: 20, total: 0, totalPages: 0 });
  const [emailLoading, setEmailLoading] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [showMonitor, setShowMonitor] = useState(true);

  /* ---- Pool stats ---- */
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [leadRes, emailRes] = await Promise.allSettled([
          api.get('/leads', { params: { limit: 1 } }),
          api.get('/analytics/overview'),
        ]);
        if (cancelled) return;
        const leadsTotal = leadRes.status === 'fulfilled' ? (leadRes.value.data?.meta?.total || 0) : 0;
        const overview = emailRes.status === 'fulfilled' ? (emailRes.value.data || {}) : {};
        setStats({
          total: leadsTotal,
          sendable: overview.leadsSendable || 0,
          sent: overview.emailsSent || 0,
          opened: overview.emailsOpened || 0,
          replied: overview.emailsReplied || 0,
          unsubscribed: overview.unsubscribed || 0,
          invalid: overview.bounced || 0,
          unverified: 0,
        });
      } catch (error) { console.error('[Frontend] operation failed:', error); } finally { if (!cancelled) setLoading(false); }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  /* ---- Email monitoring ---- */
  const fetchEmails = useCallback(async () => {
    try {
      setEmailLoading(true);
      setEmailError(null);
      const params: any = { page: emailPage, limit: 20 };
      if (emailFilter) params.status = emailFilter;
      if (selectedUserId) params.senderUserId = selectedUserId;

      const res = await api.get('/emails', { params });
      setEmails(res.data.data || []);
      setEmailMeta(res.data.meta || { page: 1, limit: 20, total: 0, totalPages: 0 });
    } catch (err: any) {
      setEmailError(err.response?.data?.message || '邮件记录加载失败');
    } finally {
      setEmailLoading(false);
    }
  }, [emailPage, selectedUserId, emailFilter]);

  const fetchSideData = useCallback(async () => {
    try {
      const [teamRes, queueRes] = await Promise.all([
        api.get('/emails/team-stats'),
        api.get('/emails/queue-status'),
      ]);
      setTeamStats(teamRes.data?.data || []);
      setQueueStatus(queueRes.data?.data || null);
    } catch {
      setTeamStats([]);
      setQueueStatus(null);
    }
  }, []);

  useEffect(() => { fetchEmails(); }, [fetchEmails]);
  useEffect(() => {
    fetchSideData();
    const timer = window.setInterval(fetchSideData, 60000);
    return () => window.clearInterval(timer);
  }, [fetchSideData]);

  const handleResend = async (id: string, e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    try {
      await api.post(`/emails/${id}/resend`);
      fetchEmails(); fetchSideData();
    } catch (err: any) {
      setEmailError(err.response?.data?.message || '重新发送失败');
    }
  };

  const monitorStats = useMemo(() => ({
    total: emailMeta.total,
    queued: queueStatus?.queued || 0,
    sending: queueStatus?.sending || 0,
    sentToday: queueStatus?.sentToday || 0,
  }), [emailMeta.total, queueStatus]);

  const getStatusLabel = (s: string) => STATUS_LABELS[s] || s;

  /* ---- Render ---- */
  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900">获客开发</h1>
          <p className="text-sm text-gray-500 mt-0.5">冷邮件客户池管理 · 邮箱验证 · 群发跟踪 · 客户流转</p>
        </div>
        <div className="flex gap-2">
          <Link href="/customers" className="px-3 py-1.5 text-sm border rounded-md hover:bg-gray-50">客户资产</Link>
          <Link href="/emails/send" className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 flex items-center gap-1">
            <Send className="w-3.5 h-3.5" /> 写信/群发
          </Link>
        </div>
      </div>

      {/* Pool stats cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {POOLS.map((p) => (
          <Card key={p.key} className="p-3">
            <div className={`w-7 h-7 rounded-lg ${p.color} flex items-center justify-center mb-1.5`}>{p.icon}</div>
            <p className="text-lg font-bold">{loading ? '—' : stats[p.key] || 0}</p>
            <p className="text-[10px] text-gray-500 mt-0.5">{p.label}</p>
          </Card>
        ))}
      </div>

      {/* Quick nav + Flow rules */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="grid grid-cols-2 gap-3">
          {[
            { title: '线索管理', desc: '查看、筛选、导入客户线索', href: '/leads', icon: <Users className="w-5 h-5" /> },
            { title: '海关数据', desc: '导入海关进出口商数据', href: '/leads/import', icon: <Archive className="w-5 h-5" /> },
          ].map((item) => (
            <Link key={item.href} href={item.href} className="p-3 border rounded-lg hover:bg-gray-50 flex items-start gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-gray-50 flex items-center justify-center text-gray-600 shrink-0">{item.icon}</div>
              <div><p className="text-xs font-semibold">{item.title}</p><p className="text-[10px] text-gray-500 mt-0.5">{item.desc}</p></div>
            </Link>
          ))}
        </div>
        <Card className="p-3">
          <h3 className="text-xs font-semibold mb-1.5 flex items-center gap-1"><TrendingUp className="w-3 h-3" />流转规则</h3>
          <div className="text-[10px] text-gray-500 space-y-0.5">
            <p>· 退订 → 不发送 | 打开 → 自动打标</p>
            <p>· 回复 → 客户资产 + 沟通中心</p>
            <p>· 退信/无效 → 停止发送</p>
            <p className="text-amber-600 mt-1 flex items-center gap-1"><AlertCircle className="w-2.5 h-2.5" />预览环境，不真实发送邮件。</p>
          </div>
        </Card>
      </div>

      {/* ======== 群邮监控工作台 ======== */}
      <div className="border rounded-xl overflow-hidden">
        <div
          className="flex items-center justify-between px-4 py-2.5 bg-gray-50/80 border-b cursor-pointer hover:bg-gray-100 transition-colors"
          onClick={() => setShowMonitor(!showMonitor)}
        >
          <div className="flex items-center gap-2">
            <Mail className="w-4 h-4 text-blue-500" />
            <span className="text-sm font-semibold text-gray-800">群邮监控工作台</span>
            <span className="text-[9px] bg-blue-50 text-blue-600 px-1.5 py-0.5 rounded-full font-medium">营销群发</span>
          </div>
          <span className="text-gray-400 text-[11px] flex items-center gap-1">
            {showMonitor ? '收起' : '展开'} {showMonitor ? '▲' : '▼'}
          </span>
        </div>

        {showMonitor && (
          <div className="p-4 space-y-4">
            {/* Monitor stat cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <MonitorStatCard icon={Mail} label="当前筛选" value={monitorStats.total} tone="blue" />
              <MonitorStatCard icon={Clock} label="队列待发" value={monitorStats.queued} tone="amber" />
              <MonitorStatCard icon={RefreshCw} label="发送中" value={monitorStats.sending} tone="green" />
              <MonitorStatCard icon={Send} label="今日已发" value={monitorStats.sentToday} tone="indigo" />
            </div>

            {/* Status filter tabs */}
            <div className="flex items-center gap-2 border-b pb-2">
              <span className="text-[11px] font-medium text-gray-500">状态筛选：</span>
              <div className="flex flex-wrap gap-1">
                <button
                  onClick={() => { setEmailFilter(''); setEmailPage(1); }}
                  className={`text-[10px] px-2 py-0.5 rounded-full border ${!emailFilter ? 'bg-blue-50 border-blue-200 text-blue-700' : 'border-gray-200 text-gray-500 hover:bg-gray-50'}`}
                >全部</button>
                {['Sent', 'Opened', 'Clicked', 'Replied', 'Failed', 'Bounced'].map(s => (
                  <button
                    key={s}
                    onClick={() => { setEmailFilter(emailFilter === s ? '' : s); setEmailPage(1); }}
                    className={`text-[10px] px-2 py-0.5 rounded-full border ${emailFilter === s ? 'bg-blue-50 border-blue-200 text-blue-700' : 'border-gray-200 text-gray-500 hover:bg-gray-50'}`}
                  >{getStatusLabel(s)}</button>
                ))}
              </div>
              <button onClick={() => { fetchEmails(); fetchSideData(); }} className="ml-auto text-[10px] text-gray-400 hover:text-gray-600 flex items-center gap-1">
                <RefreshCw className="w-3 h-3" />刷新
              </button>
            </div>

            {/* Main content: table + side panels */}
            <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_300px]">
              {/* Email table */}
              <div className="overflow-hidden border rounded-lg">
                {emailError && (
                  <div className="flex items-center justify-between px-3 py-2 bg-red-50 border-b border-red-200 text-[11px] text-red-600">
                    <span>{emailError}</span>
                    <button onClick={() => setEmailError(null)} className="text-gray-400">&times;</button>
                  </div>
                )}
                <table className="w-full text-[12px]">
                  <thead className="border-b bg-gray-50">
                    <tr>
                      <th className="text-left px-3 py-2 text-gray-500 font-medium">客户</th>
                      <th className="text-left px-3 py-2 text-gray-500 font-medium">收件人</th>
                      <th className="text-left px-3 py-2 text-gray-500 font-medium">主题</th>
                      <th className="text-left px-3 py-2 text-gray-500 font-medium">状态</th>
                      <th className="text-left px-3 py-2 text-gray-500 font-medium hidden lg:table-cell">时间</th>
                      <th className="text-right px-3 py-2 text-gray-500 font-medium">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {emailLoading && (
                      <tr><td colSpan={6} className="px-3 py-8 text-center text-gray-400">加载中...</td></tr>
                    )}
                    {!emailLoading && emails.length === 0 && (
                      <tr><td colSpan={6} className="px-3 py-8 text-center text-gray-400">暂无邮件记录</td></tr>
                    )}
                    {!emailLoading && emails.map((email: any) => (
                      <tr
                        key={email.id}
                        onClick={() => router.push(`/emails/${email.id}`)}
                        className="cursor-pointer hover:bg-gray-50 transition-colors"
                      >
                        <td className="px-3 py-2.5">
                          <p className="font-medium text-gray-900 truncate max-w-[120px]">{email.lead?.companyName || '未知'}</p>
                        </td>
                        <td className="px-3 py-2.5 text-gray-500 truncate max-w-[140px]">{email.toEmail || '—'}</td>
                        <td className="px-3 py-2.5 text-gray-700 truncate max-w-[180px]">{email.subject || '—'}</td>
                        <td className="px-3 py-2.5">
                          <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${STATUS_COLORS[email.status] || 'bg-gray-100 text-gray-700'}`}>
                            {getStatusLabel(email.status)}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-gray-400 hidden lg:table-cell text-[11px]">
                          {email.sentAt ? new Date(email.sentAt).toLocaleDateString('zh-CN') : '—'}
                        </td>
                        <td className="px-3 py-2.5 text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Link href={`/emails/${email.id}`} onClick={e => e.stopPropagation()} className="p-1 text-gray-400 hover:text-blue-500"><Eye className="w-3.5 h-3.5" /></Link>
                            {(email.status === 'Failed' || email.status === 'Bounced') && (
                              <button onClick={e => handleResend(email.id, e)} className="p-1 text-blue-400 hover:text-blue-600"><RefreshCw className="w-3.5 h-3.5" /></button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>

                {/* Pagination */}
                {emailMeta.totalPages > 1 && (
                  <div className="flex items-center justify-between px-3 py-2 border-t bg-gray-50/50">
                    <span className="text-[10px] text-gray-400">共 {emailMeta.total} 封，第 {emailMeta.page}/{emailMeta.totalPages} 页</span>
                    <div className="flex gap-1">
                      <button onClick={() => setEmailPage(p => Math.max(1, p - 1))} disabled={emailPage <= 1} className="text-[10px] px-2 py-0.5 border rounded hover:bg-gray-50 disabled:opacity-30">上一页</button>
                      <button onClick={() => setEmailPage(p => Math.min(emailMeta.totalPages, p + 1))} disabled={emailPage >= emailMeta.totalPages} className="text-[10px] px-2 py-0.5 border rounded hover:bg-gray-50 disabled:opacity-30">下一页</button>
                    </div>
                  </div>
                )}
              </div>

              {/* Side panels */}
              <aside className="space-y-3">
                {/* Queue panel */}
                <Card className="p-3">
                  <h3 className="text-xs font-semibold mb-2 flex items-center gap-1"><Clock className="w-3.5 h-3.5 text-gray-400" />发送队列</h3>
                  {!queueStatus ? (
                    <p className="text-[11px] text-gray-400">暂无队列数据</p>
                  ) : (
                    <div className="space-y-2">
                      <div className="grid grid-cols-2 gap-1.5">
                        <MiniStat label="待发" value={queueStatus.queued || 0} />
                        <MiniStat label="发送中" value={queueStatus.sending || 0} />
                        <MiniStat label="今日已发" value={queueStatus.sentToday || 0} />
                        <MiniStat label="失败" value={queueStatus.failed || 0} />
                      </div>
                      {queueStatus.queued > 0 && (
                        <p className="text-[10px] text-blue-600 bg-blue-50 rounded px-2 py-1">
                          预计 {queueStatus.estimatedMinutes || '<1'} 分钟完成
                        </p>
                      )}
                    </div>
                  )}
                </Card>

                {/* Team panel */}
                <Card className="p-3">
                  <h3 className="text-xs font-semibold mb-2 flex items-center gap-1"><Users className="w-3.5 h-3.5 text-gray-400" />业务员概况</h3>
                  {teamStats.length === 0 ? (
                    <p className="text-[11px] text-gray-400">暂无数据</p>
                  ) : (
                    <div className="space-y-1.5">
                      {teamStats.map((user: any) => (
                        <button
                          key={user.userId}
                          onClick={() => { setSelectedUserId(selectedUserId === user.userId ? '' : user.userId); setEmailPage(1); }}
                          className={`w-full text-left p-2 rounded border text-[11px] transition-colors ${selectedUserId === user.userId ? 'border-blue-300 bg-blue-50' : 'border-gray-200 hover:bg-gray-50'}`}
                        >
                          <div className="flex justify-between">
                            <span className="font-medium">{(user.firstName || '') + ' ' + (user.lastName || '') || user.email}</span>
                            <ArrowRight className="w-3 h-3 text-gray-400" />
                          </div>
                          <div className="text-[10px] text-gray-400 mt-0.5">
                            今日 {user.sentToday || 0} · 队列 {user.queued || 0} · 打开率 {user.openRate || 0}%
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </Card>

                <p className="text-[9px] text-gray-400 text-center px-2">
                  邮件统计依赖追踪像素，部分客户端拦截图片，仅用于判断趋势。
                </p>
              </aside>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ========== Inline sub-components ========== */

function MonitorStatCard({ icon: Icon, label, value, tone }: { icon: any; label: string; value: number; tone: string }) {
  const tones: Record<string, string> = {
    blue: 'bg-blue-50 text-blue-700', amber: 'bg-amber-50 text-amber-700',
    green: 'bg-green-50 text-green-700', indigo: 'bg-indigo-50 text-indigo-700',
  };
  return (
    <Card className="p-3">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-[10px] text-gray-500">{label}</p>
          <p className="text-lg font-bold text-gray-900">{value}</p>
        </div>
        <div className={`rounded-lg p-1.5 ${tones[tone] || ''}`}><Icon className="w-4 h-4" /></div>
      </div>
    </Card>
  );
}

function MiniStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-gray-50 rounded p-1.5">
      <p className="text-[9px] text-gray-400">{label}</p>
      <p className="text-sm font-semibold">{value}</p>
    </div>
  );
}
