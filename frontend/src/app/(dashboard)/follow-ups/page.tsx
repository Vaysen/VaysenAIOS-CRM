'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import api from '@/lib/api';
import { useT } from '@/i18n/use-translation';
import { Bell, Check, X, Clock, Eye, Zap } from 'lucide-react';

const ALL_STATUSES = ['Pending', 'Completed', 'Ignored', 'Snoozed', 'Cancelled', 'Overdue'];
const ALL_TYPES = ['EMAIL_SENT_NO_OPEN', 'OPENED_NO_REPLY', 'CLICKED_NO_REPLY', 'QUOTE_NO_REPLY', 'LONG_TIME_NO_CONTACT', 'HIGH_INTENT_FOLLOW_UP', 'REPLIED_STATUS_NOT_UPDATED'];
const CHANNELS = [
  { key: '', label: '全部渠道', types: [] },
  { key: 'email', label: '邮件跟进', types: ['EMAIL_SENT_NO_OPEN', 'OPENED_NO_REPLY', 'CLICKED_NO_REPLY'] },
  { key: 'quote', label: '报价跟进', types: ['QUOTE_NO_REPLY'] },
  { key: 'customer', label: '客户维护', types: ['LONG_TIME_NO_CONTACT', 'HIGH_INTENT_FOLLOW_UP', 'REPLIED_STATUS_NOT_UPDATED'] },
];

const PRIORITY_COLORS: Record<string, string> = {
  Urgent: 'bg-red-100 text-red-700',
  High: 'bg-orange-100 text-orange-700',
  Medium: 'bg-blue-100 text-blue-700',
  Low: 'bg-gray-100 text-gray-600',
};

