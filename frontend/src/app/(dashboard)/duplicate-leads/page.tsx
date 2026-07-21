'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import api from '@/lib/api';
import { useAuthStore } from '@/store/authStore';
import { useT } from '@/i18n/use-translation';
import { Search, Eye } from 'lucide-react';

interface DuplicateRecord {
  id: string;
  companyId: string;
  primaryLeadId: string;
  duplicateLeadId: string;
  matchType: string;
  matchScore: number;
  matchReason: string;
  status: string;
  primaryLead: {
    id: string;
    companyName: string;
    contactName?: string;
    contactEmail?: string;
    country?: string;
    website?: string;
    status: string;
    leadGrade?: string;
    owner?: { id: string; firstName: string; lastName: string };
  };
  duplicateLead: {
    id: string;
    companyName: string;
    contactName?: string;
    contactEmail?: string;
    country?: string;
    website?: string;
    status: string;
    leadGrade?: string;
    owner?: { id: string; firstName: string; lastName: string };
  };
  createdAt: string;
}

interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

const MATCH_TYPE_COLORS: Record<string, string> = {
  EMAIL_EXACT: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  DOMAIN_EXACT: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
  PHONE_EXACT: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
  LINKEDIN_EXACT: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  COMPANY_NAME_SIMILAR: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400',
  CONTACT_COMPANY_SIMILAR: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-400',
};

const STATUS_COLORS: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
  confirmed: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  not_duplicate: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  ignored: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  merged: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
};

const MATCH_TYPES = ['EMAIL_EXACT', 'DOMAIN_EXACT', 'PHONE_EXACT', 'LINKEDIN_EXACT', 'COMPANY_NAME_SIMILAR', 'CONTACT_COMPANY_SIMILAR'];
const STATUSES = ['pending', 'confirmed', 'not_duplicate', 'ignored', 'merged'];

export default function DuplicateLeadsPage() {
  const { t } = useT();
  const { user: currentUser } = useAuthStore();
  const [records, setRecords] = useState<DuplicateRecord[]>([]);
  const [meta, setMeta] = useState<PaginationMeta>({ page: 1, limit: 20, total: 0, totalPages: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState('');
  const [matchTypeFilter, setMatchTypeFilter] = useState('');
  const [keyword, setKeyword] = useState('');
  const [page, setPage] = useState(1);

  const currentCompany = currentUser?.companies?.[0];
  const isViewer = currentCompany?.role === 'viewer' &&
    !currentUser?.companies?.some((c: any) => c.role === 'super_admin');
  const canWrite = !isViewer;

  const fetchRecords = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const params: any = { page, limit: 20 };
      if (statusFilter) params.status = statusFilter;
      if (matchTypeFilter) params.matchType = matchTypeFilter;
      if (keyword) params.keyword = keyword;

      const res = await api.get('/duplicate-leads', { params });
      setRecords(res.data.data || []);
      setMeta(res.data.meta || { page: 1, limit: 20, total: 0, totalPages: 0 });
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to load duplicate leads');
    } finally {
      setLoading(false);
    }
  }, [page, statusFilter, matchTypeFilter, keyword]);

  useEffect(() => {
    fetchRecords();
  }, [fetchRecords]);

  const formatDate = (d?: string) => {
    if (!d) return '-';
    return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const getScoreColor = (score: number) => {
    if (score >= 90) return 'text-red-600 dark:text-red-400';
    if (score >= 75) return 'text-orange-600 dark:text-orange-400';
    return 'text-yellow-600 dark:text-yellow-400';
  };

  const getMatchTypeLabel = (mt: string) => t(`duplicates.matchType.${mt}` as any) || mt;
  const getStatusLabel = (s: string) => t(`duplicates.status.${s}` as any) || s;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">{t('duplicates.title')}</h2>
          <p className="text-gray-500 dark:text-gray-400">{t('duplicates.totalRecords', { count: String(meta.total) })}</p>
        </div>
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <input
            type="text"
            value={keyword}
            onChange={(e) => { setKeyword(e.target.value); setPage(1); }}
            placeholder={t('duplicates.filters.searchPlaceholder')}
            className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 pl-10 pr-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
        >
          <option value="">{t('duplicates.filters.allStatuses')}</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>{getStatusLabel(s)}</option>
          ))}
        </select>
        <select
          value={matchTypeFilter}
          onChange={(e) => { setMatchTypeFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
        >
          <option value="">{t('duplicates.filters.allMatchTypes')}</option>
          {MATCH_TYPES.map((mt) => (
            <option key={mt} value={mt}>{getMatchTypeLabel(mt)}</option>
          ))}
        </select>
      </div>

      <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50">
                <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">{t('duplicates.table.primaryLead')}</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">{t('duplicates.table.duplicateLead')}</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">{t('duplicates.table.matchType')}</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">{t('duplicates.table.score')}</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">{t('duplicates.table.status')}</th>
                <th className="text-right px-4 py-3 font-medium text-gray-500 dark:text-gray-400">{t('duplicates.table.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-gray-400">{t('common.loading')}</td>
                </tr>
              ) : records.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-gray-400">{t('duplicates.noDuplicates')}</td>
                </tr>
              ) : (
                records.map((r) => (
                  <tr key={r.id} className="border-b border-gray-100 dark:border-gray-800 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-900/30">
                    <td className="px-4 py-3">
                      <Link href={`/leads/${r.primaryLeadId}`} className="font-medium text-blue-600 dark:text-blue-400 hover:underline">
                        {r.primaryLead.companyName}
                      </Link>
                      <div className="text-xs text-gray-400">{r.primaryLead.contactName || '-'}</div>
                    </td>
                    <td className="px-4 py-3">
                      <Link href={`/leads/${r.duplicateLeadId}`} className="font-medium text-blue-600 dark:text-blue-400 hover:underline">
                        {r.duplicateLead.companyName}
                      </Link>
                      <div className="text-xs text-gray-400">{r.duplicateLead.contactName || '-'}</div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${MATCH_TYPE_COLORS[r.matchType] || ''}`}>
                        {getMatchTypeLabel(r.matchType)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-sm font-semibold ${getScoreColor(r.matchScore)}`}>
                        {r.matchScore}%
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[r.status] || ''}`}>
                        {getStatusLabel(r.status)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <Link
                          href={`/duplicate-leads/${r.id}`}
                          className="rounded p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
                          title={t('duplicates.review')}
                        >
                          <Eye className="h-4 w-4" />
                        </Link>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {meta.totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200 dark:border-gray-800">
            <span className="text-sm text-gray-500 dark:text-gray-400">
              {t('common.pagination.info', { page: String(meta.page), totalPages: String(meta.totalPages), total: String(meta.total) })}
            </span>
            <div className="flex gap-1">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-1 text-sm disabled:opacity-50 hover:bg-gray-50 dark:hover:bg-gray-800"
              >
                {t('common.pagination.prev')}
              </button>
              <button
                onClick={() => setPage((p) => Math.min(meta.totalPages, p + 1))}
                disabled={page >= meta.totalPages}
                className="rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-1 text-sm disabled:opacity-50 hover:bg-gray-50 dark:hover:bg-gray-800"
              >
                {t('common.pagination.next')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
