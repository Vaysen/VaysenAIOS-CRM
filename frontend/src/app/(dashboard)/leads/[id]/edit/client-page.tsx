'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import api from '@/lib/api';
import { useRuntimeRouteParam } from '@/lib/use-runtime-route-param';
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

export default function EditLeadPage() {
  const router = useRouter();
  const id = useRuntimeRouteParam('id');
  const { t } = useT();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

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
    instagramUrl: '',
    twitterUrl: '',
    yearEstablished: '',
    employeeCount: '',
    annualRevenue: '',
    mainProducts: '',
    importPorts: '',
    currentSuppliers: '',
    hasChinaImport: '',
    estimatedOrderVolume: '',
    tags: '',
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

  const fetchLead = useCallback(async () => {
    try {
      setLoading(true);
      const res = await api.get(`/leads/${id}`);
      const d = res.data;
      setForm({
        companyName: d.companyName || '',
        leadName: d.leadName || '',
        website: d.website || '',
        websiteDomain: d.websiteDomain || '',
        country: d.country || '',
        city: d.city || '',
        industry: d.industry || '',
        productCategory: d.productCategory || '',
        businessType: d.businessType || '',
        contactName: d.contactName || '',
        contactTitle: d.contactTitle || '',
        contactEmail: d.contactEmail || '',
        contactPhone: d.contactPhone || '',
        whatsapp: d.whatsapp || '',
        linkedinUrl: d.linkedinUrl || '',
        facebookUrl: d.facebookUrl || '',
        instagramUrl: d.instagramUrl || '',
        twitterUrl: d.twitterUrl || '',
        yearEstablished: d.yearEstablished != null ? String(d.yearEstablished) : '',
        employeeCount: d.employeeCount || '',
        annualRevenue: d.annualRevenue || '',
        mainProducts: d.mainProducts || '',
        importPorts: d.importPorts || '',
        currentSuppliers: d.currentSuppliers || '',
        hasChinaImport: d.hasChinaImport != null ? String(d.hasChinaImport) : '',
        estimatedOrderVolume: d.estimatedOrderVolume || '',
        tags: Array.isArray(d.tags) ? d.tags.join(', ') : '',
        sourceUrl: d.sourceUrl || '',
        sourceType: d.sourceType || 'manual',
        sourceKeyword: d.sourceKeyword || '',
        sourceCountry: d.sourceCountry || '',
        status: d.status || 'new',
        confidenceScore: d.confidenceScore != null ? String(d.confidenceScore) : '',
        leadScore: d.leadScore != null ? String(d.leadScore) : '',
        leadGrade: d.leadGrade || '',
        notes: d.notes || '',
        isUncertain: d.isUncertain ?? false,
      });
    } catch (err: any) {
      setFetchError(err.response?.data?.message || 'Failed to load lead');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchLead();
  }, [fetchLead]);

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
      else delete payload.confidenceScore;
      if (payload.leadScore) payload.leadScore = Number(payload.leadScore);
      else delete payload.leadScore;
      if (!payload.leadGrade) delete payload.leadGrade;
      if (payload.website && !payload.websiteDomain) {
        try {
          payload.websiteDomain = new URL(payload.website).hostname.replace(/^www\./, '');
        } catch (error) { console.error('[Frontend] operation failed:', error); }
      }
      delete (payload as any).isUncertain;
      if (payload.yearEstablished) payload.yearEstablished = Number(payload.yearEstablished);
      else delete payload.yearEstablished;
      if (payload.hasChinaImport === 'true') payload.hasChinaImport = true;
      else if (payload.hasChinaImport === 'false') payload.hasChinaImport = false;
      else delete payload.hasChinaImport;
      if (payload.tags && typeof payload.tags === 'string') {
        payload.tags = (payload.tags as string).split(',').map((t: string) => t.trim()).filter(Boolean);
      }
      await api.patch(`/leads/${id}`, payload);
      router.push(`/leads/${id}`);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to update lead');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-gray-500 dark:text-gray-400">Loading lead...</p>
      </div>
    );
  }

  if (fetchError) {
    return (
      <div className="space-y-4">
        <Link href="/leads" className="inline-flex items-center gap-1 text-sm text-gray-500">
          <ArrowLeft className="h-4 w-4" /> Back to Leads
        </Link>
        <div className="rounded-lg bg-red-50 p-3 text-sm text-red-600">{fetchError}</div>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center gap-3">
        <Link href={`/leads/${id}`} className="rounded-lg p-1.5 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <h2 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">Edit Lead</h2>
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 p-6 space-y-6">
        <section>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Company Information</h3>
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Company Name <span className="text-red-500">*</span></label>
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
              <input type="text" value={form.country} onChange={(e) => updateField('country', e.target.value)}
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

        <section>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Contact Information</h3>
          <div className="grid grid-cols-2 gap-4">
            <div><label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Contact Name</label>
              <input type="text" value={form.contactName} onChange={(e) => updateField('contactName', e.target.value)}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" /></div>
            <div><label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Contact Title</label>
              <input type="text" value={form.contactTitle} onChange={(e) => updateField('contactTitle', e.target.value)}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" /></div>
            <div><label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Contact Email</label>
              <input type="email" value={form.contactEmail} onChange={(e) => updateField('contactEmail', e.target.value)}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" /></div>
            <div><label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Contact Phone</label>
              <input type="text" value={form.contactPhone} onChange={(e) => updateField('contactPhone', e.target.value)}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" /></div>
            <div><label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">WhatsApp</label>
              <input type="text" value={form.whatsapp} onChange={(e) => updateField('whatsapp', e.target.value)}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" /></div>
            <div><label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">LinkedIn URL</label>
              <input type="url" value={form.linkedinUrl} onChange={(e) => updateField('linkedinUrl', e.target.value)} placeholder="https://"
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" /></div>
            <div><label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Facebook URL</label>
              <input type="url" value={form.facebookUrl} onChange={(e) => updateField('facebookUrl', e.target.value)} placeholder="https://"
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" /></div>
            <div><label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Instagram URL</label>
              <input type="url" value={form.instagramUrl} onChange={(e) => updateField('instagramUrl', e.target.value)} placeholder="https://"
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" /></div>
            <div><label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Twitter/X URL</label>
              <input type="url" value={form.twitterUrl} onChange={(e) => updateField('twitterUrl', e.target.value)} placeholder="https://"
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" /></div>
          </div>
        </section>

        <section>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Business Profile</h3>
          <div className="grid grid-cols-2 gap-4">
            <div><label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Year Established</label>
              <input type="number" value={form.yearEstablished} onChange={(e) => updateField('yearEstablished', e.target.value)}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" /></div>
            <div><label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Employee Count</label>
              <select value={form.employeeCount} onChange={(e) => updateField('employeeCount', e.target.value)}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none">
                <option value="">Unknown</option>
                <option value="1-10">1-10</option>
                <option value="10-50">10-50</option>
                <option value="50-200">50-200</option>
                <option value="200-500">200-500</option>
                <option value="500-1000">500-1000</option>
                <option value="1000+">1000+</option>
              </select></div>
            <div><label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Annual Revenue</label>
              <select value={form.annualRevenue} onChange={(e) => updateField('annualRevenue', e.target.value)}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none">
                <option value="">Unknown</option>
                <option value="<$1M">&lt;$1M</option>
                <option value="$1M-$5M">$1M-$5M</option>
                <option value="$5M-$10M">$5M-$10M</option>
                <option value="$10M-$50M">$10M-$50M</option>
                <option value="$50M-$100M">$50M-$100M</option>
                <option value="$100M+">$100M+</option>
              </select></div>
            <div><label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Est. Order Volume</label>
              <input type="text" value={form.estimatedOrderVolume} onChange={(e) => updateField('estimatedOrderVolume', e.target.value)}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" placeholder="e.g. 5 containers/year" /></div>
            <div className="col-span-2"><label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Main Products</label>
              <input type="text" value={form.mainProducts} onChange={(e) => updateField('mainProducts', e.target.value)}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" placeholder="e.g. Fasteners, Bolts, Nuts" /></div>
            <div className="col-span-2"><label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Import Ports</label>
              <input type="text" value={form.importPorts} onChange={(e) => updateField('importPorts', e.target.value)}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" placeholder="e.g. Los Angeles, Long Beach" /></div>
            <div className="col-span-2"><label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Current Suppliers</label>
              <input type="text" value={form.currentSuppliers} onChange={(e) => updateField('currentSuppliers', e.target.value)}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" placeholder="e.g. Company A, Company B" /></div>
            <div><label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Has China Import</label>
              <select value={form.hasChinaImport} onChange={(e) => updateField('hasChinaImport', e.target.value)}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none">
                <option value="">Unknown</option>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </select></div>
            <div><label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Tags</label>
              <input type="text" value={form.tags as string} onChange={(e) => updateField('tags', e.target.value)}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" placeholder="e.g. VIP, 样品需求, 大宗采购" /></div>
          </div>
        </section>

        <section>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Source & Status</h3>
          <div className="grid grid-cols-2 gap-4">
            <div><label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Source Type</label>
              <select value={form.sourceType} onChange={(e) => updateField('sourceType', e.target.value)}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none">
                {SOURCE_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}</select></div>
            <div><label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Status</label>
              <select value={form.status} onChange={(e) => updateField('status', e.target.value)}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none">
                {LEAD_STAGES.map((v) => <option key={v} value={v}>{t(`leads.stages.${v}`)}</option>)}</select></div>
            <div><label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Source URL</label>
              <input type="url" value={form.sourceUrl} onChange={(e) => updateField('sourceUrl', e.target.value)} placeholder="https://"
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" /></div>
            <div><label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Source Keyword</label>
              <input type="text" value={form.sourceKeyword} onChange={(e) => updateField('sourceKeyword', e.target.value)}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" /></div>
            <div><label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Source Country</label>
              <input type="text" value={form.sourceCountry} onChange={(e) => updateField('sourceCountry', e.target.value)}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" /></div>
          </div>
        </section>

        <section>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Scoring</h3>
          <div className="grid grid-cols-3 gap-4">
            <div><label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Confidence Score</label>
              <input type="number" min={0} max={100} value={form.confidenceScore} onChange={(e) => updateField('confidenceScore', e.target.value)}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" /></div>
            <div><label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Lead Score</label>
              <input type="number" min={0} max={100} value={form.leadScore} onChange={(e) => updateField('leadScore', e.target.value)}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" /></div>
            <div><label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Lead Grade</label>
              <select value={form.leadGrade} onChange={(e) => updateField('leadGrade', e.target.value)}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none">
                <option value="">None</option><option value="A">A</option><option value="B">B</option><option value="C">C</option><option value="D">D</option></select></div>
          </div>
        </section>

        <section>
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Notes</h3>
          <div>
            <textarea rows={3} value={form.notes} onChange={(e) => updateField('notes', e.target.value)}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" />
          </div>
        </section>

        <div className="flex gap-2 justify-end pt-4 border-t border-gray-200 dark:border-gray-800">
          <Link href={`/leads/${id}`}
            className="rounded-lg border border-gray-300 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
            Cancel
          </Link>
          <button type="submit" disabled={saving}
            className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors">
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </form>
    </div>
  );
}
