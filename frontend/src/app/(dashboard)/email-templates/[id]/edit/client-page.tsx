'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import api from '@/lib/api';
import { useRuntimeRouteParam } from '@/lib/use-runtime-route-param';
import { ArrowLeft, Save, Plus, Trash2, Eye } from 'lucide-react';
import { sanitizeRichHtml } from '@/lib/sanitize-rich-html';

const CATEGORIES = [
  'First Outreach',
  'Follow Up 1',
  'Follow Up 2',
  'Quote Follow Up',
  'Opened No Reply',
  'Clicked No Reply',
  'Old Customer Reactivation',
  'Exhibition Follow Up',
  'Ask Purchasing Manager',
  'Holiday Greeting',
];

const VAR_HINTS: Record<string, string> = {
  '{{contact_name}}': 'Contact person name',
  '{{company_name}}': 'Company name',
  '{{country}}': 'Country',
  '{{product_name}}': 'Product name',
  '{{sender_name}}': 'Your name',
  '{{sender_company}}': 'Your company name',
  '{{website}}': 'Company website',
  '{{pain_point}}': 'Customer pain point',
  '{{last_email_date}}': 'Date of last email',
};

interface VarEntry {
  variable: string;
  label: string;
  isRequired: boolean;
}

export default function EditEmailTemplatePage() {
  const id = useRuntimeRouteParam('id');
  const router = useRouter();
  const [form, setForm] = useState({
    name: '',
    category: 'First Outreach',
    subject: '',
    body: '',
    language: 'en',
    productCategory: '',
    isActive: true,
  });
  const [vars, setVars] = useState<VarEntry[]>([]);
  const [newVar, setNewVar] = useState('');
  const [newVarLabel, setNewVarLabel] = useState('');
  const [newVarRequired, setNewVarRequired] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Preview state
  const [previewData, setPreviewData] = useState<any>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  useEffect(() => {
    if (!id) return;
    const fetchTemplate = async () => {
      try {
        setLoading(true);
        const res = await api.get(`/email-templates/${id}`);
        const d = res.data;
        setForm({
          name: d.name || '',
          category: d.category || 'First Outreach',
          subject: d.subject || '',
          body: d.body || '',
          language: d.language || 'en',
          productCategory: d.productCategory || '',
          isActive: d.isActive ?? true,
        });
        setVars(
          (d.variables || []).map((v: any) => ({
            variable: v.variable,
            label: v.label,
            isRequired: v.isRequired,
          })),
        );
      } catch (err: any) {
        setError(err.response?.data?.message || 'Failed to load template');
      } finally {
        setLoading(false);
      }
    };
    fetchTemplate();
  }, [id]);

  const handleChange = (field: string, value: any) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const addVar = () => {
    if (!newVar.trim()) return;
    const v = newVar.startsWith('{{') ? newVar.trim() : `{{${newVar.trim()}}}`;
    if (vars.some((x) => x.variable === v)) return;
    setVars([...vars, { variable: v, label: newVarLabel || v, isRequired: newVarRequired }]);
    setNewVar('');
    setNewVarLabel('');
    setNewVarRequired(false);
  };

  const removeVar = (variable: string) => {
    setVars(vars.filter((v) => v.variable !== variable));
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      setError(null);
      await api.patch(`/email-templates/${id}`, {
        ...form,
        variables: vars,
      });
      router.push('/email-templates');
    } catch (err: any) {
      const msg = err.response?.data?.message;
      if (Array.isArray(msg)) {
        setError(msg.join(', '));
      } else {
        setError(msg || 'Failed to update template');
      }
    } finally {
      setSaving(false);
    }
  };

  const handlePreview = async () => {
    try {
      setPreviewLoading(true);
      setPreviewData(null);
      const res = await api.post(`/email-templates/${id}/preview`, {
        variables: {
          contact_name: 'John Smith',
          company_name: 'ABC Foods Ltd',
          country: 'United States',
          product_name: 'Macaroni Production Line',
          sender_name: 'David',
          sender_company: 'Vaysen Packaging',
          website: 'https://example.com',
          pain_point: 'improve production efficiency',
          last_email_date: '2026-05-28',
        },
      });
      setPreviewData(res.data);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Preview failed');
    } finally {
      setPreviewLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Link href="/email-templates" className="text-gray-400 hover:text-gray-600"><ArrowLeft className="h-5 w-5" /></Link>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Edit Email Template</h2>
        </div>
        <p className="text-gray-400">Loading...</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center gap-4">
        <Link href="/email-templates" className="text-gray-400 hover:text-gray-600">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <h2 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">Edit Email Template</h2>
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-3 text-sm text-red-600 dark:text-red-400">
          {error}
          <button onClick={() => setError(null)} className="ml-2 text-gray-400 hover:text-gray-600">&times;</button>
        </div>
      )}

      <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 p-6 space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Template Name *</label>
            <input type="text" value={form.name} onChange={(e) => handleChange('name', e.target.value)}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Category *</label>
            <select value={form.category} onChange={(e) => handleChange('category', e.target.value)}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none">
              {CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Language</label>
            <select value={form.language} onChange={(e) => handleChange('language', e.target.value)}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none">
              <option value="en">English</option>
              <option value="zh">Chinese</option>
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Product Category</label>
            <input type="text" value={form.productCategory} onChange={(e) => handleChange('productCategory', e.target.value)}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Subject *</label>
          <input type="text" value={form.subject} onChange={(e) => handleChange('subject', e.target.value)}
            className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Body (HTML) *</label>
          <textarea value={form.body} onChange={(e) => handleChange('body', e.target.value)} rows={12}
            className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none font-mono" />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Template Variables</label>
          <div className="flex gap-2 items-end">
            <div className="flex-1">
              <input type="text" value={newVar} onChange={(e) => setNewVar(e.target.value)}
                placeholder="variable_name"
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" />
            </div>
            <div className="flex-1">
              <input type="text" value={newVarLabel} onChange={(e) => setNewVarLabel(e.target.value)}
                placeholder="Display label"
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" />
            </div>
            <label className="flex items-center gap-1 text-xs text-gray-500">
              <input type="checkbox" checked={newVarRequired} onChange={(e) => setNewVarRequired(e.target.checked)} />
              Required
            </label>
            <button onClick={addVar}
              className="rounded-lg bg-gray-100 dark:bg-gray-800 p-2 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700">
              <Plus className="h-4 w-4" />
            </button>
          </div>

          {vars.length > 0 && (
            <div className="mt-3 space-y-1">
              {vars.map((v) => (
                <div key={v.variable} className="flex items-center gap-2 text-sm">
                  <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 dark:bg-blue-900/20 px-2 py-0.5 text-xs font-mono text-blue-700 dark:text-blue-400">
                    {v.variable}{v.isRequired && ' *'}
                  </span>
                  <span className="text-gray-500 text-xs">{v.label}</span>
                  <button onClick={() => removeVar(v.variable)} className="text-red-400 hover:text-red-600 ml-auto">
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-3">
          <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Predefined Variables</h4>
          <div className="flex flex-wrap gap-1">
            {Object.entries(VAR_HINTS).map(([key, hint]) => (
              <button key={key}
                onClick={() => {
                  if (!vars.some((v) => v.variable === key)) {
                    setVars([...vars, { variable: key, label: hint, isRequired: false }]);
                  }
                }}
                className="inline-flex items-center gap-1 rounded-full bg-gray-200 dark:bg-gray-800 px-2 py-0.5 text-xs text-gray-700 dark:text-gray-300 hover:bg-blue-100 dark:hover:bg-blue-900/20 hover:text-blue-700 dark:hover:text-blue-400 transition-colors"
                title={hint}>
                {key}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <input type="checkbox" id="isActive" checked={form.isActive} onChange={(e) => handleChange('isActive', e.target.checked)}
            className="rounded border-gray-300 dark:border-gray-700" />
          <label htmlFor="isActive" className="text-sm text-gray-700 dark:text-gray-300">Active</label>
        </div>

        <div className="flex gap-3 pt-4">
          <button onClick={handleSave} disabled={saving}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
            <Save className="h-4 w-4" />
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
          <button onClick={handlePreview} disabled={previewLoading}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-300 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50">
            <Eye className="h-4 w-4" />
            Preview
          </button>
          <Link href="/email-templates"
            className="inline-flex items-center gap-2 rounded-lg border border-gray-300 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800">
            Cancel
          </Link>
        </div>
      </div>

      {/* Preview Modal */}
      {previewData && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white dark:bg-gray-950 rounded-xl border border-gray-200 dark:border-gray-800 w-full max-w-2xl max-h-[90vh] overflow-y-auto shadow-xl">
            <div className="p-6">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Preview</h3>
                <button onClick={() => setPreviewData(null)} className="text-gray-400 hover:text-gray-600">&times;</button>
              </div>
              <div className="space-y-4">
                <div>
                  <h4 className="text-sm font-medium text-gray-500 mb-1">Subject</h4>
                  <p className="text-sm text-gray-900 dark:text-white bg-gray-50 dark:bg-gray-900 rounded-lg p-3 border border-gray-200 dark:border-gray-800">
                    {previewData.renderedSubject}
                  </p>
                </div>
                <div>
                  <h4 className="text-sm font-medium text-gray-500 mb-1">Body</h4>
                  <div
                    className="text-sm text-gray-900 dark:text-white bg-gray-50 dark:bg-gray-900 rounded-lg p-4 border border-gray-200 dark:border-gray-800 prose dark:prose-invert max-w-none"
                    dangerouslySetInnerHTML={{ __html: sanitizeRichHtml(previewData.renderedBody) }}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
