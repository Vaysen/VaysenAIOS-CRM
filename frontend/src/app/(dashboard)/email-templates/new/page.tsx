'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { sanitizeRichHtml } from '@/lib/sanitize-rich-html';
import Link from 'next/link';
import api from '@/lib/api';
import { ArrowLeft, Save, Plus, Trash2, Sparkles, Wand2, Eye, Code2 } from 'lucide-react';

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

const HOLIDAYS = ['None', 'Christmas', 'New Year', 'Black Friday', 'Labor Day', 'Summer Season', 'Outdoor Season'];
const MARKETS = ['USA', 'Europe', 'UK', 'Canada', 'Australia', 'Japan', 'Middle East'];
const STYLES = ['Professional B2B', 'Warm Boutique', 'Premium Minimal', 'Outdoor Active', 'Fashion Editorial'];
const COLOR_THEMES = [
  { label: 'Clean Blue', primary: '#1d4ed8', accent: '#dbeafe', bg: '#f8fafc' },
  { label: 'Premium Black', primary: '#111827', accent: '#e5e7eb', bg: '#f9fafb' },
  { label: 'Outdoor Green', primary: '#166534', accent: '#dcfce7', bg: '#f7fee7' },
  { label: 'Warm Gold', primary: '#92400e', accent: '#fef3c7', bg: '#fffbeb' },
  { label: 'Retail Red', primary: '#b91c1c', accent: '#fee2e2', bg: '#fff7ed' },
];

const AI_TEMPLATE_VARIABLES: VarEntry[] = [
  { variable: '{{contact_name}}', label: 'Contact person name', isRequired: false },
  { variable: '{{company_name}}', label: 'Company name', isRequired: true },
  { variable: '{{country}}', label: 'Country', isRequired: false },
  { variable: '{{product_name}}', label: 'Product name', isRequired: false },
  { variable: '{{sender_name}}', label: 'Your name', isRequired: true },
  { variable: '{{sender_company}}', label: 'Your company name', isRequired: true },
  { variable: '{{website}}', label: 'Company website', isRequired: false },
  { variable: '{{sender_website}}', label: 'Company website', isRequired: true },
  { variable: '{{ai_body_html}}', label: 'AI customer-specific email body HTML', isRequired: true },
  { variable: '{{whatsapp_cta_html}}', label: 'Optional WhatsApp CTA block', isRequired: false },
  { variable: '{{whatsapp_url}}', label: 'Optional WhatsApp URL', isRequired: false },
  { variable: '{{pain_point}}', label: 'Customer pain point', isRequired: false },
  { variable: '{{last_email_date}}', label: 'Date of last email', isRequired: false },
  { variable: '{{unsubscribe_link}}', label: 'System unsubscribe link', isRequired: false },
];

interface VarEntry {
  variable: string;
  label: string;
  isRequired: boolean;
}

