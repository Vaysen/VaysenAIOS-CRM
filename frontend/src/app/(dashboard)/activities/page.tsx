'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import api from '@/lib/api';
import { useT } from '@/i18n/use-translation';
import { Clock, Search, ChevronLeft, ChevronRight, Target, User } from 'lucide-react';

const ACTIVITY_TYPES = [
  'lead_created', 'lead_updated', 'lead_status_changed', 'lead_deleted',
  'owner_changed', 'note_added', 'call_logged', 'whatsapp_logged',
  'email_sent', 'email_failed', 'email_opened', 'email_clicked',
  'unsubscribed', 'imported', 'score_updated', 'duplicate_detected',
  'lead_merged', 'reminder_created', 'reminder_completed',
  'reminder_ignored', 'reminder_snoozed', 'quote_logged', 'sample_logged',
  'won', 'lost',
];

const ACTIVITY_ICONS: Record<string, string> = {
  lead_created: 'text-green-600',
  lead_updated: 'text-blue-600',
  lead_status_changed: 'text-yellow-600',
  lead_deleted: 'text-red-600',
  owner_changed: 'text-purple-600',
  note_added: 'text-gray-600',
  call_logged: 'text-orange-600',
  whatsapp_logged: 'text-teal-600',
  email_sent: 'text-blue-500',
  email_failed: 'text-red-500',
  email_opened: 'text-indigo-500',
  email_clicked: 'text-cyan-500',
  unsubscribed: 'text-red-400',
  imported: 'text-green-500',
  score_updated: 'text-amber-600',
  duplicate_detected: 'text-orange-500',
  lead_merged: 'text-purple-500',
  reminder_created: 'text-gray-500',
  reminder_completed: 'text-green-500',
  reminder_ignored: 'text-gray-400',
  reminder_snoozed: 'text-blue-400',
  quote_logged: 'text-amber-500',
  sample_logged: 'text-teal-500',
  won: 'text-emerald-600',
  lost: 'text-red-600',
};

export default function ActivitiesPage() {
  const { t } = useT();
  const [activities, setActivities] = useState<any[]>([]);
  const [meta, setMeta] = useState<any>({ page: 1, limit: 20, total: 0, totalPages: 0 });
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({
    activityType: '',
    dateFrom: '',
    dateTo: '',
    keyword: '',
    userId: '',
    page: 1,
  });

  const fetchActivities = useCallback(async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams();
      params.set('page', String(filters.page));
      params.set('limit', '20');
      if (filters.activityType) params.set('activityType', filters.activityType);
      if (filters.dateFrom) params.set('dateFrom', filters.dateFrom);
      if (filters.dateTo) params.set('dateTo', filters.dateTo);
      if (filters.keyword) params.set('keyword', filters.keyword);
      if (filters.userId) params.set('userId', filters.userId);

      const res = await api.get(`/activities?${params.toString()}`);
      setActivities(res.data.data || []);
      setMeta(res.data.meta || {});
    } catch (error) {
      console.error('[ActivitiesPage] load activities failed:', error);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    fetchActivities();
  }, [fetchActivities]);

  const formatDateTime = (d?: string) => {
    if (!d) return '-';
    return new Date(d).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  const handleFilterChange = (key: string, value: string) => {
    setFilters((prev) => ({ ...prev, [key]: value, page: 1 }));
  };

  const getTypeLabel = (type: string) => t(`activities.types.${type}` as any) || type;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">{t('activities.title')}</h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{t('activities.subtitle')}</p>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 items-center">
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <input
            type="text"
            placeholder={t('activities.filters.searchPlaceholder')}
            value={filters.keyword}
            onChange={(e) => handleFilterChange('keyword', e.target.value)}
            className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 pl-9 pr-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
          />
        </div>
        <select
          value={filters.activityType}
          onChange={(e) => handleFilterChange('activityType', e.target.value)}
          className="rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
        >
          <option value="">{t('activities.filters.allTypes')}</option>
          {ACTIVITY_TYPES.map((key) => (
            <option key={key} value={key}>{getTypeLabel(key)}</option>
          ))}
        </select>
        <input
          type="date"
          value={filters.dateFrom}
          onChange={(e) => handleFilterChange('dateFrom', e.target.value)}
          className="rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
          title={t('activities.filters.dateFrom')}
        />
        <input
          type="date"
          value={filters.dateTo}
          onChange={(e) => handleFilterChange('dateTo', e.target.value)}
          className="rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
          title={t('activities.filters.dateTo')}
        />
      </div>

      {/* Activity List */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <p className="text-gray-500 dark:text-gray-400">{t('activities.loading')}</p>
          </div>
        ) : activities.length === 0 ? (
          <div className="flex items-center justify-center py-20">
            <p className="text-gray-400">{t('activities.noActivities')}</p>
          </div>
        ) : (
          <div>
            {activities.map((a: any) => (
              <div
                key={a.id}
                className="flex items-start gap-3 px-4 py-3 border-b border-gray-100 dark:border-gray-800 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-800/50 transition-colors"
              >
                <Clock className={`h-4 w-4 mt-0.5 flex-shrink-0 ${ACTIVITY_ICONS[a.activityType] || 'text-gray-400'}`} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-gray-900 dark:text-white">
                      {getTypeLabel(a.activityType) || a.title || a.activityType}
                    </span>
                    {a.lead && (
                      <Link
                        href={`/leads/${a.leadId}`}
                        className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 dark:text-blue-400"
                      >
                        <Target className="h-3 w-3" />
                        {a.lead.companyName}
                      </Link>
                    )}
                    {a.user && (
                      <span className="inline-flex items-center gap-0.5 text-xs text-gray-400">
                        <User className="h-3 w-3" />
                        {a.user.firstName} {a.user.lastName}
                      </span>
                    )}
                  </div>
                  {a.description && (
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 truncate">{a.description}</p>
                  )}
                </div>
                <span className="text-xs text-gray-400 flex-shrink-0">
                  {formatDateTime(a.occurredAt)}
                </span>
              </div>
            ))}

            {/* Pagination */}
            {meta.totalPages > 1 && (
              <div className="flex items-center justify-between px-4 py-3 border-t border-gray-100 dark:border-gray-800">
                <span className="text-xs text-gray-400">
                  {t('common.pagination.info', { page: String(meta.page), totalPages: String(meta.totalPages), total: String(meta.total) })}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setFilters((prev) => ({ ...prev, page: Math.max(1, meta.page - 1) }))}
                    disabled={meta.page <= 1}
                    className="rounded p-1 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-30"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => setFilters((prev) => ({ ...prev, page: Math.min(meta.totalPages, meta.page + 1) }))}
                    disabled={meta.page >= meta.totalPages}
                    className="rounded p-1 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-30"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
