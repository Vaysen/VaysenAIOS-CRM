'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import api from '@/lib/api';
import { useAuthStore } from '@/store/authStore';
import { useT } from '@/i18n/use-translation';
import { ArrowLeft, Plus, Search, Trash2, Pencil, Eye, Power, PowerOff } from 'lucide-react';
import { sanitizeRichHtml } from '@/lib/sanitize-rich-html';

const CATEGORIES = [
  'First Outreach', 'Follow Up 1', 'Follow Up 2', 'Quote Follow Up',
  'Opened No Reply', 'Clicked No Reply', 'Old Customer Reactivation',
  'Exhibition Follow Up', 'Ask Purchasing Manager', 'Holiday Greeting',
];

interface EmailTemplate {
  id: string;
  name: string;
  category: string;
  subject: string;
  language: string;
  productCategory?: string;
  isActive: boolean;
  useCount: number;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
  variables?: { variable: string; label: string; isRequired: boolean }[];
}

export default function EmailTemplatesPage() {
  const { t } = useT();
  const { user: currentUser } = useAuthStore();
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const [languageFilter, setLanguageFilter] = useState('');
  const [activeFilter, setActiveFilter] = useState<string>('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  const [previewTemplate, setPreviewTemplate] = useState<EmailTemplate | null>(null);
  const [previewData, setPreviewData] = useState<{
    renderedSubject?: string; renderedBody?: string; originalSubject?: string; originalBody?: string;
    variablesUsed?: string[]; defaultVariables?: { variable: string; label: string; isRequired: boolean }[];
  } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const currentCompany = currentUser?.companies?.[0];
  const isViewer = currentCompany?.role === 'viewer' && !currentUser?.companies?.some((c: any) => c.role === 'super_admin');
  const canWrite = !isViewer;

  const fetchTemplates = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const params: any = { page, limit: 20 };
      if (search) params.search = search;
      if (categoryFilter) params.category = categoryFilter;
      if (languageFilter) params.language = languageFilter;
      if (activeFilter !== '') params.isActive = activeFilter;
      const res = await api.get('/email-templates', { params });
      setTemplates(res.data.data || []);
      setTotalPages(res.data.meta?.totalPages || 1);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to load templates');
    } finally {
      setLoading(false);
    }
  }, [page, search, categoryFilter, languageFilter, activeFilter]);

  useEffect(() => { fetchTemplates(); }, [fetchTemplates]);

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(t('templates.confirmDeactivate', { name }))) return;
    try {
      setActionLoading(id);
      await api.delete(`/email-templates/${id}`);
      fetchTemplates();
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to deactivate template');
    } finally { setActionLoading(null); }
  };

  const handleToggleStatus = async (template: EmailTemplate) => {
    try {
      setActionLoading(template.id);
      await api.patch(`/email-templates/${template.id}/status`, { isActive: !template.isActive });
      fetchTemplates();
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to update status');
    } finally { setActionLoading(null); }
  };

  const handlePreview = async (template: EmailTemplate) => {
    try {
      setPreviewTemplate(template);
      setPreviewLoading(true);
      setPreviewData(null);
      const res = await api.post(`/email-templates/${template.id}/preview`, {
        variables: {
          contact_name: 'John Smith', company_name: 'ABC Foods Ltd', country: 'United States',
          product_name: 'Macaroni Production Line', sender_name: 'David', sender_company: 'Vaysen Packaging',
          website: 'https://example.com', pain_point: 'improve production efficiency', last_email_date: '2026-05-28',
        },
      });
      setPreviewData(res.data);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Preview failed');
    } finally { setPreviewLoading(false); }
  };

  const formatDate = (d?: string) => {
    if (!d) return '-';
    return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const getCategoryLabel = (cat: string) => t(`templates.categories.${cat}`) || cat;

  return (
    <div className="space-y-6">
      <Link href="/emails" className="inline-flex items-center gap-2 text-sm font-medium text-blue-600 hover:text-blue-700">
        <ArrowLeft className="h-4 w-4" />
        返回邮件工作台
      </Link>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">{t('templates.title')}</h2>
          <p className="text-gray-500 dark:text-gray-400">{t('templates.subtitle')}</p>
        </div>
        {canWrite && (
          <Link href="/email-templates/new" className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors">
            <Plus className="h-4 w-4" />
            {t('templates.createTemplate')}
          </Link>
        )}
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-3 text-sm text-red-600 dark:text-red-400">
          {error}
          <button onClick={() => setError(null)} className="ml-2 text-gray-400 hover:text-gray-600">&times;</button>
        </div>
      )}

      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <input type="text" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            placeholder={t('templates.filters.searchPlaceholder')}
            className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 pl-10 pr-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
          />
        </div>
        <select value={categoryFilter} onChange={(e) => { setCategoryFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none">
          <option value="">{t('templates.filters.allCategories')}</option>
          {CATEGORIES.map((c) => <option key={c} value={c}>{getCategoryLabel(c)}</option>)}
        </select>
        <select value={languageFilter} onChange={(e) => { setLanguageFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none">
          <option value="">{t('templates.filters.allLanguages')}</option>
          <option value="en">{t('common.english')}</option>
          <option value="zh">{t('common.chinese')}</option>
        </select>
        <select value={activeFilter} onChange={(e) => { setActiveFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none">
          <option value="">{t('templates.filters.allStatus')}</option>
          <option value="true">{t('common.active')}</option>
          <option value="false">{t('common.inactive')}</option>
        </select>
        {(categoryFilter || languageFilter || activeFilter !== '' || search) && (
          <button onClick={() => { setCategoryFilter(''); setLanguageFilter(''); setActiveFilter(''); setSearch(''); setPage(1); }}
            className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">
            {t('common.clearFilter')}
          </button>
        )}
      </div>

      <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50">
                <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">{t('templates.table.name')}</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">{t('templates.table.category')}</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">{t('templates.table.subject')}</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">{t('templates.table.lang')}</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">{t('templates.table.status')}</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">{t('templates.table.used')}</th>
                <th className="text-right px-4 py-3 font-medium text-gray-500 dark:text-gray-400">{t('templates.table.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-gray-400">{t('common.loading')}</td></tr>
              ) : templates.length === 0 ? (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-gray-400">{t('templates.noTemplates')}</td></tr>
              ) : (
                templates.map((tmpl) => (
                  <tr key={tmpl.id} className="border-b border-gray-100 dark:border-gray-800 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-900/30">
                    <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">{tmpl.name}</td>
                    <td className="px-4 py-3"><span className="text-xs text-gray-600 dark:text-gray-300">{getCategoryLabel(tmpl.category)}</span></td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-300 truncate max-w-[250px]">{tmpl.subject}</td>
                    <td className="px-4 py-3 text-gray-500 text-xs uppercase">{tmpl.language}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${tmpl.isActive ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'}`}>
                        {tmpl.isActive ? t('common.active') : t('common.inactive')}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs">{tmpl.useCount}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <button onClick={() => handlePreview(tmpl)} disabled={previewLoading && previewTemplate?.id === tmpl.id}
                          className="rounded p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 disabled:opacity-30 transition-colors" title={t('templates.preview')}>
                          <Eye className="h-4 w-4" />
                        </button>
                        {canWrite && (
                          <>
                            <Link href={`/email-templates/${tmpl.id}/edit`}
                              className="rounded p-1.5 text-gray-400 hover:text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20 transition-colors" title={t('common.edit')}>
                              <Pencil className="h-4 w-4" />
                            </Link>
                            <button onClick={() => handleToggleStatus(tmpl)} disabled={actionLoading === tmpl.id}
                              className="rounded p-1.5 text-gray-400 hover:text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-900/20 disabled:opacity-30 transition-colors"
                              title={tmpl.isActive ? t('templates.deactivate') : t('templates.activate')}>
                              {tmpl.isActive ? <PowerOff className="h-4 w-4" /> : <Power className="h-4 w-4" />}
                            </button>
                            <button onClick={() => handleDelete(tmpl.id, tmpl.name)} disabled={actionLoading === tmpl.id}
                              className="rounded p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-30 transition-colors" title={t('common.delete')}>
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </>
                        )}
                        {!canWrite && <span className="text-xs text-gray-400">{t('emailAccounts.viewOnly')}</span>}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {totalPages > 1 && (
          <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200 dark:border-gray-800">
            <span className="text-sm text-gray-500">
              {t('common.pagination.info', { page: String(page), totalPages: String(totalPages), total: '?' })}
            </span>
            <div className="flex gap-1">
              <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}
                className="rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-1 text-sm disabled:opacity-50 hover:bg-gray-50 dark:hover:bg-gray-800">
                {t('common.pagination.prev')}</button>
              <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages}
                className="rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-1 text-sm disabled:opacity-50 hover:bg-gray-50 dark:hover:bg-gray-800">
                {t('common.pagination.next')}</button>
            </div>
          </div>
        )}
      </div>

      {previewTemplate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white dark:bg-gray-950 rounded-xl border border-gray-200 dark:border-gray-800 w-full max-w-2xl max-h-[90vh] overflow-y-auto shadow-xl">
            <div className="p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                  {t('templates.previewTitle', { name: previewTemplate.name })}
                </h3>
                <button onClick={() => { setPreviewTemplate(null); setPreviewData(null); }} className="text-gray-400 hover:text-gray-600">&times;</button>
              </div>
              {previewLoading ? (
                <p className="text-gray-400 py-8 text-center">{t('templates.previewLoading')}</p>
              ) : previewData ? (
                <div className="space-y-4">
                  <div>
                    <h4 className="text-sm font-medium text-gray-500 mb-1">{t('templates.subject')}</h4>
                    <p className="text-sm text-gray-900 dark:text-white bg-gray-50 dark:bg-gray-900 rounded-lg p-3 border border-gray-200 dark:border-gray-800">{previewData.renderedSubject}</p>
                  </div>
                  <div>
                    <h4 className="text-sm font-medium text-gray-500 mb-1">{t('templates.body')}</h4>
                    <div className="text-sm text-gray-900 dark:text-white bg-gray-50 dark:bg-gray-900 rounded-lg p-4 border border-gray-200 dark:border-gray-800 prose dark:prose-invert max-w-none"
                      dangerouslySetInnerHTML={{ __html: sanitizeRichHtml(previewData.renderedBody) }} />
                  </div>
                  {previewData.defaultVariables && previewData.defaultVariables.length > 0 && (
                    <div>
                      <h4 className="text-sm font-medium text-gray-500 mb-1">{t('templates.variables')}</h4>
                      <div className="flex flex-wrap gap-1">
                        {previewData.defaultVariables.map((v) => (
                          <span key={v.variable} className="inline-flex items-center gap-1 rounded-full bg-blue-50 dark:bg-blue-900/20 px-2 py-0.5 text-xs text-blue-700 dark:text-blue-400">
                            {v.variable}{v.isRequired && <span className="text-red-500">*</span>}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
