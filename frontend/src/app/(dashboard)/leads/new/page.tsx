'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import api from '@/lib/api';
import { ArrowLeft } from 'lucide-react';
import { LEAD_STAGES } from '@/lib/lead-constants';
import { useT } from '@/i18n/use-translation';

const BUSINESS_TYPES = [
  { value: 'manufacturer', label: 'Manufacturer' },
  { value: 'distributor', label: 'Distributor' },
  { value: 'importer', label: 'Importer' },
  { value: 'retailer', label: 'Retailer' },
  { value: 'wholesaler', label: 'Wholesaler' },
  { value: 'trading', label: 'Trading' },
  { value: 'other', label: 'Other' },
];

const SOURCE_TYPES = [
  { value: 'manual', label: 'Manual' },
  { value: 'google_search', label: 'Google Search' },
  { value: 'linkedin', label: 'LinkedIn' },
  { value: 'exhibition', label: 'Exhibition' },
  { value: 'csv_import', label: 'CSV Import' },
  { value: 'referral', label: 'Referral' },
  { value: 'b2b_platform', label: 'B2B Platform' },
  { value: 'other', label: 'Other' },
];

export default function NewLeadPage() {
  const router = useRouter();
  const { t } = useT();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState({
    companyName: '',
    leadName: '',
    website: '',
    websiteDomain: '',
    country: '',
    city: '',
    industry: '',
    productCategory: '',
    businessType: '',
    contactName: '',
    contactTitle: '',
    contactEmail: '',
    contactPhone: '',
    whatsapp: '',
    linkedinUrl: '',
    facebookUrl: '',
    sourceUrl: '',
    sourceType: 'manual',
    sourceKeyword: '',
    sourceCountry: '',
    status: 'new',
    confidenceScore: '',
    leadScore: '',
    leadGrade: '',
    notes: '',
    isUncertain: false,
  });

  const updateField = (field: string, value: string | boolean) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.companyName.trim()) {
      setError('Company name is required');
      return;
    }
    try {
      setSaving(true);
      setError(null);
      const payload: any = { ...form };
      if (payload.confidenceScore) payload.confidenceScore = Number(payload.confidenceScore);
      if (payload.leadScore) payload.leadScore = Number(payload.leadScore);
      if (!payload.leadGrade) delete payload.leadGrade;
      if (payload.website && !payload.websiteDomain) {
        try {
          payload.websiteDomain = new URL(payload.website).hostname.replace(/^www\./, '');
        } catch (error) { console.error('[Frontend] operation failed:', error); }
      }
      const res = await api.post('/leads', payload);
      router.push(`/leads/${res.data.id}`);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to create lead');
    } finally {
      setSaving(false);
    }
  };

  const handleUncertainToggle = () => {
    setForm((prev) => ({ ...prev, isUncertain: !prev.isUncertain }));
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center gap-3">
        <Link href="/leads" className="rounded-lg p-1.5 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <h2 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">New Lead</h2>
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 p-6 space-y-6">
        {/* Company Info */}
        <section>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Company Information</h3>
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                Company Name <span className="text-red-500">*</span>
              </label>
              <input type="text" required value={form.companyName} onChange={(e) => updateField('companyName', e.target.value)}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Lead Name</label>
              <input type="text" value={form.leadName} onChange={(e) => updateField('leadName', e.target.value)}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Website</label>
              <input type="url" value={form.website} onChange={(e) => updateField('website', e.target.value)} placeholder="https://"
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Country</label>
              <input type="text" value={form.country} onChange={(e) => updateField('country', e.target.value)} placeholder="US"
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">City</label>
              <input type="text" value={form.city} onChange={(e) => updateField('city', e.target.value)}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Industry</label>
              <input type="text" value={form.industry} onChange={(e) => updateField('industry', e.target.value)}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Product Category</label>
              <input type="text" value={form.productCategory} onChange={(e) => updateField('productCategory', e.target.value)}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Business Type</label>
              <select value={form.businessType} onChange={(e) => updateField('businessType', e.target.value)}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none">
                <option value="">Select type</option>
                {BUSINESS_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
          </div>
        </section>

        {/* Contact Info */}
        <section>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Contact Information</h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Contact Name</label>
              <input type="text" value={form.contactName} onChange={(e) => updateField('contactName', e.target.value)}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Contact Title</label>
              <input type="text" value={form.contactTitle} onChange={(e) => updateField('contactTitle', e.target.value)}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Contact Email</label>
              <input type="email" value={form.contactEmail} onChange={(e) => updateField('contactEmail', e.target.value)}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Contact Phone</label>
              <input type="text" value={form.contactPhone} onChange={(e) => updateField('contactPhone', e.target.value)}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">WhatsApp</label>
              <input type="text" value={form.whatsapp} onChange={(e) => updateField('whatsapp', e.target.value)}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">LinkedIn URL</label>
              <input type="url" value={form.linkedinUrl} onChange={(e) => updateField('linkedinUrl', e.target.value)} placeholder="https://"
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Facebook URL</label>
              <input type="url" value={form.facebookUrl} onChange={(e) => updateField('facebookUrl', e.target.value)} placeholder="https://"
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" />
            </div>
          </div>
        </section>

        {/* Source & Status */}
        <section>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Source & Status</h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Source Type</label>
              <select value={form.sourceType} onChange={(e) => updateField('sourceType', e.target.value)}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none">
                {SOURCE_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Status</label>
              <select value={form.status} onChange={(e) => updateField('status', e.target.value)}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none">
                {LEAD_STAGES.map((v) => <option key={v} value={v}>{t(`leads.stages.${v}`)}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Source URL</label>
              <input type="url" value={form.sourceUrl} onChange={(e) => updateField('sourceUrl', e.target.value)} placeholder="https://"
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Source Keyword</label>
              <input type="text" value={form.sourceKeyword} onChange={(e) => updateField('sourceKeyword', e.target.value)}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Source Country</label>
              <input type="text" value={form.sourceCountry} onChange={(e) => updateField('sourceCountry', e.target.value)}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" />
            </div>
          </div>
        </section>

        {/* Scoring */}
        <section>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Scoring</h3>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Confidence Score (0-100)</label>
              <input type="number" min={0} max={100} value={form.confidenceScore} onChange={(e) => updateField('confidenceScore', e.target.value)}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Lead Score (0-100)</label>
              <input type="number" min={0} max={100} value={form.leadScore} onChange={(e) => updateField('leadScore', e.target.value)}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Lead Grade</label>
              <select value={form.leadGrade} onChange={(e) => updateField('leadGrade', e.target.value)}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none">
                <option value="">None</option>
                <option value="A">A</option>
                <option value="B">B</option>
                <option value="C">C</option>
                <option value="D">D</option>
              </select>
            </div>
          </div>
        </section>

        {/* Notes & Options */}
        <section>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Notes & Options</h3>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Notes</label>
              <textarea rows={3} value={form.notes} onChange={(e) => updateField('notes', e.target.value)}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" />
            </div>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={form.isUncertain} onChange={handleUncertainToggle}
                className="rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
              <span className="text-sm text-gray-700 dark:text-gray-300">
                Mark data as uncertain (is_uncertain)
              </span>
            </label>
          </div>
        </section>

        <div className="flex gap-2 justify-end pt-4 border-t border-gray-200 dark:border-gray-800">
          <Link href="/leads"
            className="rounded-lg border border-gray-300 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
            Cancel
          </Link>
          <button type="submit" disabled={saving}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors">
            {saving ? 'Creating...' : 'Create Lead'}
          </button>
        </div>
      </form>
    </div>
  );
}