export default function NewEmailTemplatePage() {
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
  const [showHtmlSource, setShowHtmlSource] = useState(false);
  const [aiOptions, setAiOptions] = useState({
    holiday: 'None',
    market: 'USA',
    style: 'Professional B2B',
    colorTheme: 'Clean Blue',
    layout: 'Image + CTA',
    description: '',
    personalizationRules: 'AI写开发信时必须读取客户资料卡，结合客户公司产品、市场、国家和我们Vaysen Packaging的供应能力匹配内容。',
    forbiddenContent: '不要出现任何虚构地址、美国地址、办公室地址、虚构电话、虚构工厂规模、虚构证书或客户未公开事实。',
    whatsapp: '',
  });
  const [saving, setSaving] = useState(false);
  const [aiGenerating, setAiGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const mergeVars = (nextVars: VarEntry[]) => {
    const merged = new Map<string, VarEntry>();
    [...vars, ...nextVars].forEach((entry) => merged.set(entry.variable, entry));
    setVars(Array.from(merged.values()));
  };

  const generateAiTemplate = async () => {
    try {
      setAiGenerating(true);
      setError(null);
      const res = await api.post('/email-templates/ai-generate', {
        ...aiOptions,
        description: [
          aiOptions.description,
          `AI personalization rules: ${aiOptions.personalizationRules}`,
          `Forbidden content: ${aiOptions.forbiddenContent}`,
        ].filter(Boolean).join('\n\n'),
        category: form.category,
        productCategory: form.productCategory || 'Custom packaging products',
      });
      const data = res.data || {};
      setForm((prev) => ({
        ...prev,
        name: data.name || prev.name,
        category: data.category || prev.category,
        language: data.language || 'en',
        productCategory: data.productCategory || prev.productCategory || 'Custom packaging products',
        subject: data.subject || prev.subject,
        body: data.body || prev.body,
      }));
      mergeVars(Array.isArray(data.variables) ? data.variables : AI_TEMPLATE_VARIABLES);
    } catch (err: any) {
      const msg = err.response?.data?.message;
      setError(Array.isArray(msg) ? msg.join(', ') : msg || 'AI template generation failed');
    } finally {
      setAiGenerating(false);
    }
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      setError(null);
      await api.post('/email-templates', {
        ...form,
        variables: vars,
      });
      router.push('/email-templates');
    } catch (err: any) {
      const msg = err.response?.data?.message;
      if (Array.isArray(msg)) {
        setError(msg.join(', '));
      } else {
        setError(msg || 'Failed to create template');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6 max-w-7xl">
      <div className="flex items-center gap-4">
        <Link href="/email-templates" className="text-gray-400 hover:text-gray-600">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <h2 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">New Email Template</h2>
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-3 text-sm text-red-600 dark:text-red-400">{error}</div>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 p-6 space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Template Name *</label>
            <input type="text" value={form.name} onChange={(e) => handleChange('name', e.target.value)}
              placeholder="e.g. Cold Outreach - USA Machinery"
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
              placeholder="e.g. Machinery"
              className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" />
          </div>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Subject *</label>
          <input type="text" value={form.subject} onChange={(e) => handleChange('subject', e.target.value)}
            placeholder="e.g. Cooperation Opportunity - {{company_name}}"
            className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" />
          <p className="text-xs text-gray-400 mt-1">Use {"{{variable_name}}"} for dynamic substitution</p>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between gap-3">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">Body Preview *</label>
            <button
              type="button"
              onClick={() => setShowHtmlSource((value) => !value)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
            >
              {showHtmlSource ? <Eye className="h-3.5 w-3.5" /> : <Code2 className="h-3.5 w-3.5" />}
              {showHtmlSource ? 'Show Preview' : 'HTML Source'}
            </button>
          </div>

          <div className="overflow-hidden rounded-lg border border-gray-300 bg-gray-100 dark:border-gray-700 dark:bg-gray-900">
            <iframe
              title="Email template preview"
              srcDoc={sanitizeRichHtml(form.body || '<div style="font-family:Arial,Helvetica,sans-serif;padding:32px;color:#9ca3af;text-align:center;">Generate or paste an HTML template to preview it here.</div>')}
              className="h-[460px] w-full bg-white"
              sandbox=""
            />
          </div>

          {showHtmlSource && (
            <textarea value={form.body} onChange={(e) => handleChange('body', e.target.value)} rows={12}
              placeholder="HTML source is optional for advanced editing."
              className="mt-3 w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none font-mono" />
          )}
          <p className="mt-2 text-xs text-gray-400">Business users can review the visual email template here. Use HTML Source only when advanced editing is needed.</p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Template Variables</label>
          <div className="flex gap-2 items-end">
            <div className="flex-1">
              <input type="text" value={newVar} onChange={(e) => setNewVar(e.target.value)}
                placeholder="variable_name (without {{}})"
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

        {/* Variable hints */}
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
            {saving ? 'Saving...' : 'Save Template'}
          </button>
          <Link href="/email-templates"
            className="inline-flex items-center gap-2 rounded-lg border border-gray-300 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800">
            Cancel
          </Link>
        </div>
      </div>

      <aside className="rounded-xl border border-blue-100 dark:border-blue-900/40 bg-white dark:bg-gray-950 p-5 space-y-4 h-fit">
        <div className="flex items-start gap-3">
          <div className="rounded-lg bg-blue-50 dark:bg-blue-900/20 p-2 text-blue-600 dark:text-blue-300">
            <Sparkles className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-base font-semibold text-gray-900 dark:text-white">AI邮件模板生成器</h3>
            <p className="mt-1 text-xs leading-5 text-gray-500 dark:text-gray-400">
              这里只生成邮件外壳和视觉结构，客户专属文案会在群发时由AI按客户资料单独写入。
            </p>
          </div>
        </div>

        <div className="rounded-lg bg-blue-50 p-3 text-xs leading-5 text-blue-800 dark:bg-blue-950/30 dark:text-blue-200">
          流程：1. 选择场景和市场 2. 设定视觉风格 3. 填写AI个性化规则和禁用内容 4. 生成并预览 5. 保存后用于群邮。
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">节日 / 开发场景</label>
            <select value={aiOptions.holiday} onChange={(e) => setAiOptions((prev) => ({ ...prev, holiday: e.target.value }))}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white outline-none focus:ring-2 focus:ring-blue-500">
              {HOLIDAYS.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">市场 / 地区</label>
            <select value={aiOptions.market} onChange={(e) => setAiOptions((prev) => ({ ...prev, market: e.target.value }))}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white outline-none focus:ring-2 focus:ring-blue-500">
              {MARKETS.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">邮件风格</label>
            <select value={aiOptions.style} onChange={(e) => setAiOptions((prev) => ({ ...prev, style: e.target.value }))}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white outline-none focus:ring-2 focus:ring-blue-500">
              {STYLES.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">颜色主题</label>
            <select value={aiOptions.colorTheme} onChange={(e) => setAiOptions((prev) => ({ ...prev, colorTheme: e.target.value }))}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white outline-none focus:ring-2 focus:ring-blue-500">
              {COLOR_THEMES.map((item) => <option key={item.label} value={item.label}>{item.label}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">版式结构</label>
            <select value={aiOptions.layout} onChange={(e) => setAiOptions((prev) => ({ ...prev, layout: e.target.value }))}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white outline-none focus:ring-2 focus:ring-blue-500">
              <option value="Image + CTA">Image + CTA</option>
              <option value="Text Only">Text Only</option>
              <option value="Catalog Focus">Catalog Focus</option>
              <option value="Follow-up Card">Follow-up Card</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">模板描述</label>
            <textarea value={aiOptions.description} onChange={(e) => setAiOptions((prev) => ({ ...prev, description: e.target.value }))}
              rows={4}
              placeholder="描述你想要的结构、阅读感觉、客户类型或开发阶段。例如：适合第一轮冷邮，简洁高级，突出目录册和样品。"
              className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">AI个性化写信规则</label>
            <textarea value={aiOptions.personalizationRules} onChange={(e) => setAiOptions((prev) => ({ ...prev, personalizationRules: e.target.value }))}
              rows={4}
              placeholder="让业务员写自己的偏好，例如：多结合客户官网产品，不要太推销，先问是否有采购计划。"
              className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">禁止出现内容</label>
            <textarea value={aiOptions.forbiddenContent} onChange={(e) => setAiOptions((prev) => ({ ...prev, forbiddenContent: e.target.value }))}
              rows={3}
              placeholder="例如：禁止美国地址、虚构电话、虚构认证、过度夸张工厂实力。"
              className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">WhatsApp CTA（可选）</label>
            <input value={aiOptions.whatsapp} onChange={(e) => setAiOptions((prev) => ({ ...prev, whatsapp: e.target.value }))}
              placeholder="Use saved setting if blank, e.g. +8618959231841"
              className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
        </div>

        <button type="button" onClick={generateAiTemplate} disabled={aiGenerating}
          className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
          {aiGenerating ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" /> : <Wand2 className="h-4 w-4" />}
          {aiGenerating ? '智谱 GLM 生成中...' : '生成空白HTML邮件模板'}
        </button>
      </aside>
      </div>
    </div>
  );
}