export default function FollowUpsPage() {
  const { t } = useT();
  const router = useRouter();
  const [reminders, setReminders] = useState<any[]>([]);
  const [meta, setMeta] = useState({ page: 1, limit: 20, total: 0, totalPages: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);

  const [statusFilter, setStatusFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [channelFilter, setChannelFilter] = useState('');
  const [priorityFilter, setPriorityFilter] = useState('');
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [page, setPage] = useState(1);

  const fetchReminders = useCallback(async () => {
    try {
      setLoading(true);
      const params: any = { page, limit: 20 };
      if (statusFilter) params.status = statusFilter;
      if (typeFilter) params.reminderType = typeFilter;
      else if (channelFilter) params.reminderType = CHANNELS.find((item) => item.key === channelFilter)?.types.join(',');
      if (priorityFilter) params.priority = priorityFilter;
      if (overdueOnly) params.overdue = true;
      const res = await api.get('/follow-up-reminders', { params });
      setReminders(res.data.data || []);
      setMeta(res.data.meta || { page: 1, limit: 20, total: 0, totalPages: 0 });
    } catch (err: any) {
      setError('Failed to load reminders');
    } finally {
      setLoading(false);
    }
  }, [page, statusFilter, typeFilter, channelFilter, priorityFilter, overdueOnly]);

  useEffect(() => {
    fetchReminders();
  }, [fetchReminders]);

  const handleGenerate = async () => {
    try {
      setGenerating(true);
      const res = await api.post('/follow-up-reminders/generate');
      setSuccess(res.data.message || 'Reminders generated');
      fetchReminders();
    } catch (err: any) {
      setError(err.response?.data?.message || 'Generation failed');
    } finally {
      setGenerating(false);
    }
  };

  const handleComplete = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await api.patch(`/follow-up-reminders/${id}/complete`);
      fetchReminders();
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to complete');
    }
  };

  const handleIgnore = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await api.patch(`/follow-up-reminders/${id}/ignore`);
      fetchReminders();
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to ignore');
    }
  };

  const handleSnooze = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const date = prompt(t('followUps.snoozePrompt'));
    if (!date) return;
    try {
      await api.patch(`/follow-up-reminders/${id}/snooze`, { snoozedUntil: new Date(date).toISOString() });
      fetchReminders();
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to snooze');
    }
  };

  const getTypeLabel = (type: string) => t(`followUps.type.${type}`) || type;
  const getStatusLabel = (s: string) => t(`followUps.status.${s}`) || s;
  const getPriorityLabel = (p: string) => t(`followUps.priority.${p}`) || p;

  const STATUS_COLORS: Record<string, string> = {
    Pending: 'bg-yellow-100 text-yellow-700',
    Completed: 'bg-green-100 text-green-700',
    Ignored: 'bg-gray-100 text-gray-600',
    Snoozed: 'bg-blue-100 text-blue-700',
    Cancelled: 'bg-red-100 text-red-500',
    Overdue: 'bg-red-100 text-red-700',
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">{t('followUps.title')}</h2>
        <div className="flex gap-2">
          <button
            onClick={handleGenerate}
            disabled={generating}
            className="inline-flex items-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700 disabled:opacity-50"
          >
            <Zap className="h-4 w-4" />
            {generating ? t('followUps.generating') : t('followUps.generateReminders')}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-3 text-sm text-red-600 dark:text-red-400 flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="text-gray-400 hover:text-gray-600">&times;</button>
        </div>
      )}
      {success && (
        <div className="rounded-lg bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 p-3 text-sm text-green-600 dark:text-green-400 flex items-center justify-between">
          <span>{success}</span>
          <button onClick={() => setSuccess(null)} className="text-gray-400 hover:text-gray-600">&times;</button>
        </div>
      )}

      {/* Filters */}
      <div className="space-y-3">
        <div className="flex gap-2 flex-wrap">
          <span className="text-xs font-medium text-gray-500 self-center mr-1">渠道:</span>
          {CHANNELS.map((channel) => (
            <button
              key={channel.key || 'all'}
              onClick={() => { setChannelFilter(channel.key); setTypeFilter(''); setPage(1); }}
              className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium border transition-colors ${
                channelFilter === channel.key ? 'bg-blue-100 border-blue-300 text-blue-700 dark:bg-blue-900/30 dark:border-blue-700 dark:text-blue-400'
                : 'bg-white dark:bg-gray-900 border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400'
              }`}
            >
              {channel.label}
            </button>
          ))}
        </div>
        <div className="flex gap-2 flex-wrap">
          <span className="text-xs font-medium text-gray-500 self-center mr-1">{t('followUps.filters.status')}:</span>
          <button
            onClick={() => { setStatusFilter(''); setPage(1); }}
            className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium border transition-colors ${
              !statusFilter ? 'bg-blue-100 border-blue-300 text-blue-700 dark:bg-blue-900/30 dark:border-blue-700 dark:text-blue-400'
              : 'bg-white dark:bg-gray-900 border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400'
            }`}
          >
            {t('followUps.filters.all')}
          </button>
          {ALL_STATUSES.map((s) => (
            <button
              key={s}
              onClick={() => { setStatusFilter(s); setPage(1); }}
              className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium border transition-colors ${
                statusFilter === s ? 'bg-blue-100 border-blue-300 text-blue-700 dark:bg-blue-900/30 dark:border-blue-700 dark:text-blue-400'
                : 'bg-white dark:bg-gray-900 border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400'
              }`}
            >
              {getStatusLabel(s)}
            </button>
          ))}
        </div>
        <div className="flex gap-2 flex-wrap">
          <span className="text-xs font-medium text-gray-500 self-center mr-1">{t('followUps.filters.type')}:</span>
          <button
            onClick={() => { setTypeFilter(''); setPage(1); }}
            className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium border transition-colors ${
              !typeFilter ? 'bg-blue-100 border-blue-300 text-blue-700 dark:bg-blue-900/30 dark:border-blue-700 dark:text-blue-400'
              : 'bg-white dark:bg-gray-900 border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400'
            }`}
          >
            {t('followUps.filters.all')}
          </button>
          {ALL_TYPES.map((tKey) => (
            <button
              key={tKey}
              onClick={() => { setTypeFilter(tKey); setPage(1); }}
              className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium border transition-colors ${
                typeFilter === tKey ? 'bg-blue-100 border-blue-300 text-blue-700 dark:bg-blue-900/30 dark:border-blue-700 dark:text-blue-400'
                : 'bg-white dark:bg-gray-900 border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400'
              }`}
            >
              {getTypeLabel(tKey)}
            </button>
          ))}
        </div>
        <div className="flex gap-2 flex-wrap items-center">
          <span className="text-xs font-medium text-gray-500 self-center mr-1">{t('followUps.filters.priority')}:</span>
          {['', 'Urgent', 'High', 'Medium', 'Low'].map((p) => (
            <button
              key={p}
              onClick={() => { setPriorityFilter(p); setPage(1); }}
              className={`inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium border transition-colors ${
                priorityFilter === p ? 'bg-blue-100 border-blue-300 text-blue-700 dark:bg-blue-900/30 dark:border-blue-700 dark:text-blue-400'
                : 'bg-white dark:bg-gray-900 border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400'
              }`}
            >
              {p ? getPriorityLabel(p) : t('followUps.filters.all')}
            </button>
          ))}
          <label className="inline-flex items-center gap-1 ml-3 text-xs text-gray-500 cursor-pointer">
            <input
              type="checkbox"
              checked={overdueOnly}
              onChange={(e) => { setOverdueOnly(e.target.checked); setPage(1); }}
              className="rounded border-gray-300"
            />
            {t('followUps.filters.overdueOnly')}
          </label>
        </div>
      </div>

      {/* Table */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">{t('followUps.table.lead')}</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">{t('followUps.table.type')}</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 hidden md:table-cell">{t('followUps.table.reason')}</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">{t('followUps.table.priority')}</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">{t('followUps.table.due')}</th>
              <th className="px-4 py-3 text-left text-xs font-medium text-gray-500">{t('followUps.table.status')}</th>
              <th className="px-4 py-3 text-right text-xs font-medium text-gray-500">{t('followUps.table.actions')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-800">
            {reminders.length === 0 && !loading && (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-gray-400">
                  {t('followUps.noReminders')}
                </td>
              </tr>
            )}
            {reminders.map((r) => (
              <tr
                key={r.id}
                onClick={() => router.push(`/follow-ups/${r.id}`)}
                className="hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer transition-colors"
              >
                <td className="px-4 py-3">
                  <Link
                    href={`/leads/${r.leadId}`}
                    onClick={(e) => e.stopPropagation()}
                    className="text-sm font-medium text-blue-600 hover:text-blue-800 dark:text-blue-400"
                  >
                    {r.lead?.companyName || t('common.unknown')}
                  </Link>
                </td>
                <td className="px-4 py-3 text-xs text-gray-600 dark:text-gray-400">
                  {getTypeLabel(r.reminderType)}
                </td>
                <td className="px-4 py-3 text-xs text-gray-500 truncate max-w-[200px] hidden md:table-cell">
                  {r.reason}
                </td>
                <td className="px-4 py-3">
                  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${PRIORITY_COLORS[r.priority] || 'bg-gray-100 text-gray-700'}`}>
                    {getPriorityLabel(r.priority)}
                  </span>
                </td>
                <td className="px-4 py-3 text-xs text-gray-500">
                  {new Date(r.dueAt).toLocaleDateString()}
                </td>
                <td className="px-4 py-3">
                  <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[r.status] || 'bg-gray-100 text-gray-700'}`}>
                    {getStatusLabel(r.status)}
                    {r.status === 'Pending' && new Date(r.dueAt) < new Date() && ' ⚠'}
                  </span>
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                    {r.status === 'Pending' && (
                      <>
                        <button
                          onClick={(e) => handleComplete(r.id, e)}
                          className="rounded p-1 text-green-500 hover:text-green-700 hover:bg-green-50 dark:hover:bg-green-900/20"
                          title={t('followUps.complete')}
                        >
                          <Check className="h-4 w-4" />
                        </button>
                        <button
                          onClick={(e) => handleSnooze(r.id, e)}
                          className="rounded p-1 text-blue-500 hover:text-blue-700 hover:bg-blue-50 dark:hover:bg-blue-900/20"
                          title={t('followUps.snooze')}
                        >
                          <Clock className="h-4 w-4" />
                        </button>
                        <button
                          onClick={(e) => handleIgnore(r.id, e)}
                          className="rounded p-1 text-gray-400 hover:text-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800"
                          title={t('followUps.ignore')}
                        >
                          <X className="h-4 w-4" />
                        </button>
                      </>
                    )}
                    <Link
                      href={`/follow-ups/${r.id}`}
                      className="rounded p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                      title={t('common.view')}
                    >
                      <Eye className="h-4 w-4" />
                    </Link>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {meta.totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-gray-500">
            {t('common.pagination.showing', { from: String((meta.page - 1) * meta.limit + 1), to: String(Math.min(meta.page * meta.limit, meta.total)), total: String(meta.total) })}
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-1.5 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
            >
              {t('common.pagination.prev')}
            </button>
            <button
              onClick={() => setPage((p) => Math.min(meta.totalPages, p + 1))}
              disabled={page >= meta.totalPages}
              className="rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-1.5 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
            >
              {t('common.pagination.next')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
