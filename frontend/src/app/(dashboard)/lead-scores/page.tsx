'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import api from '@/lib/api';
import { useT } from '@/i18n/use-translation';
import { TrendingUp } from 'lucide-react';

interface ScoreRecord {
  id: string;
  companyId: string;
  leadId: string;
  totalScore: number;
  grade: string;
  scoreReason?: string;
  breakdown?: any;
  calculatedBy?: string;
  calculatedAt: string;
  lead?: {
    companyName: string;
    contactName?: string;
    contactEmail?: string;
    country?: string;
    status: string;
    owner?: { id: string; firstName: string; lastName: string; email: string };
  };
}

interface GradeDistribution {
  A: number;
  B: number;
  C: number;
  D: number;
  unscored: number;
}

const GRADE_COLORS: Record<string, string> = {
  A: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  B: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  C: 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400',
  D: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
};

const GRADE_BAR_COLORS: Record<string, string> = {
  A: 'bg-green-500',
  B: 'bg-blue-500',
  C: 'bg-yellow-500',
  D: 'bg-red-500',
};

export default function LeadScoresPage() {
  const { t } = useT();
  const [scores, setScores] = useState<ScoreRecord[]>([]);
  const [distribution, setDistribution] = useState<GradeDistribution>({ A: 0, B: 0, C: 0, D: 0, unscored: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [total, setTotal] = useState(0);
  const [gradeFilter, setGradeFilter] = useState('');

  const fetchScores = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const params: any = { page, limit: 20 };
      if (gradeFilter) params.grade = gradeFilter;

      const res = await api.get('/lead-scores', { params });
      setScores(res.data.data || []);
      setTotalPages(res.data.meta?.totalPages || 0);
      setTotal(res.data.meta?.total || 0);
      if (res.data.gradeDistribution) {
        setDistribution(res.data.gradeDistribution);
      }
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to load scores');
    } finally {
      setLoading(false);
    }
  }, [page, gradeFilter]);

  useEffect(() => {
    fetchScores();
  }, [fetchScores]);

  const totalGraded = distribution.A + distribution.B + distribution.C + distribution.D;
  const maxGrade = Math.max(distribution.A, distribution.B, distribution.C, distribution.D, 1);

  const formatDate = (d?: string) => {
    if (!d) return '-';
    return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">{t('scores.title')}</h2>
        <p className="text-gray-500 dark:text-gray-400">{t('scores.scoredLeads', { count: String(total) })}</p>
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {/* Grade Distribution */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
          <TrendingUp className="h-5 w-5 text-gray-400" />
          {t('scores.gradeDistribution')}
        </h3>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
          {(['A', 'B', 'C', 'D', 'unscored'] as const).map((grade) => {
            const count = distribution[grade];
            const pct = totalGraded + distribution.unscored > 0
              ? Math.round((count / (totalGraded + distribution.unscored)) * 100)
              : 0;
            return (
              <div key={grade} className="text-center p-4 rounded-lg border border-gray-100 dark:border-gray-800">
                <div className={`inline-flex rounded-full px-3 py-1 text-lg font-bold ${grade !== 'unscored' ? GRADE_COLORS[grade] : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400'}`}>
                  {grade === 'unscored' ? '-' : grade}
                </div>
                <p className="mt-2 text-2xl font-bold text-gray-900 dark:text-white">{count}</p>
                <p className="text-xs text-gray-400">{pct}%</p>
              </div>
            );
          })}
        </div>
        {/* Bar chart */}
        <div className="space-y-2">
          {(['A', 'B', 'C', 'D'] as const).map((grade) => {
            const count = distribution[grade];
            const width = maxGrade > 0 ? Math.round((count / maxGrade) * 100) : 0;
            return (
              <div key={grade} className="flex items-center gap-3">
                <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-bold w-6 justify-center ${GRADE_COLORS[grade]}`}>
                  {grade}
                </span>
                <div className="flex-1 h-5 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
                  <div className={`h-full rounded-full ${GRADE_BAR_COLORS[grade]} transition-all duration-500`} style={{ width: `${width}%` }} />
                </div>
                <span className="text-sm text-gray-500 dark:text-gray-400 w-10 text-right">{count}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Filter */}
      <div className="flex items-center gap-3">
        <select
          value={gradeFilter}
          onChange={(e) => { setGradeFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
        >
          <option value="">{t('scores.allGrades')}</option>
          <option value="A">A (80-100)</option>
          <option value="B">B (60-79)</option>
          <option value="C">C (40-59)</option>
          <option value="D">D (0-39)</option>
        </select>
        {gradeFilter && (
          <button
            onClick={() => { setGradeFilter(''); setPage(1); }}
            className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400"
          >
            {t('scores.clearFilter')}
          </button>
        )}
      </div>

      {/* Scores Table */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50">
                <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">{t('scores.table.lead')}</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">{t('scores.table.score')}</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">{t('scores.table.grade')}</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">{t('scores.table.status')}</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">{t('scores.table.country')}</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">{t('scores.table.owner')}</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">{t('scores.table.calculated')}</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-gray-400">{t('common.loading')}</td>
                </tr>
              ) : scores.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-gray-400">
                    {t('scores.noScoresHint')}
                  </td>
                </tr>
              ) : (
                scores.map((s) => (
                  <tr key={s.id} className="border-b border-gray-100 dark:border-gray-800 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-900/30">
                    <td className="px-4 py-3">
                      <Link href={`/leads/${s.leadId}`} className="font-medium text-blue-600 dark:text-blue-400 hover:underline">
                        {s.lead?.companyName || t('common.unknown')}
                      </Link>
                      {s.lead?.contactName && (
                        <div className="text-xs text-gray-400 mt-0.5">{s.lead.contactName}</div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className="font-semibold text-gray-900 dark:text-white">{s.totalScore}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-bold ${GRADE_COLORS[s.grade] || ''}`}>
                        {s.grade}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-500 dark:text-gray-400 text-xs">
                      {s.lead?.status || '-'}
                    </td>
                    <td className="px-4 py-3 text-gray-500 dark:text-gray-400 text-xs">
                      {s.lead?.country || '-'}
                    </td>
                    <td className="px-4 py-3 text-gray-500 dark:text-gray-400 text-xs">
                      {s.lead?.owner ? `${s.lead.owner.firstName} ${s.lead.owner.lastName}` : '-'}
                    </td>
                    <td className="px-4 py-3 text-gray-500 dark:text-gray-400 text-xs">
                      {formatDate(s.calculatedAt)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200 dark:border-gray-800">
            <span className="text-sm text-gray-500 dark:text-gray-400">
              {t('common.pagination.info', { page: String(page), totalPages: String(totalPages), total: String(total) })}
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
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
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
