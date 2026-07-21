'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import api from '@/lib/api';
import { ArrowLeft, Bot, Search, Send, Users, AlertTriangle } from 'lucide-react';
import sanitizeHtml from 'sanitize-html';

const BATCH_SELECT_LIMIT = 200;
const AI_BATCH_LIMIT = 100;

// Key for cross-page selection persistence
const CROSS_PAGE_KEY = 'email-cross-page-selection';

interface Lead {
  id: string;
  companyName: string;
  contactName?: string;
  contactEmail?: string;
  status: string;
  country?: string;
  productCategory?: string;
  businessType?: string;
  industry?: string;
  owner?: { id: string; firstName?: string; lastName?: string; email: string };
  emailStats?: { sent: number; opened: number; clicked: number; replied: number; bounced: number };
}

interface EmailAccount {
  id: string;
  senderName: string;
  senderEmail: string;
  status: string;
  dailySendLimit: number;
  dailySentCount: number;
}

interface EmailTemplate {
  id: string;
  name: string;
  subject: string;
  category: string;
}

// ── HTML 净化：使用 sanitize-html 库防止 XSS ──
// 允许邮件预览中常见的 HTML 标签和样式，移除 script/iframe/on* 事件等危险内容
function sanitizeEmailHtml(html: string): string {
  if (!html) return '';
  return sanitizeHtml(html, {
    allowedTags: [
      'a', 'b', 'i', 'strong', 'em', 'u', 's', 'strike', 'br', 'p', 'div', 'span',
      'img', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'ul', 'ol', 'li',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'blockquote', 'pre', 'code',
      'font', 'center', 'sub', 'sup', 'dl', 'dt', 'dd',
    ],
    allowedAttributes: {
      a: ['href', 'name', 'target', 'style'],
      img: ['src', 'alt', 'width', 'height', 'style'],
      td: ['colspan', 'rowspan', 'style', 'width'],
      th: ['colspan', 'rowspan', 'style', 'width'],
      table: ['border', 'cellpadding', 'cellspacing', 'style', 'width'],
      span: ['style'],
      div: ['style', 'align'],
      p: ['style', 'align'],
      font: ['color', 'size', 'face'],
      '*': ['style', 'class', 'id', 'align'],
    },
    allowedStyles: {
      '*': {
        'color': [/^.*$/],
        'background-color': [/^.*$/],
        'font-size': [/^.*$/],
        'font-family': [/^.*$/],
        'font-weight': [/^.*$/],
        'font-style': [/^.*$/],
        'text-align': [/^.*$/],
        'text-decoration': [/^.*$/],
        'margin': [/^.*$/],
        'padding': [/^.*$/],
        'border': [/^.*$/],
        'width': [/^.*$/],
        'height': [/^.*$/],
        'line-height': [/^.*$/],
      },
    },
    // 禁止 javascript: 协议和 data: 协议（防 XSS）
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    // 不允许 iframe, script, object, embed 等
    disallowedTagsMode: 'discard',
  });
}

