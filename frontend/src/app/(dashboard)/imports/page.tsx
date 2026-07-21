'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import api from '@/lib/api';
import { useAuthStore } from '@/store/authStore';
import { useT } from '@/i18n/use-translation';
import { FileText, Eye, Upload } from 'lucide-react';

interface ImportTask {
  id: string;
  fileName: string;
  fileSize: number;
  totalRows: number;
  successRows: number;
  skippedRows: number;
  errorRows: number;
  duplicateRows: number;
  status: string;
  createdBy: string;
  createdAt: string;
  completedAt?: string;
}

interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export default function ImportsPage() {
  const { t } = useT();
  const { user: currentUser } = useAuthStore();
  const [imports, setImports] = useState<ImportTask[]>([]);
  const [meta, setMeta] = useState<PaginationMeta>({ page: 1, limit: 20, total: 0, totalPages: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  const currentCompany = currentUser?.companies?.[0];
  const canWrite = currentCompany?.role !== 'viewer' ||
    currentUser?.companies?.some((c: any) => c.role === 'super_admin');

  const fetchImports = useCallback(async () => {
    try {
      setLoading(true);
      const res = await api.get('/imports', { params: { page, limit: 20 } });
      setImports(res.data.data || []);
      setMeta(res.data.meta || { page: 1, limit: 20, total: 0, totalPages: 0 });
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to load imports');
    } finally {
      setLoading(false);
    }
  }, [page]);

  useEffect(() => {
    fetchImports();
  }, [fetchImports]);

  const formatDate = (d?: string) => {
    if (!d) return '-';
    return new Date(d).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  };

  const getStatusLabel = (status: string) => t(`imports.status.${status}`) || status;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">
            {t('imports.title')}
          </h2>
          <p className="text-gray-500 dark:text-gray-400">{t('imports.totalImports', { count: String(meta.total) })}</p>
        </div>
        {canWrite && (
          <Link
            href="/leads/import"
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
          >
            <Upload className="h-4 w-4" />
            {t('imports.newImport')}
          </Link>
        )}
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50">
                <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">{t('imports.table.file')}</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">{t('imports.table.status')}</th>
                <th className="text-center px-4 py-3 font-medium text-gray-500 dark:text-gray-400">{t('imports.table.total')}</th>
                <th className="text-center px-4 py-3 font-medium text-gray-500 dark:text-gray-400">{t('imports.table.success')}</th>
                <th className="text-center px-4 py-3 font-medium text-gray-500 dark:text-gray-400">{t('imports.table.errors')}</th>
                <th className="text-center px-4 py-3 font-medium text-gray-500 dark:text-gray-400">{t('imports.table.duplicates')}</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">{t('imports.table.date')}</th>
                <th className="text-right px-4 py-3 font-medium text-gray-500 dark:text-gray-400">{t('imports.table.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-gray-400">{t('common.loading')}</td>
                </tr>
              ) : imports.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-gray-400">
                    {t('imports.noImports')}
                  </td>
                </tr>
              ) : (
                imports.map((imp) => (
                  <tr
                    key={imp.id}
                    className="border-b border-gray-100 dark:border-gray-800 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-900/30"
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <FileText className="h-4 w-4 text-gray-400" />
                        <span className="font-medium text-gray-900 dark:text-white text-sm">
                          {imp.fileName}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                        imp.status === 'completed'
                          ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                          : imp.status === 'processing'
                          ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                          : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'
                      }`}>
                        {getStatusLabel(imp.status)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center text-gray-600 dark:text-gray-300">{imp.totalRows}</td>
                    <td className="px-4 py-3 text-center">
                      <span className="text-green-600 dark:text-green-400 font-medium">{imp.successRows}</span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={imp.errorRows > 0 ? 'text-red-600 dark:text-red-400 font-medium' : 'text-gray-400'}>
                        {imp.errorRows}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={imp.duplicateRows > 0 ? 'text-amber-600 dark:text-amber-400 font-medium' : 'text-gray-400'}>
                        {imp.duplicateRows}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs text-gray-500">{formatDate(imp.createdAt)}</td>
                    <td className="px-4 py-3 text-right">
                      <Link
                        href={`/imports/${imp.id}`}
                        className="inline-flex items-center gap-1 rounded p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
                        title={t('imports.viewDetail')}
                      >
                        <Eye className="h-4 w-4" />
                      </Link>
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
