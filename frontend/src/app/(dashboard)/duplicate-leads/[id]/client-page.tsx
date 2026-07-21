'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import api from '@/lib/api';
import { useRuntimeRouteParam } from '@/lib/use-runtime-route-param';
import { useAuthStore } from '@/store/authStore';
import { ArrowLeft, GitMerge, CheckCircle, XCircle, EyeOff } from 'lucide-react';

const MATCH_TYPE_LABELS: Record<string, string> = {
  EMAIL_EXACT: 'Email Match',
  DOMAIN_EXACT: 'Domain Match',
  PHONE_EXACT: 'Phone Match',
  LINKEDIN_EXACT: 'LinkedIn Match',
  COMPANY_NAME_SIMILAR: 'Company Name Similar',
  CONTACT_COMPANY_SIMILAR: 'Contact + Company Similar',
};

const STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  confirmed: 'Confirmed',
  not_duplicate: 'Not Duplicate',
  ignored: 'Ignored',
  merged: 'Merged',
};

interface LeadData {
  id: string;
  companyName: string;
  leadName?: string;
  website?: string;
  websiteDomain?: string;
  country?: string;
  city?: string;
  industry?: string;
  productCategory?: string;
  businessType?: string;
  contactName?: string;
  contactTitle?: string;
  contactEmail?: string;
  contactPhone?: string;
  whatsapp?: string;
  linkedinUrl?: string;
  facebookUrl?: string;
  sourceUrl?: string;
  sourceType?: string;
  sourceKeyword?: string;
  sourceCountry?: string;
  confidenceScore?: number;
  leadScore?: number;
  leadGrade?: string;
  status: string;
  notes?: string;
  isUncertain: boolean;
  owner?: { id: string; firstName: string; lastName: string; email: string };
  company?: { id: string; name: string; slug: string };
}

interface DuplicateRecord {
  id: string;
  companyId: string;
  primaryLeadId: string;
  duplicateLeadId: string;
  matchType: string;
  matchScore: number;
  matchReason: string;
  matchFields: any;
  status: string;
  primaryLead: LeadData;
  duplicateLead: LeadData;
  createdAt: string;
}

const COMPARE_FIELDS = [
  { key: 'companyName', label: 'Company Name' },
  { key: 'leadName', label: 'Lead Name' },
  { key: 'website', label: 'Website' },
  { key: 'websiteDomain', label: 'Domain' },
  { key: 'country', label: 'Country' },
  { key: 'city', label: 'City' },
  { key: 'industry', label: 'Industry' },
  { key: 'productCategory', label: 'Product Category' },
  { key: 'businessType', label: 'Business Type' },
  { key: 'contactName', label: 'Contact Name' },
  { key: 'contactTitle', label: 'Contact Title' },
  { key: 'contactEmail', label: 'Contact Email' },
  { key: 'contactPhone', label: 'Contact Phone' },
  { key: 'whatsapp', label: 'WhatsApp' },
  { key: 'linkedinUrl', label: 'LinkedIn URL' },
  { key: 'facebookUrl', label: 'Facebook URL' },
  { key: 'sourceUrl', label: 'Source URL' },
  { key: 'sourceType', label: 'Source Type' },
  { key: 'sourceKeyword', label: 'Source Keyword' },
  { key: 'sourceCountry', label: 'Source Country' },
  { key: 'confidenceScore', label: 'Confidence Score' },
  { key: 'leadScore', label: 'Lead Score' },
  { key: 'leadGrade', label: 'Lead Grade' },
];

