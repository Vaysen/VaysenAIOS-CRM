'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import api from '@/lib/api';
import { useRuntimeRouteParam } from '@/lib/use-runtime-route-param';
import { ArrowLeft, FileText, Download, AlertTriangle, Check, X, ExternalLink } from 'lucide-react';

interface ImportTask {
  id: string;
  fileName: string;
  fileSize: number;
  totalRows: number;
  successRows: number;
  skippedRows: number;
  errorRows: number;
  duplicateRows: number;
  fieldMapping: Record<string, string>;
  status: string;
  createdBy: string;
  createdAt: string;
  completedAt?: string;
}

interface ImportError {
  id: string;
  rowNumber: number;
  fieldName: string;
  errorType: string;
  errorMessage: string;
  rawValue?: string;
}

const LEAD_FIELD_LABELS: Record<string, string> = {
  companyName: 'Company Name',
  website: 'Website',
  websiteDomain: 'Website Domain',
  country: 'Country',
  city: 'City',
  industry: 'Industry',
  productCategory: 'Product Category',
  businessType: 'Business Type',
  contactName: 'Contact Name',
  contactTitle: 'Contact Title',
  contactEmail: 'Contact Email',
  contactPhone: 'Contact Phone',
  whatsapp: 'WhatsApp',
  linkedinUrl: 'LinkedIn URL',
  facebookUrl: 'Facebook URL',
  sourceUrl: 'Source URL',
  sourceType: 'Source Type',
  sourceKeyword: 'Source Keyword',
  sourceCountry: 'Source Country',
  confidenceScore: 'Confidence Score',
  status: 'Status',
  ownerUserId: 'Owner User ID',
  notes: 'Notes',
  isUncertain: 'Is Uncertain',
};