export default function SendEmailPage() {
  const searchParams = useSearchParams();
  const source = searchParams.get('source');
  const preselectedLeadId = searchParams.get('leadId');
  const isProspectSource = source === 'prospects';

  const [step, setStep] = useState<'select' | 'result'>('select');
  const [leads, setLeads] = useState<Lead[]>([]);
  const [accounts, setAccounts] = useState<EmailAccount[]>([]);
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [selectedLeads, setSelectedLeads] = useState<string[]>([]);
  const [selectedAccount, setSelectedAccount] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState('');
  const [productName, setProductName] = useState('');
  const [sendMode, setSendMode] = useState<'single' | 'batch'>('batch');
  const [leadSource, setLeadSource] = useState<'crm' | 'prospect'>(isProspectSource ? 'prospect' : 'crm');
  const [aiPersonalize, setAiPersonalize] = useState(true);
  const [autoColdSend, setAutoColdSend] = useState(false);
  const [sendIntervalSeconds, setSendIntervalSeconds] = useState(30);
  const [search, setSearch] = useState(searchParams.get('search') || '');
  const [countryFilter, setCountryFilter] = useState(searchParams.get('country') || '');
  const [roundFilter, setRoundFilter] = useState(searchParams.get('outreachRound') || '0');
  const [engagementFilter, setEngagementFilter] = useState(searchParams.get('engagement') || '');
  const [profileFilter, setProfileFilter] = useState(searchParams.get('productCategory') || '');
  const [ownerFilter, setOwnerFilter] = useState(searchParams.get('ownerUserId') || '');
  const [emailVerificationStatus, setEmailVerificationStatus] = useState(searchParams.get('emailVerificationStatus') || '');
  const [leadGrade, setLeadGrade] = useState(searchParams.get('leadGrade') || '');
  const [sourceType, setSourceType] = useState(searchParams.get('sourceType') || '');
  const [includeReplied, setIncludeReplied] = useState(searchParams.get('includeReplied') === 'true');
  const [salesUsers, setSalesUsers] = useState<any[]>([]);
  const [page, setPage] = useState(1);
  const [meta, setMeta] = useState({ total: 0, totalPages: 0 });
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<any>(null);
  const [previewSubject, setPreviewSubject] = useState('');
  const [previewBody, setPreviewBody] = useState('');

  // Materials pool
  const [materials, setMaterials] = useState<any[]>([]);
  const [showMaterials, setShowMaterials] = useState(false);
  const [materialUploading, setMaterialUploading] = useState(false);

  // Draft auto-save key
  const draftKey = 'email-draft-send-page';

  const selectedAccountData = accounts.find((a) => a.id === selectedAccount);
  const selectedLeadData = leads.find((l) => l.id === selectedLeads[0]);
  const effectiveAiPersonalize = sendMode === 'batch' ? true : aiPersonalize;

  // ===== Draft Auto-Save =====
  useEffect(() => {
    if (selectedLeads.length > 0 || selectedTemplate || selectedAccount || productName) {
      const draft = { selectedLeads, selectedTemplate, selectedAccount, productName, sendMode, aiPersonalize, autoColdSend, sendIntervalSeconds, timestamp: Date.now() };
      localStorage.setItem(draftKey, JSON.stringify(draft));
    }
  }, [selectedLeads, selectedTemplate, selectedAccount, productName, sendMode, aiPersonalize, autoColdSend, sendIntervalSeconds]);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(draftKey);
      if (saved) {
        const draft = JSON.parse(saved);
        if (Date.now() - draft.timestamp < 3600000) { // 1 hour expiry
          if (draft.selectedLeads?.length && selectedLeads.length === 0) setSelectedLeads(draft.selectedLeads);
          if (draft.selectedTemplate && !selectedTemplate) setSelectedTemplate(draft.selectedTemplate);
          if (draft.selectedAccount && !selectedAccount) setSelectedAccount(draft.selectedAccount);
          if (draft.productName && !productName) setProductName(draft.productName);
          if (draft.sendMode) setSendMode(draft.sendMode);
        }
      }
    } catch (error) { console.error('[Frontend] operation failed:', error); }
  }, []);

  // ===== Materials =====
  useEffect(() => {
    api.get('/materials').then(r => setMaterials(r.data?.data || [])).catch((error) => { console.error('[Frontend] background operation failed:', error); });
  }, []);

  const handleMaterialUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.type === 'application/pdf' && file.size > 10 * 1024 * 1024) {
      setError('PDF 文件不能超过 10MB'); return;
    }
    setMaterialUploading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('name', file.name);
      await api.post('/materials/upload', form);
      const r = await api.get('/materials');
      setMaterials(r.data?.data || []);
    } catch (err: any) { setError(err.response?.data?.message || '上传失败'); }
    finally { setMaterialUploading(false); }
  };

  const insertMaterial = (mat: any) => {
    const backendOrigin = api.defaults.baseURL?.replace(/\/api\/?$/, '') || '';
    const url = `${backendOrigin}/uploads/${mat.filename}`;
    if (mat.type === 'image') {
      setProductName((prev) => prev + `\n<img src="${url}" alt="${mat.name}" style="max-width:100%" />`);
    } else {
      setProductName((prev) => prev + `\n[附件：${mat.name}](${url})`);
    }
  };

  const loadLeads = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get('/leads', {
        params: {
          page,
          limit: 50,
          status: leadSource === 'prospect' ? 'prospect_pool' : 'contacted,interested,qualified,proposal,negotiation,won',
          search: search || undefined,
          country: countryFilter || undefined,
          productCategory: profileFilter || undefined,
          outreachRound: roundFilter || '0',
          engagement: engagementFilter || undefined,
          ownerUserId: ownerFilter || undefined,
          emailVerificationStatus: emailVerificationStatus || undefined,
          leadGrade: leadGrade || undefined,
          sourceType: sourceType || undefined,
          includeReplied: includeReplied ? 'true' : undefined,
          sortBy: isProspectSource ? 'score' : undefined,
        },
      });
      let rows: Lead[] = res.data.data || [];
      if (preselectedLeadId && !rows.some((l) => l.id === preselectedLeadId)) {
        const leadRes = await api.get(`/leads/${preselectedLeadId}`);
        rows = [leadRes.data, ...rows];
      }
      setLeads(rows);
      setMeta(res.data.meta || { total: 0, totalPages: 0 });
    } catch (err: any) {
      setError(err.response?.data?.message || '加载客户失败');
    } finally {
      setLoading(false);
    }
  }, [countryFilter, emailVerificationStatus, engagementFilter, includeReplied, leadGrade, leadSource, ownerFilter, page, preselectedLeadId, profileFilter, roundFilter, search, sourceType]);

  useEffect(() => {
    const loadBase = async () => {
      try {
        const [accountsRes, templatesRes, usersRes] = await Promise.all([
          api.get('/email-accounts', { params: { status: 'active', limit: 50 } }),
          api.get('/email-templates', { params: { isActive: true, limit: 100 } }),
          api.get('/users', { params: { limit: 100 } }),
        ]);
        setAccounts(accountsRes.data.data || []);
        setTemplates(templatesRes.data.data || []);
        setSalesUsers(usersRes.data?.data || []);
      } catch (err: any) {
        setError(err.response?.data?.message || '加载邮箱账号或模板失败');
      }
    };
    loadBase();
  }, []);

  useEffect(() => {
    loadLeads();
  }, [loadLeads]);

  useEffect(() => {
    if (preselectedLeadId && leads.some((l) => l.id === preselectedLeadId && l.contactEmail)) {
      setSelectedLeads([preselectedLeadId]);
    }
  }, [leads, preselectedLeadId]);

  const filteredLeads = useMemo(() => {
    return leads.filter((lead) => {
      // Only apply round/engagement filters for CRM leads (not prospects)
      if (leadSource === 'crm') {
        const stats = lead.emailStats;
        if (roundFilter) {
          const sent = stats?.sent || 0;
          const bucket = sent >= 4 ? '4' : String(sent);
          if (bucket !== roundFilter) return false;
        }
        if (engagementFilter === 'opened' && !(stats?.opened || 0)) return false;
        if (engagementFilter === 'clicked' && !(stats?.clicked || 0)) return false;
        if (engagementFilter === 'replied' && !(stats?.replied || 0)) return false;
      }
      if (profileFilter) {
        const haystack = `${lead.businessType || ''} ${lead.industry || ''} ${lead.productCategory || ''}`.toLowerCase();
        if (!haystack.includes(profileFilter.toLowerCase())) return false;
      }
      return true;
    });
  }, [engagementFilter, leads, leadSource, profileFilter, roundFilter]);

  const sendableLeads = useMemo(() => filteredLeads.filter((l) => !!l.contactEmail), [filteredLeads]);

  const toggleLead = (lead: Lead) => {
    if (!lead.contactEmail) return;
    setPreviewSubject('');
    setPreviewBody('');
    if (sendMode === 'single') {
      setSelectedLeads([lead.id]);
      return;
    }
    setSelectedLeads((prev) => {
      if (prev.includes(lead.id)) return prev.filter((id) => id !== lead.id);
      if (prev.length >= BATCH_SELECT_LIMIT) {
        setError('一次最多选择 ' + BATCH_SELECT_LIMIT + ' 个客户，建议分批发送');
        return prev;
      }
      return [...prev, lead.id];
    });
  };

  const selectCurrentPage = () => {
    const ids = sendableLeads.slice(0, BATCH_SELECT_LIMIT).map((l) => l.id);
    const allSelected = ids.every((id) => selectedLeads.includes(id));
    setSelectedLeads((prev) => {
      const next = allSelected
        ? prev.filter((id) => !ids.includes(id))
        : Array.from(new Set([...prev, ...ids])).slice(0, BATCH_SELECT_LIMIT);
      // Persist across pages
      localStorage.setItem(CROSS_PAGE_KEY, JSON.stringify(next));
      return next;
    });
  };

  // Restore cross-page selections on mount
  useEffect(() => {
    try {
      const saved = localStorage.getItem(CROSS_PAGE_KEY);
      if (saved) {
        const ids = JSON.parse(saved);
        if (ids.length > 0 && selectedLeads.length === 0) setSelectedLeads(ids);
      }
    } catch (error) { console.error('[Frontend] operation failed:', error); }
  }, []);

  const generatePreview = async () => {
    if (selectedLeads.length !== 1) {
      setError('AI 预览需要先选择一个客户');
      return;
    }
    if (!selectedTemplate) {
      setError('请先选择邮件模板，AI 会参考模板语气和结构');
      return;
    }
    setPreviewLoading(true);
    setError(null);
    try {
      if (effectiveAiPersonalize) {
        const res = await api.post('/emails/ai-draft', {
          leadId: selectedLeads[0],
          emailAccountId: selectedAccount || undefined,
          emailTemplateId: selectedTemplate,
          productName: productName || undefined,
        });
        setPreviewSubject(res.data.subject);
        setPreviewBody(res.data.body);
      } else {
        const lead = selectedLeadData;
        const res = await api.post('/email-templates/' + selectedTemplate + '/preview', {
          variables: {
            contact_name: lead?.contactName || 'Contact',
            company_name: lead?.companyName || 'Company',
            country: lead?.country || '',
            product_name: productName || lead?.productCategory || 'custom packaging products',
            sender_name: selectedAccountData?.senderName || 'Sales Team',
            sender_company: 'Your Company',
          },
        });
        setPreviewSubject(res.data.renderedSubject);
        setPreviewBody(res.data.renderedBody);
      }
    } catch (err: any) {
      setError(err.response?.data?.message || '生成预览失败');
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleSend = async () => {
    if (!selectedAccount) {
      setError('请选择发件邮箱');
      return;
    }
    if (!selectedTemplate) {
      setError('请选择邮件模板');
      return;
    }
    if (selectedLeads.length === 0) {
      setError('请选择至少一个可发送客户');
      return;
    }
    if (sendMode === 'batch' && selectedLeads.length > AI_BATCH_LIMIT) {
      setError('AI 个性化批量一次最多 ' + AI_BATCH_LIMIT + ' 个客户，请缩小选择范围');
      return;
    }
    const forceSlowBatch = sendMode === 'batch' && selectedLeads.length > 20;
    if (autoColdSend && !effectiveAiPersonalize) {
      setError('自动发送冷邮必须启用 AI 个性化开发信，确保每个客户先生成专属内容');
      return;
    }

    setSending(true);
    setError(null);
    try {
      if (sendMode === 'single') {
        const res = await api.post('/emails/send-single', {
          leadId: selectedLeads[0],
          emailAccountId: selectedAccount,
          emailTemplateId: selectedTemplate,
          productName: productName || undefined,
          aiPersonalize: effectiveAiPersonalize && !previewBody,
          subject: previewSubject || undefined,
          body: previewBody || undefined,
          outreachRound: Number(roundFilter || 0),
        });
        setResult({ type: 'single', data: res.data });
      } else {
        const res = await api.post('/emails/send-batch', {
          leadIds: selectedLeads,
          emailAccountId: selectedAccount,
          emailTemplateId: selectedTemplate,
          productName: productName || undefined,
          aiPersonalize: true,
          outreachRound: Number(roundFilter || 0),
          filters: {
            status: leadSource === 'prospect' ? 'prospect_pool' : 'contacted,interested,qualified,proposal,negotiation,won',
            search: search || undefined,
            country: countryFilter || undefined,
            productCategory: profileFilter || undefined,
            outreachRound: Number(roundFilter || 0),
            engagement: engagementFilter || undefined,
            ownerUserId: ownerFilter || undefined,
            emailVerificationStatus: emailVerificationStatus || undefined,
            leadGrade: leadGrade || undefined,
            sourceType: sourceType || undefined,
            includeReplied,
          },
          sendIntervalSeconds: autoColdSend || forceSlowBatch ? Math.max(30, sendIntervalSeconds || 30) : 60,
        });
        setResult({ type: 'batch', data: res.data });
      }
      localStorage.removeItem(CROSS_PAGE_KEY);
      setSelectedLeads([]);
      setStep('result');
    } catch (err: any) {
      const msg = err.response?.data?.message || '发送失败';
      setError(Array.isArray(msg) ? msg.join(', ') : msg);
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="max-w-6xl space-y-6">
      <div className="flex items-center gap-4">
        <Link href={isProspectSource ? '/prospects' : '/emails'} className="text-gray-400 hover:text-gray-600">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">
            {isProspectSource ? '群邮开发池发信' : '发送开发信'}
          </h2>
          <p className="text-sm text-gray-500">
            先选择客户、发件邮箱和邮件模板。启用 AI 个性化时，系统会先写信、校验，再进入慢速发送队列。
          </p>
        </div>
      </div>

      {error && (
        <div className="flex items-center justify-between rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="text-gray-400 hover:text-gray-600">&times;</button>
        </div>
      )}

      {step === 'select' && (
        <>
          <section className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-950">
            <div className="grid gap-4 md:grid-cols-2">
              <button
                onClick={() => { setSendMode('single'); setSelectedLeads([]); }}
                className={'rounded-lg border p-4 text-left ' + (sendMode === 'single' ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-900/20' : 'border-gray-200 dark:border-gray-700')}
              >
                <Send className="mb-2 h-5 w-5" />
                <div className="font-medium">单个客户</div>
                <div className="mt-1 text-xs text-gray-500">适合先生成 AI 草稿，确认内容后发送。</div>
              </button>
              <button
                onClick={() => { setSendMode('batch'); setSelectedLeads([]); }}
                className={'rounded-lg border p-4 text-left ' + (sendMode === 'batch' ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-900/20' : 'border-gray-200 dark:border-gray-700')}
              >
                <Users className="mb-2 h-5 w-5" />
                <div className="font-medium">批量开发</div>
                <div className="mt-1 text-xs text-gray-500">最多选择 {BATCH_SELECT_LIMIT} 个；超过 20 个会按慢速队列发送。</div>
              </button>
            </div>
          </section>

          <section className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-950">
            <div className="grid gap-4 md:grid-cols-2">
              <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                发件邮箱
                <select value={selectedAccount} onChange={(e) => setSelectedAccount(e.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-800 dark:text-white">
                  <option value="">选择邮箱账号</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.senderName} ({a.senderEmail}) [{a.dailySentCount}/{a.dailySendLimit}]</option>
                  ))}
                </select>
              </label>
              <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                邮件模板
                <select value={selectedTemplate} onChange={(e) => setSelectedTemplate(e.target.value)} className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-800 dark:text-white">
                  <option value="">选择邮件模板</option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>{t.name} - {t.category}</option>
                  ))}
                </select>
              </label>
              <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                产品/目录关键词
                <input value={productName} onChange={(e) => setProductName(e.target.value)} placeholder="例如 poly mailers, kraft paper bags" className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-800 dark:text-white" />
              </label>
              <div className="space-y-3 rounded-lg border border-gray-200 p-3 text-sm dark:border-gray-800">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={effectiveAiPersonalize}
                    disabled={sendMode === 'batch'}
                    onChange={(e) => setAiPersonalize(e.target.checked)}
                    className="rounded disabled:opacity-60"
                  />
                  启用 AI 个性化开发信
                  {sendMode === 'batch' && <span className="text-xs text-blue-600">批量群邮已强制启用</span>}
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={autoColdSend} onChange={(e) => setAutoColdSend(e.target.checked)} className="rounded" />
                  AI 写好并校验通过后自动慢速发送
                </label>
              </div>
            </div>
          </section>

          <section className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-950">
            <div className="mb-4 grid gap-3 md:grid-cols-6">
              {/* 客户来源切换 */}
              <select value={leadSource} onChange={(e) => { setLeadSource(e.target.value as 'crm' | 'prospect'); setPage(1); setSelectedLeads([]); }} className="rounded-lg border-2 border-blue-300 bg-blue-50 px-3 py-2 text-sm font-medium text-blue-700 dark:border-blue-800 dark:bg-blue-900/20 dark:text-blue-400">
                <option value="prospect">📥 开发池客户</option>
                <option value="crm">📋 CRM 跟进客户</option>
              </select>
              {/* 归属人筛选 */}
              {salesUsers.length > 0 && (
                <select value={ownerFilter} onChange={(e) => { setOwnerFilter(e.target.value); setPage(1); }} className="rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800">
                  <option value="">全部归属人</option>
                  {salesUsers.map((u: any) => (
                    <option key={u.id} value={u.id}>{u.firstName || u.email?.split('@')[0]} {u.lastName || ''}</option>
                  ))}
                </select>
              )}
              <input value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} placeholder="搜索公司、联系人、邮箱" className="rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800" />
              <input value={countryFilter} onChange={(e) => { setCountryFilter(e.target.value); setPage(1); }} placeholder="国家，例如 USA" className="rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800" />
              <select value={roundFilter} onChange={(e) => { setRoundFilter(e.target.value); setPage(1); }} className="rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800">
                <option value="0">未发送</option>
                <option value="1">第 1 轮已发</option>
                <option value="2">第 2 轮已发</option>
                <option value="3">第 3 轮已发</option>
                <option value="4">第 4 轮及以上</option>
              </select>
              <select value={engagementFilter} onChange={(e) => { setEngagementFilter(e.target.value); setPage(1); }} className="rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800">
                <option value="">全部互动</option>
                <option value="opened">已打开</option>
                <option value="clicked">已点击</option>
                <option value="replied">已回复</option>
              </select>
              <input value={profileFilter} onChange={(e) => { setProfileFilter(e.target.value); setPage(1); }} placeholder="客户画像/行业" className="rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800" />
            </div>

            <div className="mb-3 flex items-center justify-between text-sm text-gray-500">
              <span>已选择 {selectedLeads.length} 个客户，当前筛选共 {meta.total} 条</span>
              <button onClick={selectCurrentPage} className="rounded-lg border px-3 py-1.5 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800">选择/取消当前页</button>
            </div>

            <div className="overflow-hidden rounded-lg border border-gray-200 dark:border-gray-800">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 dark:bg-gray-900">
                  <tr>
                    <th className="w-10 px-3 py-2"></th>
                    <th className="px-3 py-2 text-left font-medium text-gray-500">公司</th>
                    <th className="px-3 py-2 text-left font-medium text-gray-500">联系人</th>
                    <th className="px-3 py-2 text-left font-medium text-gray-500">邮箱</th>
                    <th className="px-3 py-2 text-left font-medium text-gray-500">国家</th>
                    <th className="px-3 py-2 text-left font-medium text-gray-500">品类</th>
                    <th className="px-3 py-2 text-left font-medium text-gray-500">已发</th>
                    <th className="px-3 py-2 text-left font-medium text-gray-500">归属</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
                  {loading ? (
                    <tr><td colSpan={8} className="px-3 py-8 text-center text-gray-400">加载中...</td></tr>
                  ) : filteredLeads.length === 0 ? (
                    <tr><td colSpan={8} className="px-3 py-8 text-center text-gray-400">没有可选客户</td></tr>
                  ) : filteredLeads.map((lead) => {
                    const selected = selectedLeads.includes(lead.id);
                    return (
                      <tr key={lead.id} onClick={() => toggleLead(lead)} className={(lead.contactEmail ? 'cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-900/40 ' : 'opacity-40 ') + (selected ? 'bg-blue-50 dark:bg-blue-900/20' : '')}>
                        <td className="px-3 py-2"><input type="checkbox" checked={selected} disabled={!lead.contactEmail} onChange={() => {}} className="rounded" /></td>
                        <td className="px-3 py-2 font-medium text-gray-900 dark:text-white">{lead.companyName}</td>
                        <td className="px-3 py-2 text-gray-500">{lead.contactName || '-'}</td>
                        <td className="px-3 py-2 text-gray-500">{lead.contactEmail || <span className="text-red-400">无邮箱</span>}</td>
                        <td className="px-3 py-2 text-gray-500">{lead.country || '-'}</td>
                        <td className="px-3 py-2 text-gray-500">{lead.productCategory || '-'}</td>
                        <td className="px-3 py-2 text-center text-xs">
                          {lead.emailStats && lead.emailStats.sent > 0 ? (
                            <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 dark:bg-blue-900/20 px-2 py-0.5 text-blue-700 dark:text-blue-400 font-medium" title={`已发${lead.emailStats.sent}封 / 打开${lead.emailStats.opened || 0} / 点击${lead.emailStats.clicked || 0} / 回复${lead.emailStats.replied || 0}`}>
                              第{lead.emailStats.sent}轮
                            </span>
                          ) : (
                            <span className="text-gray-300">-</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-xs text-gray-400">{lead.owner ? (lead.owner.firstName || lead.owner.email?.split('@')[0]) : '-'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {meta.totalPages > 1 && (
              <div className="mt-3 flex items-center justify-between text-sm text-gray-500">
                <span>第 {page} / {meta.totalPages} 页</span>
                <div className="flex gap-2">
                  <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="rounded border px-3 py-1 disabled:opacity-50">上一页</button>
                  <button disabled={page >= meta.totalPages} onClick={() => setPage((p) => p + 1)} className="rounded border px-3 py-1 disabled:opacity-50">下一页</button>
                </div>
              </div>
            )}
          </section>

          {selectedTemplate && (
            <section className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-950">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-gray-900 dark:text-white">邮件预览</h3>
                <button onClick={generatePreview} disabled={previewLoading || selectedLeads.length !== 1} className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm hover:bg-gray-50 disabled:opacity-50 dark:border-gray-700 dark:hover:bg-gray-800">
                  <Bot className="h-4 w-4" />{previewLoading ? '生成中...' : effectiveAiPersonalize ? 'AI 生成专属开发信' : '模板预览'}
                </button>
              </div>
              {previewSubject && <div className="mt-4 rounded-lg bg-gray-50 p-3 text-sm dark:bg-gray-900"><span className="text-gray-500">主题：</span>{previewSubject}</div>}
              {previewBody && <div className="mt-3 max-h-80 overflow-y-auto rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900" dangerouslySetInnerHTML={{ __html: sanitizeEmailHtml(previewBody) }} />}
              {!previewBody && <p className="mt-3 text-xs text-gray-500">单个客户可先预览。批量发送时，系统会为每个客户分别生成正文。</p>}
            </section>
          )}

          <div className="flex justify-end gap-3">
            <Link href={isProspectSource ? '/prospects' : '/emails'} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800">取消</Link>
            <button
              onClick={handleSend}
              disabled={sending}
              title={!selectedAccount ? '请选择发件邮箱' : !selectedTemplate ? '请选择邮件模板' : selectedLeads.length === 0 ? '请选择至少一个客户' : '提交发送任务'}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              <Send className="h-4 w-4" />{sending ? '处理中...' : sendMode === 'single' ? '发送开发信' : '发送给 ' + selectedLeads.length + ' 个客户'}
            </button>
          </div>
        </>
      )}

      {step === 'result' && result && (
        <section className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-950">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">发送任务已提交</h3>
          {result.type === 'single' ? (
            <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{result.data.message}，状态：{result.data.status}</p>
          ) : (
            <div className="mt-4 flex gap-4">
              <div className="rounded-lg bg-green-50 px-5 py-4 text-center text-green-700"><div className="text-2xl font-bold">{result.data.queued}</div><div className="text-xs">已入队</div></div>
              <div className="rounded-lg bg-amber-50 px-5 py-4 text-center text-amber-700"><div className="text-2xl font-bold">{result.data.skipped}</div><div className="text-xs">跳过</div></div>
              <div className="rounded-lg bg-gray-50 px-5 py-4 text-center text-gray-700"><div className="text-2xl font-bold">{result.data.totalLeads}</div><div className="text-xs">总数</div></div>
            </div>
          )}
          <div className="mt-6 flex gap-3">
            <button onClick={() => { setStep('select'); setResult(null); }} className="rounded-lg border px-4 py-2 text-sm hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800">继续发送</button>
            <Link href="/emails" className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700">查看邮件记录</Link>
          </div>
        </section>
      )}
    </div>
  );
}