export default function DuplicateLeadDetailPage() {
  const { user: currentUser } = useAuthStore();
  const router = useRouter();
  const id = useRuntimeRouteParam('id');

  const [record, setRecord] = useState<DuplicateRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [showMerge, setShowMerge] = useState(false);
  const [fieldChoices, setFieldChoices] = useState<Record<string, string>>({});
  const [mergeNotes, setMergeNotes] = useState('');

  const currentCompany = currentUser?.companies?.[0];
  const isViewer = currentCompany?.role === 'viewer' &&
    !currentUser?.companies?.some((c: any) => c.role === 'super_admin');
  const canWrite = !isViewer;

  const fetchRecord = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await api.get(`/duplicate-leads/${id}`);
      setRecord(res.data);
      // Default: keep primary lead's values
      const defaults: Record<string, string> = {};
      if (res.data.primaryLead && res.data.duplicateLead) {
        COMPARE_FIELDS.forEach(({ key }) => {
          defaults[key] = res.data.primaryLeadId;
        });
      }
      setFieldChoices(defaults);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to load duplicate record');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchRecord();
  }, [fetchRecord]);

  const handleStatusChange = async (status: string) => {
    try {
      setActionLoading(status);
      setError(null);
      await api.patch(`/duplicate-leads/${id}/status`, { status });
      fetchRecord();
    } catch (err: any) {
      setError(err.response?.data?.message || `Failed to ${status}`);
    } finally {
      setActionLoading(null);
    }
  };

  const handleMerge = async () => {
    try {
      setActionLoading('merge');
      setError(null);
      await api.post(`/duplicate-leads/${id}/merge`, {
        fieldChoices,
        notes: mergeNotes || undefined,
      });
      router.push('/duplicate-leads');
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to merge');
      setActionLoading(null);
    }
  };

  const isDifferent = (key: string): boolean => {
    if (!record) return false;
    const pVal = (record.primaryLead as any)[key];
    const dVal = (record.duplicateLead as any)[key];
    if (pVal == null && dVal == null) return false;
    return String(pVal ?? '') !== String(dVal ?? '');
  };

  const getFieldValue = (lead: LeadData, key: string): string => {
    const val = (lead as any)[key];
    if (val == null || val === '') return '-';
    return String(val);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-gray-500 dark:text-gray-400">Loading...</p>
      </div>
    );
  }

  if (error && !record) {
    return (
      <div className="space-y-4">
        <Link href="/duplicate-leads" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400">
          <ArrowLeft className="h-4 w-4" /> Back to Duplicate Leads
        </Link>
        <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      </div>
    );
  }

  if (!record) return null;

  const { primaryLead: primary, duplicateLead: duplicate } = record;
  const isPending = record.status === 'pending' || record.status === 'confirmed';

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Link href="/duplicate-leads" className="rounded-lg p-1.5 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div>
            <h2 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">Duplicate Review</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {primary.companyName} vs {duplicate.companyName}
            </p>
          </div>
        </div>
        {canWrite && isPending && !showMerge && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => handleStatusChange('not_duplicate')}
              disabled={!!actionLoading}
              className="inline-flex items-center gap-1 rounded-lg border border-green-300 dark:border-green-800 px-3 py-2 text-sm font-medium text-green-700 dark:text-green-400 hover:bg-green-50 dark:hover:bg-green-900/20 transition-colors disabled:opacity-50"
            >
              <XCircle className="h-4 w-4" /> Not Duplicate
            </button>
            <button
              onClick={() => handleStatusChange('ignored')}
              disabled={!!actionLoading}
              className="inline-flex items-center gap-1 rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors disabled:opacity-50"
            >
              <EyeOff className="h-4 w-4" /> Ignore
            </button>
            <button
              onClick={() => handleStatusChange('confirmed')}
              disabled={!!actionLoading}
              className="inline-flex items-center gap-1 rounded-lg border border-red-300 dark:border-red-800 px-3 py-2 text-sm font-medium text-red-700 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors disabled:opacity-50"
            >
              <CheckCircle className="h-4 w-4" /> Confirm Duplicate
            </button>
            <button
              onClick={() => setShowMerge(true)}
              disabled={!!actionLoading}
              className="inline-flex items-center gap-1 rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
            >
              <GitMerge className="h-4 w-4" /> Merge
            </button>
          </div>
        )}
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {/* Match Info */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 p-4">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-500 dark:text-gray-400">Match Type:</span>
            <span className="text-sm font-semibold text-gray-900 dark:text-white">
              {MATCH_TYPE_LABELS[record.matchType] || record.matchType}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-500 dark:text-gray-400">Score:</span>
            <span className={`text-sm font-bold ${record.matchScore >= 90 ? 'text-red-600' : record.matchScore >= 75 ? 'text-orange-600' : 'text-yellow-600'}`}>
              {record.matchScore}%
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-500 dark:text-gray-400">Status:</span>
            <span className="text-sm font-semibold text-gray-900 dark:text-white">{STATUS_LABELS[record.status] || record.status}</span>
          </div>
        </div>
        <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{record.matchReason}</p>
      </div>

      {/* Merge Preview */}
      {showMerge && (
        <div className="rounded-xl border-2 border-blue-300 dark:border-blue-800 bg-blue-50/50 dark:bg-blue-950/20 p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Merge Configuration</h3>
          <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
            Select which lead&apos;s value to keep for each conflicting field. Fields that are the same will keep the primary lead&apos;s value.
          </p>
          <div className="space-y-4 mb-4">
            {COMPARE_FIELDS.filter(({ key }) => isDifferent(key)).map(({ key, label }) => (
              <div key={key} className="flex items-center gap-4 p-3 rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800">
                <span className="text-sm font-medium text-gray-700 dark:text-gray-300 w-40 shrink-0">{label}</span>
                <div className="flex items-center gap-2 flex-1">
                  <label className={`flex-1 cursor-pointer rounded-lg border-2 p-2 text-sm ${fieldChoices[key] === record.primaryLeadId ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20' : 'border-gray-200 dark:border-gray-700'}`}>
                    <input
                      type="radio"
                      name={key}
                      value={record.primaryLeadId}
                      checked={fieldChoices[key] === record.primaryLeadId}
                      onChange={() => setFieldChoices((prev) => ({ ...prev, [key]: record.primaryLeadId }))}
                      className="sr-only"
                    />
                    <span className="text-gray-900 dark:text-white">{getFieldValue(primary, key)}</span>
                    <span className="block text-xs text-gray-400">Primary</span>
                  </label>
                  <label className={`flex-1 cursor-pointer rounded-lg border-2 p-2 text-sm ${fieldChoices[key] === record.duplicateLeadId ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20' : 'border-gray-200 dark:border-gray-700'}`}>
                    <input
                      type="radio"
                      name={key}
                      value={record.duplicateLeadId}
                      checked={fieldChoices[key] === record.duplicateLeadId}
                      onChange={() => setFieldChoices((prev) => ({ ...prev, [key]: record.duplicateLeadId }))}
                      className="sr-only"
                    />
                    <span className="text-gray-900 dark:text-white">{getFieldValue(duplicate, key)}</span>
                    <span className="block text-xs text-gray-400">Duplicate</span>
                  </label>
                </div>
              </div>
            ))}
            {COMPARE_FIELDS.filter(({ key }) => isDifferent(key)).length === 0 && (
              <p className="text-sm text-gray-500">No conflicting fields found.</p>
            )}
          </div>
          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Merge Notes</label>
            <textarea rows={2} value={mergeNotes} onChange={(e) => setMergeNotes(e.target.value)}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
              placeholder="Reason for this merge decision..." />
          </div>
          <div className="flex gap-2">
            <button onClick={() => setShowMerge(false)}
              className="rounded-lg border border-gray-300 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800">
              Cancel
            </button>
            <button onClick={handleMerge} disabled={actionLoading === 'merge'}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
              {actionLoading === 'merge' ? 'Merging...' : 'Execute Merge'}
            </button>
          </div>
        </div>
      )}

      {/* Side-by-side comparison */}
      <div className="grid grid-cols-2 gap-6">
        <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
            Primary Lead
            <Link href={`/leads/${primary.id}`} className="ml-2 text-sm text-blue-600 dark:text-blue-400 hover:underline">
              View
            </Link>
          </h3>
          <div className="space-y-1">
            {COMPARE_FIELDS.map(({ key, label }) => {
              const diff = isDifferent(key);
              return (
                <div key={key} className={`flex justify-between py-1.5 border-b border-gray-100 dark:border-gray-800 last:border-0 ${diff ? 'bg-yellow-50 dark:bg-yellow-900/10 -mx-2 px-2 rounded' : ''}`}>
                  <span className="text-xs text-gray-500 dark:text-gray-400">{label}</span>
                  <span className="text-sm text-gray-900 dark:text-white text-right max-w-[60%] truncate">
                    {getFieldValue(primary, key)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
            Duplicate Lead
            <Link href={`/leads/${duplicate.id}`} className="ml-2 text-sm text-blue-600 dark:text-blue-400 hover:underline">
              View
            </Link>
          </h3>
          <div className="space-y-1">
            {COMPARE_FIELDS.map(({ key, label }) => {
              const diff = isDifferent(key);
              return (
                <div key={key} className={`flex justify-between py-1.5 border-b border-gray-100 dark:border-gray-800 last:border-0 ${diff ? 'bg-yellow-50 dark:bg-yellow-900/10 -mx-2 px-2 rounded' : ''}`}>
                  <span className="text-xs text-gray-500 dark:text-gray-400">{label}</span>
                  <span className="text-sm text-gray-900 dark:text-white text-right max-w-[60%] truncate">
                    {getFieldValue(duplicate, key)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
