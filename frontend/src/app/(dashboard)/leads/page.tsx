'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import api from '@/lib/api';
import { useAuthStore } from '@/store/authStore';
import { useSelectionStore } from '@/store/selectionStore';
import { Plus, Search, Filter, Trash2, Eye, Pencil, Upload, Send, List, Columns, Mail, MousePointer, Reply, Calendar, Download, FileText, FileSpreadsheet, ShieldCheck, ShieldAlert, ShieldQuestion, ExternalLink, AlertTriangle } from 'lucide-react';
import { CRM_STAGES, STATUS_COLORS, GRADE_COLORS, REVIEW_STATUS_COLORS, FOLLOW_UP_COLORS, EMAIL_VERIFY_COLORS, EMAIL_VERIFY_LABELS, EMAIL_VERIFY_ICONS, REJECTION_REASONS } from '@/lib/lead-constants';
import { useT } from '@/i18n/use-translation';
import { LanguageBadge } from '@/components/common/LanguageBadge';
import dynamic from 'next/dynamic';

const KanbanBoard = dynamic(() => import('@/components/leads/KanbanBoard'), { ssr: false });

interface EmailStats {
  sent: number;
  opened: number;
  clicked: number;
  replied: number;
  bounced: number;
}

interface LeadData {
  id: string;
  companyName: string;
  contactName?: string;
  contactEmail?: string;
  country?: string;
  language?: string;
  productCategory?: string;
  status: string;
  reviewStatus?: string;
  leadGrade?: string;
  leadScore?: number;
  emailVerificationStatus?: string;
  emailVerificationReason?: string;
  sourceUrl?: string;
  sourceType?: string;
  confidenceScore?: number;
  isUncertain?: boolean;
  uncertainFields?: string[];
  owner?: { id: string; firstName: string; lastName: string; email: string };
  lastContactedAt?: string;
  nextFollowUpAt?: string;
  createdAt: string;
  emailStats?: EmailStats;
  followUpStatus?: string;
  tags?: { tag: { id: string; name: string; displayName: string; color: string; category: string } }[];
}

interface TagData {
  id: string; name: string; displayName: string; color: string; category: string;
}

interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export default function LeadsPage() {
  const { t } = useT();
  const { user: currentUser } = useAuthStore();
  const router = useRouter();
  const {
    selectedLeadIds,
    selectAllAcrossPages,
    totalLeads: selectedTotalLeads,
    toggleSelect,
    selectAllOnPage,
    deselectAllOnPage,
    setSelectAllAcrossPages,
    clearSelection,
    isSelected,
    getSelectedCount,
  } = useSelectionStore();

  const [leads, setLeads] = useState<LeadData[]>([]);
  const [meta, setMeta] = useState<PaginationMeta>({ page: 1, limit: 20, total: 0, totalPages: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [reviewStatusFilter, setReviewStatusFilter] = useState('');
  const [countryFilter, setCountryFilter] = useState('');
  const [gradeFilter, setGradeFilter] = useState('');
  const [ownerFilter, setOwnerFilter] = useState('');
  const [productCategoryFilter, setProductCategoryFilter] = useState('');
  const [sourceTypeFilter, setSourceTypeFilter] = useState('');
  const [emailVerificationStatusFilter, setEmailVerificationStatusFilter] = useState('');
  const [createdAfter, setCreatedAfter] = useState('');
  const [createdBefore, setCreatedBefore] = useState('');
  const [users, setUsers] = useState<any[]>([]);
  const [sortBy, setSortBy] = useState('');
  const [page, setPage] = useState(1);
  const [showFilters, setShowFilters] = useState(false);
  const [viewMode, setViewMode] = useState<'list' | 'board'>('list');
  const [showClosed, setShowClosed] = useState(false);
  const [tagFilter, setTagFilter] = useState('');
  const [allTags, setAllTags] = useState<TagData[]>([]);

  const [batchActionLoading, setBatchActionLoading] = useState(false);
  const [batchStatusDropdownOpen, setBatchStatusDropdownOpen] = useState(false);
  const [exportDropdownOpen, setExportDropdownOpen] = useState(false);

  /* ── Batch email sending state ── */
  const [batchEmailSending, setBatchEmailSending] = useState(false);
  const [batchEmailProgress, setBatchEmailProgress] = useState({ sent: 0, total: 0, skipped: 0 });
  const [showBatchEmailModal, setShowBatchEmailModal] = useState(false);
  const [emailAccounts, setEmailAccounts] = useState<any[]>([]);
  const [emailTemplates, setEmailTemplates] = useState<any[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [selectedTemplateId, setSelectedTemplateId] = useState('');

  const currentCompany = currentUser?.companies?.[0];
  const isViewer = currentCompany?.role === 'viewer' &&
    !currentUser?.companies?.some((c: any) => c.role === 'super_admin');
  const canWrite = !isViewer;

  const fetchLeads = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const params: any = { page, limit: 20 };
      if (search) params.search = search;
      params.status = statusFilter || CRM_STAGES.join(',');
      if (reviewStatusFilter) params.reviewStatus = reviewStatusFilter;
      if (countryFilter) params.country = countryFilter;
      if (gradeFilter) params.leadGrade = gradeFilter;
      if (ownerFilter) params.ownerUserId = ownerFilter;
      if (productCategoryFilter) params.productCategory = productCategoryFilter;
      if (sourceTypeFilter) params.sourceType = sourceTypeFilter;
      if (emailVerificationStatusFilter) params.emailVerificationStatus = emailVerificationStatusFilter;
      if (createdAfter) params.createdAfter = createdAfter;
      if (createdBefore) params.createdBefore = createdBefore;
      if (tagFilter) params.tagId = tagFilter;
      if (sortBy) params.sortBy = sortBy;

      const res = await api.get('/leads', { params });
      setLeads(res.data.data || []);
      setMeta(res.data.meta || { page: 1, limit: 20, total: 0, totalPages: 0 });
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to load leads');
    } finally {
      setLoading(false);
    }
  }, [page, search, statusFilter, reviewStatusFilter, countryFilter, gradeFilter, ownerFilter, productCategoryFilter, sourceTypeFilter, emailVerificationStatusFilter, createdAfter, createdBefore, tagFilter, sortBy]);

  useEffect(() => {
    if (viewMode === 'list') fetchLeads();
  }, [fetchLeads, viewMode]);

  useEffect(() => {
    api.get('/users', { params: { limit: 100 } })
      .then((res) => setUsers(res.data?.data || []))
      .catch(() => setUsers([]));
    api.get('/tags')
      .then((res) => setAllTags(res.data?.data || []))
      .catch(() => setAllTags([]));
  }, []);

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(t('leads.confirmDelete'))) return;
    try { setActionLoading(id); await api.delete(`/leads/${id}`); fetchLeads(); }
    catch (err: any) { setError(err.response?.data?.message || 'Failed to delete lead'); }
    finally { setActionLoading(null); }
  };

  const currentPageIds = leads.map((l) => l.id);
  const allOnPageSelected = currentPageIds.length > 0 && currentPageIds.every((id) => isSelected(id));
  const someOnPageSelected = currentPageIds.some((id) => isSelected(id));

  const handleSelectAllOnPage = () => {
    if (allOnPageSelected) {
      deselectAllOnPage(currentPageIds);
    } else {
      selectAllOnPage(currentPageIds);
    }
  };

  const handleSelectAllAcrossPages = () => {
    if (selectAllAcrossPages) {
      clearSelection();
    } else {
      setSelectAllAcrossPages(true, meta.total);
    }
  };

  const handleBatchDelete = async () => {
    const count = getSelectedCount();
    if (!confirm(t('leads.batch.confirmBatchDelete', { count: String(count) }))) return;
    try {
      setBatchActionLoading(true);
      const ids = selectAllAcrossPages ? undefined : Array.from(selectedLeadIds);
      await api.post('/leads/batch', { ids, action: 'delete', selectAll: selectAllAcrossPages, filters: selectAllAcrossPages ? { status: statusFilter || undefined, country: countryFilter || undefined, leadGrade: gradeFilter || undefined, ownerUserId: ownerFilter || undefined } : undefined });
      clearSelection();
      fetchLeads();
    } catch (err: any) {
      setError(err.response?.data?.message || 'Batch delete failed');
    } finally {
      setBatchActionLoading(false);
    }
  };

  const handleBatchStatusChange = async (status: string) => {
    const count = getSelectedCount();
    const statusLabel = t(`leads.stages.${status}`);
    if (!confirm(t('leads.batch.confirmBatchStatus', { count: String(count), status: statusLabel }))) return;
    try {
      setBatchActionLoading(true);
      setBatchStatusDropdownOpen(false);
      const ids = selectAllAcrossPages ? undefined : Array.from(selectedLeadIds);
      await api.post('/leads/batch', { ids, action: 'updateStatus', data: { status }, selectAll: selectAllAcrossPages, filters: selectAllAcrossPages ? { status: statusFilter || undefined, country: countryFilter || undefined, leadGrade: gradeFilter || undefined, ownerUserId: ownerFilter || undefined } : undefined });
      clearSelection();
      fetchLeads();
    } catch (err: any) {
      setError(err.response?.data?.message || 'Batch status change failed');
    } finally {
      setBatchActionLoading(false);
    }
  };

  /* ── Batch email sending ── */
  const fetchEmailResources = async () => {
    try {
      const [accRes, tplRes] = await Promise.all([
        api.get('/email-accounts'),
        api.get('/email-templates'),
      ]);
      setEmailAccounts(accRes.data?.data || accRes.data || []);
      setEmailTemplates(tplRes.data?.data || tplRes.data || []);
    } catch (error) { console.error('[Frontend] operation failed:', error); }
  };

  const openBatchEmailModal = async () => {
    await fetchEmailResources();
    setShowBatchEmailModal(true);
  };

  const handleBatchEmailSend = async () => {
    if (!selectedAccountId || !selectedTemplateId) {
      setError('Please select an email account and template');
      return;
    }

    setBatchEmailSending(true);
    setBatchEmailProgress({ sent: 0, total: getSelectedCount(), skipped: 0 });
    setError(null);

    try {
      const ids = selectAllAcrossPages ? undefined : Array.from(selectedLeadIds);
      const res = await api.post('/emails/send-batch', {
        leadIds: ids,
        emailAccountId: selectedAccountId,
        emailTemplateId: selectedTemplateId,
        sendIntervalSeconds: 30,
        selectAll: selectAllAcrossPages,
        filters: selectAllAcrossPages ? { status: statusFilter || undefined, country: countryFilter || undefined, leadGrade: gradeFilter || undefined, ownerUserId: ownerFilter || undefined } : undefined,
      });
      const data = res.data;
      setBatchEmailProgress({ sent: data.queued || 0, total: data.totalLeads || 0, skipped: data.skipped?.length || 0 });
      clearSelection();
      setShowBatchEmailModal(false);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Batch email send failed');
    } finally {
      setBatchEmailSending(false);
    }
  };

  const handleExport = async (format: 'csv' | 'xlsx') => {
    setExportDropdownOpen(false);
    try {
      const params: any = { format };
      if (search) params.search = search;
      if (statusFilter) params.status = statusFilter;
      if (reviewStatusFilter) params.reviewStatus = reviewStatusFilter;
      if (countryFilter) params.country = countryFilter;
      if (gradeFilter) params.leadGrade = gradeFilter;
      if (ownerFilter) params.ownerUserId = ownerFilter;
      const res = await api.get('/leads/export', { params, responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement('a');
      a.href = url;
      a.download = format === 'csv' ? 'leads_export.csv' : 'leads_export.xlsx';
      a.click();
      window.URL.revokeObjectURL(url);
    } catch (err: any) {
      setError('Export failed');
    }
  };

  const getStatusLabel = (status: string) => t(`leads.stages.${status}`);
  const getReviewLabel = (rs: string) => t(`leads.reviewStatus.${rs}`);

  const formatDate = (d?: string) => {
    if (!d) return '-';
    return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  const activeFilterCount = [statusFilter, reviewStatusFilter, countryFilter, gradeFilter, ownerFilter, productCategoryFilter, sourceTypeFilter, emailVerificationStatusFilter, createdAfter, createdBefore, tagFilter].filter(Boolean).length;
  const selectedCount = getSelectedCount();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">{t('leads.title')}</h2>
          <p className="text-gray-500 dark:text-gray-400">{t('leads.totalLeads', { count: String(meta.total) })}</p>
        </div>
        <div className="flex items-center gap-3">
          {/* View Toggle */}
          <div className="flex rounded-lg border border-gray-300 dark:border-gray-700 overflow-hidden">
            <button
              onClick={() => setViewMode('list')}
              className={`inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium transition-colors ${
                viewMode === 'list'
                  ? 'bg-blue-600 text-white'
                  : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'
              }`}
            >
              <List className="h-4 w-4" />
              {t('leads.listView')}
            </button>
            <button
              onClick={() => setViewMode('board')}
              className={`inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium transition-colors ${
                viewMode === 'board'
                  ? 'bg-blue-600 text-white'
                  : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'
              }`}
            >
              <Columns className="h-4 w-4" />
              {t('leads.boardView')}
            </button>
          </div>

          {/* Export Dropdown */}
          <div className="relative">
            <button
              onClick={() => setExportDropdownOpen(!exportDropdownOpen)}
              className="inline-flex items-center gap-2 rounded-lg border border-gray-300 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
            >
              <Download className="h-4 w-4" />
              {t('leads.export.exportLeads')}
            </button>
            {exportDropdownOpen && (
              <div className="absolute right-0 mt-1 w-40 rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 shadow-lg py-1 z-50">
                <button
                  onClick={() => handleExport('csv')}
                  className="flex items-center gap-2 w-full px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
                >
                  <FileText className="h-4 w-4" />
                  {t('leads.export.csv')}
                </button>
                <button
                  onClick={() => handleExport('xlsx')}
                  className="flex items-center gap-2 w-full px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
                >
                  <FileSpreadsheet className="h-4 w-4" />
                  {t('leads.export.excel')}
                </button>
              </div>
            )}
          </div>

          {canWrite && (
            <>
              <Link
                href="/leads/import"
                className="inline-flex items-center gap-2 rounded-lg border border-gray-300 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
              >
                <Upload className="h-4 w-4" />
                {t('leads.importLeads')}
              </Link>
              <Link
                href="/leads/new"
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
              >
                <Plus className="h-4 w-4" />
                {t('leads.createLead')}
              </Link>
            </>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {/* Search & Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <input
            type="text"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            placeholder={t('leads.searchPlaceholder')}
            className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 pl-10 pr-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
          />
        </div>
        <select
          value={sortBy}
          onChange={(e) => { setSortBy(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
        >
          <option value="">{t('leads.sort.default')}</option>
          <option value="score">{t('leads.sort.scoreHigh')}</option>
          <option value="score_asc">{t('leads.sort.scoreLow')}</option>
          <option value="name">{t('leads.sort.nameAZ')}</option>
        </select>
        <button
          onClick={() => setShowFilters(!showFilters)}
          className={`inline-flex items-center gap-1 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
            showFilters || activeFilterCount > 0
              ? 'border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-900/20 dark:text-blue-400'
              : 'border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800'
          }`}
        >
          <Filter className="h-4 w-4" />
          {t('leads.filters.title')}
          {activeFilterCount > 0 && (
            <span className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full bg-blue-600 text-[10px] text-white">
              {activeFilterCount}
            </span>
          )}
        </button>
        <button
          onClick={() => {
            setEmailVerificationStatusFilter(emailVerificationStatusFilter === 'rejected' ? '' : 'rejected');
            setPage(1);
          }}
          className={`inline-flex items-center gap-1 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
            emailVerificationStatusFilter === 'rejected'
              ? 'border-red-300 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400'
              : 'border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800'
          }`}
        >
          <AlertTriangle className="h-4 w-4" />
          邮箱验证失败
        </button>
        {viewMode === 'board' && (
          <label className="inline-flex items-center gap-1.5 text-sm text-gray-600 dark:text-gray-400 cursor-pointer">
            <input
              type="checkbox"
              checked={showClosed}
              onChange={(e) => setShowClosed(e.target.checked)}
              className="rounded border-gray-300 dark:border-gray-700 text-blue-600 focus:ring-blue-500"
            />
            {t('leads.filters.showWonLost')}
          </label>
        )}
      </div>

      {showFilters && (
        <div className="space-y-3 rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 p-4">
          <div className="flex flex-wrap gap-3">
            <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
              className="rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none">
              <option value="">全部阶段</option>
              {CRM_STAGES.map((v) => <option key={v} value={v}>{t(`leads.stages.${v}`)}</option>)}
            </select>
            <select value={reviewStatusFilter} onChange={(e) => { setReviewStatusFilter(e.target.value); setPage(1); }}
              className="rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none">
              <option value="">全部审核</option>
              <option value="pending">待审核</option>
              <option value="approved">已通过</option>
              <option value="rejected">已拒绝</option>
            </select>
            <input type="text" value={countryFilter} onChange={(e) => { setCountryFilter(e.target.value); setPage(1); }}
              placeholder="国家（如 USA、UK）"
              className="w-44 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" />
            <select value={gradeFilter} onChange={(e) => { setGradeFilter(e.target.value); setPage(1); }}
              className="rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none">
              <option value="">全部评分</option>
              <option value="A">A</option><option value="B">B</option><option value="C">C</option><option value="D">D</option>
            </select>
            <select value={ownerFilter} onChange={(e) => { setOwnerFilter(e.target.value); setPage(1); }}
              className="rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none">
              <option value="">全部业务员</option>
              {users.map((item: any) => (
                <option key={item.id} value={item.id}>{[item.firstName, item.lastName].filter(Boolean).join(' ') || item.email}</option>
              ))}
            </select>
          </div>
          <div className="flex flex-wrap gap-3">
            <select value={productCategoryFilter} onChange={(e) => { setProductCategoryFilter(e.target.value); setPage(1); }}
              className="rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none">
              <option value="">全部分类</option>
              <option value="Fashion/Apparel">Fashion/Apparel</option>
              <option value="Outdoor/Sports">Outdoor/Sports</option>
              <option value="Motorcycle/Helmet">Motorcycle/Helmet</option>
              <option value="Fishing/Hunting">Fishing/Hunting</option>
              <option value="Packaging Buyer">Packaging Buyer</option>
              <option value="Gift/Promotional">Gift/Promotional</option>
              <option value="Kids/Baby">Kids/Baby</option>
              <option value="Electronics/Tech">Electronics/Tech</option>
              <option value="Pet Accessories">Pet Accessories</option>
              <option value="Other">Other</option>
            </select>
            <select value={sourceTypeFilter} onChange={(e) => { setSourceTypeFilter(e.target.value); setPage(1); }}
              className="rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none">
              <option value="">全部来源</option>
              <option value="AI搜索">AI搜索</option>
              <option value="手动录入">手动录入</option>
              <option value="导入">数据导入</option>
            </select>
            <input type="date" value={createdAfter} onChange={(e) => { setCreatedAfter(e.target.value); setPage(1); }}
              title="添加时间起"
              className="rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" />
            <select value={tagFilter} onChange={(e) => { setTagFilter(e.target.value); setPage(1); }}
              className="rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none">
              <option value="">全部标签</option>
              {allTags.map((t) => <option key={t.id} value={t.id}>{t.displayName}</option>)}
            </select>
            <span className="self-center text-xs text-gray-400">至</span>
            <input type="date" value={createdBefore} onChange={(e) => { setCreatedBefore(e.target.value); setPage(1); }}
              title="添加时间止"
              className="rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" />
            {activeFilterCount > 0 && (
              <button onClick={() => { setStatusFilter(''); setReviewStatusFilter(''); setCountryFilter(''); setGradeFilter(''); setOwnerFilter(''); setProductCategoryFilter(''); setSourceTypeFilter(''); setEmailVerificationStatusFilter(''); setCreatedAfter(''); setCreatedBefore(''); setTagFilter(''); setPage(1); }}
                className="text-sm text-red-500 hover:text-red-700 self-center">Clear All</button>
            )}
          </div>
        </div>
      )}

      {/* Board View */}
      {viewMode === 'board' && (
        <KanbanBoard
          search={search}
          countryFilter={countryFilter}
          gradeFilter={gradeFilter}
          ownerUserId={ownerFilter}
          reviewStatus={reviewStatusFilter}
          sortBy={sortBy}
          showClosed={showClosed}
        />
      )}

      {/* List View */}
      {viewMode === 'list' && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50">
                  <th className="w-10 px-3 py-3">
                    <input
                      type="checkbox"
                      checked={selectAllAcrossPages || allOnPageSelected}
                      ref={(el) => { if (el) el.indeterminate = !allOnPageSelected && someOnPageSelected; }}
                      onChange={handleSelectAllOnPage}
                      className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                  </th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">{t('leads.company')}</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">{t('leads.table.contact')}</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">{t('leads.country')}</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">语言</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">{t('leads.score')}</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">{t('leads.status')}</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">{t('leads.table.review')}</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">证据来源</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">{t('leads.table.engagement')}</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">{t('leads.owner')}</th>
                  <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">{t('common.createdAt')}</th>
                  <th className="text-right px-4 py-3 font-medium text-gray-500 dark:text-gray-400">{t('common.actions')}</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={13} className="px-4 py-8 text-center text-gray-400">
                      {t('common.loading')}
                    </td>
                  </tr>
                ) : leads.length === 0 ? (
                  <tr>
                    <td colSpan={13} className="px-4 py-8 text-center text-gray-400">
                      {t('leads.noLeads')}
                    </td>
                  </tr>
                ) : (
                  leads.map((l) => (
                    <tr
                      key={l.id}
                      className={`border-b border-gray-100 dark:border-gray-800 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-900/30 ${isSelected(l.id) ? 'bg-blue-50/50 dark:bg-blue-900/10' : ''}`}
                    >
                      <td className="px-3 py-3">
                        <input
                          type="checkbox"
                          checked={isSelected(l.id)}
                          onChange={() => toggleSelect(l.id)}
                          className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                        />
                      </td>
                      <td className="px-4 py-3">
                        <Link href={`/leads/${l.id}`} className="font-medium text-blue-600 dark:text-blue-400 hover:underline">
                          {l.companyName}
                        </Link>
                        {l.productCategory && (
                          <div className="text-xs text-gray-400 mt-0.5">{l.productCategory}</div>
                        )}
                        {l.tags && l.tags.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-1">
                            {l.tags.slice(0, 3).map((lt) => (
                              <span key={lt.tag.id} className="inline-flex items-center rounded-full px-2 py-0 text-xs font-medium"
                                style={{ backgroundColor: lt.tag.color + '20', color: lt.tag.color }}>
                                {lt.tag.displayName}
                              </span>
                            ))}
                            {l.tags.length > 3 && <span className="text-xs text-gray-400">+{l.tags.length - 3}</span>}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {l.contactName ? (
                          <div>
                            <div className="text-gray-900 dark:text-white text-sm">{l.contactName}</div>
                            {l.contactEmail && (
                              <div className="text-xs text-gray-400">{l.contactEmail}</div>
                            )}
                          </div>
                        ) : (
                          <span className="text-gray-400">-</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-600 dark:text-gray-300">
                        {l.country || '-'}
                      </td>
                      <td className="px-4 py-3">
                        {l.language ? <LanguageBadge language={l.language} size="sm" /> : <span className="text-gray-400">-</span>}
                      </td>
                      <td className="px-4 py-3">
                        {l.leadGrade ? (
                          <div className="flex items-center gap-1.5">
                            <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${GRADE_COLORS[l.leadGrade] || ''}`}>
                              {l.leadGrade}
                            </span>
                            {l.leadScore != null && (
                              <span className="text-sm font-semibold text-gray-900 dark:text-white">{l.leadScore}</span>
                            )}
                          </div>
                        ) : (
                          <span className="text-gray-400">-</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[l.status] || ''}`}>
                          {getStatusLabel(l.status)}
                        </span>
                        {l.followUpStatus && l.followUpStatus !== 'normal' && (
                          <span className={`ml-1 inline-flex rounded-full px-1.5 py-0.5 text-[10px] font-medium ${FOLLOW_UP_COLORS[l.followUpStatus] || ''}`}>
                            {l.followUpStatus === 'due_today' ? t('leads.followUp.dueToday') :
                             l.followUpStatus === 'overdue' ? t('leads.followUp.overdue') :
                             t('leads.followUp.longTimeNoContact')}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {l.reviewStatus ? (
                          <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${REVIEW_STATUS_COLORS[l.reviewStatus] || ''}`}>
                            {getReviewLabel(l.reviewStatus)}
                          </span>
                        ) : (
                          <span className="text-gray-400">-</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-col gap-1">
                          {/* 验证状态 */}
                          {l.emailVerificationStatus ? (
                            <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${EMAIL_VERIFY_COLORS[l.emailVerificationStatus] || ''}`}>
                              <span>{EMAIL_VERIFY_ICONS[l.emailVerificationStatus] || ''}</span>
                              {EMAIL_VERIFY_LABELS[l.emailVerificationStatus] || l.emailVerificationStatus}
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                              <span>❓</span>未验证
                            </span>
                          )}
                          {/* 来源类型 */}
                          {l.sourceType && (
                            <span className="text-xs text-gray-400 truncate max-w-[120px]">{l.sourceType}</span>
                          )}
                          {/* 拒绝原因摘要 */}
                          {l.reviewStatus === 'rejected' && l.emailVerificationReason && (
                            <span className="text-xs text-red-500 truncate max-w-[120px]" title={l.emailVerificationReason}>
                              {REJECTION_REASONS[l.emailVerificationReason] || l.emailVerificationReason}
                            </span>
                          )}
                          {/* 不确定标记 */}
                          {l.isUncertain && (
                            <span className="inline-flex items-center gap-1 text-xs text-amber-600">
                              <ShieldAlert className="h-3 w-3" />待确认
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        {l.emailStats && l.emailStats.sent > 0 ? (
                          <div className="flex items-center gap-1.5 text-xs text-gray-500">
                            {l.emailStats.opened > 0 && (
                              <span className="inline-flex items-center gap-0.5" title="Opened">
                                <Mail className="h-3 w-3" />{l.emailStats.opened}
                              </span>
                            )}
                            {l.emailStats.clicked > 0 && (
                              <span className="inline-flex items-center gap-0.5 text-blue-500" title="Clicked">
                                <MousePointer className="h-3 w-3" />{l.emailStats.clicked}
                              </span>
                            )}
                            {l.emailStats.replied > 0 && (
                              <span className="inline-flex items-center gap-0.5 text-green-500" title="Replied">
                                <Reply className="h-3 w-3" />{l.emailStats.replied}
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="text-gray-400 text-xs">-</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-600 dark:text-gray-300 text-xs">
                        {l.owner ? `${l.owner.firstName} ${l.owner.lastName}` : t('leads.unassigned')}
                      </td>
                      <td className="px-4 py-3 text-gray-500 dark:text-gray-400 text-xs">
                        {formatDate(l.createdAt)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-1">
                          <Link
                            href={`/leads/${l.id}`}
                            className="rounded p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
                            title={t('leads.actions.view')}
                          >
                            <Eye className="h-4 w-4" />
                          </Link>
                          {canWrite && (
                            <>
                              {l.contactEmail && (
                                <Link
                                  href={`/emails/send?leadId=${l.id}`}
                                  className="rounded p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-colors"
                                  title={t('leads.actions.sendEmail')}
                                >
                                  <Send className="h-4 w-4" />
                                </Link>
                              )}
                              <Link
                                href={`/leads/${l.id}/edit`}
                                className="rounded p-1.5 text-gray-400 hover:text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20 transition-colors"
                                title={t('leads.actions.edit')}
                              >
                                <Pencil className="h-4 w-4" />
                              </Link>
                              <button
                                onClick={() => handleDelete(l.id, l.companyName)}
                                disabled={actionLoading === l.id}
                                className="rounded p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-30 transition-colors"
                                title={t('leads.actions.delete')}
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {meta.totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-3 border-t border-gray-200 dark:border-gray-800">
              <span className="text-sm text-gray-500 dark:text-gray-400">
                {t('leads.pagination.info', { page: String(meta.page), totalPages: String(meta.totalPages), total: String(meta.total) })}
              </span>
              <div className="flex gap-1">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  className="rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-1 text-sm disabled:opacity-50 hover:bg-gray-50 dark:hover:bg-gray-800"
                >
                  {t('leads.pagination.prev')}
                </button>
                <button
                  onClick={() => setPage((p) => Math.min(meta.totalPages, p + 1))}
                  disabled={page >= meta.totalPages}
                  className="rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-1 text-sm disabled:opacity-50 hover:bg-gray-50 dark:hover:bg-gray-800"
                >
                  {t('leads.pagination.next')}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Batch Action Toolbar */}
      {selectedCount > 0 && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 shadow-2xl px-5 py-3">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
              {selectAllAcrossPages ? `已选择全部 ${meta.total} 条` : `已选择 ${selectedCount} 条`}
            </span>
            {!selectAllAcrossPages && meta.total > selectedCount && (
              <button
                onClick={handleSelectAllAcrossPages}
                className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
              >
                选择全部 {meta.total} 条
              </button>
            )}
          </div>

          <div className="h-5 w-px bg-gray-300 dark:bg-gray-700" />

          {canWrite && (
            <>
              <button
                onClick={openBatchEmailModal}
                disabled={batchEmailSending}
                className="inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                <Send className="h-4 w-4" />
                Send Emails (30s interval)
              </button>

              <div className="relative">
                <button
                  onClick={() => setBatchStatusDropdownOpen(!batchStatusDropdownOpen)}
                  disabled={batchActionLoading}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-1.5 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50 transition-colors"
                >
                  {t('leads.batch.changeStatus')}
                </button>
                {batchStatusDropdownOpen && (
                  <div className="absolute bottom-full left-0 mb-1 w-40 rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 shadow-lg py-1 z-50">
                    {CRM_STAGES.map((stage) => (
                      <button
                        key={stage}
                        onClick={() => handleBatchStatusChange(stage)}
                        className="flex items-center gap-2 w-full px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
                      >
                        {t(`leads.stages.${stage}`)}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <button
                onClick={handleBatchDelete}
                disabled={batchActionLoading}
                className="inline-flex items-center gap-1.5 rounded-lg border border-red-300 dark:border-red-800 px-3 py-1.5 text-sm font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-50 transition-colors"
              >
                <Trash2 className="h-4 w-4" />
                {t('leads.batch.batchDelete')}
              </button>
            </>
          )}

          <button
            onClick={clearSelection}
            disabled={batchActionLoading}
            className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
          >
            Clear
          </button>
        </div>
      )}

      {/* Batch Email Modal */}
      {showBatchEmailModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-lg rounded-2xl bg-white dark:bg-gray-950 border border-gray-200 dark:border-gray-800 shadow-2xl p-6">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Send Batch Emails</h3>
            <p className="text-sm text-gray-500 mb-4">
              Emails will be sent with a 30-second interval between each. Selected: {selectedCount} customers.
            </p>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Email Account</label>
                <select
                  value={selectedAccountId}
                  onChange={(e) => setSelectedAccountId(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm"
                >
                  <option value="">Select account...</option>
                  {emailAccounts.map((acc: any) => (
                    <option key={acc.id} value={acc.id}>{acc.senderEmail || acc.email} ({acc.senderName || acc.nickname || acc.market || 'Default'})</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Email Template</label>
                <select
                  value={selectedTemplateId}
                  onChange={(e) => setSelectedTemplateId(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm"
                >
                  <option value="">Select template...</option>
                  {emailTemplates.map((tpl: any) => (
                    <option key={tpl.id} value={tpl.id}>{tpl.name}</option>
                  ))}
                </select>
              </div>
            </div>

            {batchEmailSending && (
              <div className="mt-4 rounded-lg bg-blue-50 dark:bg-blue-900/20 p-3">
                <div className="text-sm text-blue-700 dark:text-blue-300">
                  Sending... {batchEmailProgress.sent}/{batchEmailProgress.total} queued
                  {batchEmailProgress.skipped > 0 && ` (${batchEmailProgress.skipped} skipped)`}
                </div>
              </div>
            )}

            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => { setShowBatchEmailModal(false); setSelectedAccountId(''); setSelectedTemplateId(''); }}
                disabled={batchEmailSending}
                className="rounded-lg border border-gray-300 dark:border-gray-700 px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-800"
              >
                Cancel
              </button>
              <button
                onClick={handleBatchEmailSend}
                disabled={batchEmailSending || !selectedAccountId || !selectedTemplateId}
                className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                <Send className="h-4 w-4" />
                {batchEmailSending ? 'Sending...' : `Send to ${selectedCount} customers`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