export default function ImportDetailPage() {
  const id = useRuntimeRouteParam('id');
  const [task, setTask] = useState<ImportTask | null>(null);
  const [errors, setErrors] = useState<ImportError[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    if (!id) return;
    const fetchData = async () => {
      try {
        setLoading(true);
        const [taskRes, errorsRes] = await Promise.all([
          api.get(`/imports/${id}`),
          api.get(`/imports/${id}/errors`),
        ]);
        setTask(taskRes.data);
        setErrors(errorsRes.data?.data || []);
      } catch (err: any) {
        setLoadError(err.response?.data?.message || 'Failed to load import detail');
      } finally {
        setLoading(false);
      }
    };
    fetchData();
  }, [id]);

  const handleDownloadErrors = async () => {
    try {
      setDownloading(true);
      const res = await api.get(`/imports/${id}/download-errors`, {
        responseType: 'blob',
      });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement('a');
      a.href = url;
      a.download = `import-errors-${task?.fileName || id}.csv`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (error) {
      console.error('[ImportDetail] download errors failed:', error);
    } finally {
      setDownloading(false);
    }
  };

  const formatDate = (d?: string) => {
    if (!d) return '-';
    return new Date(d).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Link href="/imports" className="text-gray-400 hover:text-gray-600">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Import Detail</h2>
        </div>
        <p className="text-gray-400">Loading...</p>
      </div>
    );
  }

  if (loadError || !task) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Link href="/imports" className="text-gray-400 hover:text-gray-600">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Import Detail</h2>
        </div>
        <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-4 text-sm text-red-600 dark:text-red-400 flex items-center gap-3">
          <AlertTriangle className="h-5 w-5" />
          {loadError || 'Import not found'}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/imports" className="text-gray-400 hover:text-gray-600">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div>
            <h2 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">
              Import Detail
            </h2>
            <p className="text-gray-500 dark:text-gray-400 flex items-center gap-2">
              <FileText className="h-4 w-4" />
              {task.fileName}
            </p>
          </div>
        </div>
        <div className="flex gap-3">
          <Link
            href="/leads"
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
          >
            <ExternalLink className="h-4 w-4" />
            View Leads
          </Link>
          {task.errorRows > 0 && (
            <button
              onClick={handleDownloadErrors}
              disabled={downloading}
              className="inline-flex items-center gap-2 rounded-lg border border-gray-300 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50"
            >
              <Download className="h-4 w-4" />
              {downloading ? 'Downloading...' : 'Download Errors CSV'}
            </button>
          )}
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-5 gap-4">
        <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 p-4 text-center">
          <p className="text-2xl font-bold text-gray-900 dark:text-white">{task.totalRows}</p>
          <p className="text-xs text-gray-500">Total Rows</p>
        </div>
        <div className="rounded-xl border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-900/20 p-4 text-center">
          <p className="text-2xl font-bold text-green-600">{task.successRows}</p>
          <p className="text-xs text-green-500">Imported</p>
        </div>
        <div className="rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-900/20 p-4 text-center">
          <p className="text-2xl font-bold text-red-600">{task.errorRows}</p>
          <p className="text-xs text-red-500">Errors</p>
        </div>
        <div className="rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-4 text-center">
          <p className="text-2xl font-bold text-amber-600">{task.duplicateRows}</p>
          <p className="text-xs text-amber-500">Duplicates</p>
        </div>
        <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 p-4 text-center">
          <p className="text-2xl font-bold text-gray-900 dark:text-white">
            {task.status === 'completed' ? (
              <Check className="h-5 w-5 text-green-500 mx-auto" />
            ) : task.status === 'processing' ? (
              <span className="text-blue-500">...</span>
            ) : (
              <X className="h-5 w-5 text-red-500 mx-auto" />
            )}
          </p>
          <p className="text-xs text-gray-500 capitalize">{task.status}</p>
        </div>
      </div>

      {/* Info */}
      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Import Info</h3>
          <dl className="space-y-3 text-sm">
            <div className="flex justify-between">
              <dt className="text-gray-500">File Name</dt>
              <dd className="text-gray-900 dark:text-white font-medium">{task.fileName}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Status</dt>
              <dd className="text-gray-900 dark:text-white font-medium capitalize">{task.status}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Created At</dt>
              <dd className="text-gray-900 dark:text-white">{formatDate(task.createdAt)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Completed At</dt>
              <dd className="text-gray-900 dark:text-white">{formatDate(task.completedAt)}</dd>
            </div>
          </dl>
        </div>

        <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Field Mapping</h3>
          <div className="grid grid-cols-2 gap-2 text-sm">
            {task.fieldMapping && Object.entries(task.fieldMapping).map(([header, field]) => (
              <div key={header} className="flex items-center gap-2">
                <span className="text-gray-500">{header}</span>
                <span className="text-gray-400">→</span>
                <span className="font-medium text-gray-700 dark:text-gray-300">
                  {LEAD_FIELD_LABELS[field] || field}
                </span>
              </div>
            ))}
            {(!task.fieldMapping || Object.keys(task.fieldMapping).length === 0) && (
              <p className="text-gray-400 col-span-2">No mapping data</p>
            )}
          </div>
        </div>
      </div>

      {/* Errors */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
            Import Errors ({errors.length})
          </h3>
          {errors.length > 0 && (
            <button
              onClick={handleDownloadErrors}
              disabled={downloading}
              className="inline-flex items-center gap-1 text-sm text-blue-600 hover:text-blue-700 dark:text-blue-400"
            >
              <Download className="h-4 w-4" />
              Download CSV
            </button>
          )}
        </div>
        {errors.length === 0 ? (
          <p className="px-6 py-8 text-center text-gray-400">No errors. All rows imported successfully.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50">
                  <th className="text-left px-4 py-2 font-medium text-gray-500 dark:text-gray-400 w-16">Row</th>
                  <th className="text-left px-4 py-2 font-medium text-gray-500 dark:text-gray-400">Field</th>
                  <th className="text-left px-4 py-2 font-medium text-gray-500 dark:text-gray-400">Type</th>
                  <th className="text-left px-4 py-2 font-medium text-gray-500 dark:text-gray-400">Message</th>
                  <th className="text-left px-4 py-2 font-medium text-gray-500 dark:text-gray-400">Raw Value</th>
                </tr>
              </thead>
              <tbody>
                {errors.map((err) => (
                  <tr key={err.id} className="border-b border-gray-100 dark:border-gray-800 last:border-0">
                    <td className="px-4 py-2 text-gray-600 dark:text-gray-300">{err.rowNumber}</td>
                    <td className="px-4 py-2">
                      <span className="text-gray-700 dark:text-gray-300 font-mono text-xs">
                        {err.fieldName || '-'}
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      <span className="inline-flex rounded-full px-2 py-0.5 text-xs font-medium bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">
                        {err.errorType}
                      </span>
                    </td>
                    <td className="px-4 py-2 text-gray-700 dark:text-gray-300">{err.errorMessage}</td>
                    <td className="px-4 py-2 text-gray-500 text-xs max-w-[200px] truncate">
                      {err.rawValue || '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
