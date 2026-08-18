'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import api from '@/lib/api';
import { useRuntimeRouteParam } from '@/lib/use-runtime-route-param';
import { ArrowLeft, Save, Play } from 'lucide-react';

export default function EditEmailAccountPage() {
  const id = useRuntimeRouteParam('id');
  const router = useRouter();
  const [form, setForm] = useState({
    senderName: '',
    senderEmail: '',
    smtpHost: '',
    smtpPort: 587,
    smtpSecure: true,
    smtpUsername: '',
    smtpPassword: '',
    replyToEmail: '',
    dailySendLimit: 50,
    hourlySendLimit: 10,
    sendIntervalSeconds: 60,
    warmupEnabled: false,
    accountRole: 'CORE',
    tags: [] as string[],
    imapHost: '',
    imapPort: 993,
    imapSecure: true,
    imapUsername: '',
    imapPassword: '',
    inboundEnabled: false,
    inboundPollIntervalSeconds: 300,
  });
  const [tagInput, setTagInput] = useState('');
  const [showImap, setShowImap] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    if (!id) return;
    const fetchAccount = async () => {
      try {
        setLoading(true);
        const res = await api.get(`/email-accounts/${id}`);
        const d = res.data;
        setForm({
          senderName: d.senderName || '',
          senderEmail: d.senderEmail || '',
          smtpHost: d.smtpHost || '',
          smtpPort: d.smtpPort || 587,
          smtpSecure: d.smtpSecure ?? true,
          smtpUsername: d.smtpUsername || '',
          smtpPassword: '',
          replyToEmail: d.replyToEmail || '',
          dailySendLimit: d.dailySendLimit || 50,
          hourlySendLimit: d.hourlySendLimit || 10,
          sendIntervalSeconds: d.sendIntervalSeconds || 60,
          warmupEnabled: d.warmupEnabled ?? false,
          accountRole: d.accountRole || 'CORE',
          tags: d.tags || [],
          imapHost: d.imapHost || '',
          imapPort: d.imapPort || 993,
          imapSecure: d.imapSecure ?? true,
          imapUsername: d.imapUsername || '',
          imapPassword: '',
          inboundEnabled: d.inboundEnabled ?? false,
          inboundPollIntervalSeconds: d.inboundPollIntervalSeconds || 300,
        });
      } catch (err: any) {
        setError(err.response?.data?.message || 'Failed to load account');
      } finally {
        setLoading(false);
      }
    };
    fetchAccount();
  }, [id]);

  const handleChange = (field: string, value: any) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const addTag = () => {
    const tag = tagInput.trim();
    if (!tag || form.tags.includes(tag)) return;
    setForm((prev) => ({ ...prev, tags: [...prev.tags, tag] }));
    setTagInput('');
  };

  const validateReceivingConfig = () => {
    if (
      form.smtpHost.trim().toLowerCase() === 'smtp-relay.brevo.com' &&
      !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.replyToEmail.trim())
    ) {
      setError('Brevo 账号必须填写有效的 Reply-To / CRM 收件地址。');
      return false;
    }
    return true;
  };

  const handleSave = async () => {
    if (!validateReceivingConfig()) return;
    try {
      setSaving(true);
      setError(null);
      const payload: any = { ...form };
      if (!payload.smtpPassword) delete payload.smtpPassword;
      if (!payload.imapPassword) delete payload.imapPassword;
      await api.patch(`/email-accounts/${id}`, payload);
      router.push('/email-accounts');
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to update email account');
    } finally {
      setSaving(false);
    }
  };

  const handleTestConnection = async () => {
    try {
      setSaving(true);
      setTestResult(null);
      const res = await api.post(`/email-accounts/${id}/test-connection`);
      setTestResult({
        type: res.data.success ? 'success' : 'error',
        text: res.data.message,
      });
    } catch (err: any) {
      setTestResult({ type: 'error', text: err.response?.data?.message || 'Test failed' });
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Link href="/email-accounts" className="text-gray-400 hover:text-gray-600"><ArrowLeft className="h-5 w-5" /></Link>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white">Edit Email Account</h2>
        </div>
        <p className="text-gray-400">Loading...</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-center gap-4">
        <Link href="/email-accounts" className="text-gray-400 hover:text-gray-600">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <h2 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">Edit Email Account</h2>
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-3 text-sm text-red-600 dark:text-red-400">{error}</div>
      )}

      {testResult && (
        <div className={`rounded-lg p-3 text-sm flex items-center gap-2 ${
          testResult.type === 'success'
            ? 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 text-green-600 dark:text-green-400'
            : 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400'
        }`}>
          {testResult.text}
          <button onClick={() => setTestResult(null)} className="ml-auto text-gray-400">&times;</button>
        </div>
      )}

      <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 p-6 space-y-4">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">Sender Information</h3>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Sender Name *</label>
            <input type="text" value={form.senderName} onChange={(e) => handleChange('senderName', e.target.value)}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Sender Email *</label>
            <input type="email" value={form.senderEmail} onChange={(e) => handleChange('senderEmail', e.target.value)}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" />
          </div>
        </div>

        <h3 className="text-lg font-semibold text-gray-900 dark:text-white pt-2">Account Role</h3>

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">账户角色</label>
          <select
            value={form.accountRole}
            onChange={(e) => handleChange('accountRole', e.target.value)}
            className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
          >
            <option value="CORE">核心邮箱（一对一商务邮件，不可用于营销群发）</option>
            <option value="MARKETING">营销邮箱（营销活动/批量群发专用）</option>
            <option value="SUPPORT">客服邮箱（客户服务往来）</option>
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">标签（可选，回车添加）</label>
          <div className="flex gap-2">
            <input type="text" value={tagInput} onChange={(e) => setTagInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }}
              placeholder="如：主域名 / 备用域1"
              className="flex-1 rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" />
            <button onClick={addTag} className="rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800">添加</button>
          </div>
          {form.tags.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {form.tags.map((tag) => (
                <span key={tag} className="inline-flex items-center gap-1 rounded-full bg-gray-100 dark:bg-gray-800 px-2 py-0.5 text-xs text-gray-600 dark:text-gray-300">
                  {tag}
                  <button onClick={() => handleChange('tags', form.tags.filter((x) => x !== tag))} className="text-gray-400 hover:text-red-500">&times;</button>
                </span>
              ))}
            </div>
          )}
        </div>

        <h3 className="text-lg font-semibold text-gray-900 dark:text-white pt-2">SMTP Configuration</h3>

        {form.smtpHost === 'smtp-relay.brevo.com' && (
          <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">
            <p className="font-medium">当前使用 Brevo 免费版（每天最多 300 封）。</p>
            <p className="mt-1 text-xs text-blue-700">端口 587 使用 STARTTLS，因此下方 SSL/TLS 开关保持关闭。</p>
          </div>
        )}

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">SMTP Host *</label>
            <input type="text" value={form.smtpHost} onChange={(e) => handleChange('smtpHost', e.target.value)}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">SMTP Port *</label>
            <input type="number" value={form.smtpPort} onChange={(e) => handleChange('smtpPort', parseInt(e.target.value) || 587)}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" />
          </div>
        </div>

        <div className="flex items-center gap-2">
          <input type="checkbox" id="smtpSecure" checked={form.smtpSecure} onChange={(e) => handleChange('smtpSecure', e.target.checked)}
            className="rounded border-gray-300 dark:border-gray-700" />
          <label htmlFor="smtpSecure" className="text-sm text-gray-700 dark:text-gray-300">Use SSL/TLS</label>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">SMTP Username *</label>
          <input type="text" value={form.smtpUsername} onChange={(e) => handleChange('smtpUsername', e.target.value)}
            className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" />
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">SMTP Password (leave empty to keep current)</label>
          <input type="password" value={form.smtpPassword} onChange={(e) => handleChange('smtpPassword', e.target.value)} placeholder="••••••••"
            className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" />
        </div>

        <h3 className="text-lg font-semibold text-gray-900 dark:text-white pt-2">Receiving Configuration</h3>

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Reply-To / CRM 收件地址 *</label>
          <input
            type="email"
            value={form.replyToEmail}
            onChange={(e) => handleChange('replyToEmail', e.target.value)}
            placeholder="sales@reply.vaysen.com"
            className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
          />
          <p className="mt-1 text-xs text-gray-500">Brevo 会将发到这个地址的客户回复解析后自动写入 CRM 收件箱。</p>
        </div>

        <div className="flex items-center justify-between pt-2">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">IMAP Receiving（可选）</h3>
          <button onClick={() => setShowImap(!showImap)} className="text-sm text-blue-600 hover:text-blue-700">
            {showImap ? '收起' : '展开'}
          </button>
        </div>

        {showImap && (
          <div className="space-y-4 rounded-lg border border-gray-200 dark:border-gray-800 p-4">
            <p className="text-xs text-gray-500">启用 IMAP 后，系统按轮询间隔从该邮箱拉取客户回复并写入「邮件中心 → 收件箱」。国内邮箱建议用 imap 端口 993（SSL）。</p>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">IMAP Host</label>
                <input type="text" value={form.imapHost} onChange={(e) => handleChange('imapHost', e.target.value)} placeholder="imap.qiye.aliyun.com"
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">IMAP Port</label>
                <input type="number" value={form.imapPort} onChange={(e) => handleChange('imapPort', parseInt(e.target.value) || 993)}
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <input type="checkbox" id="imapSecure" checked={form.imapSecure} onChange={(e) => handleChange('imapSecure', e.target.checked)}
                className="rounded border-gray-300 dark:border-gray-700" />
              <label htmlFor="imapSecure" className="text-sm text-gray-700 dark:text-gray-300">Use SSL/TLS</label>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">IMAP Username</label>
              <input type="text" value={form.imapUsername} onChange={(e) => handleChange('imapUsername', e.target.value)} placeholder="通常与 SMTP 用户名相同"
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">IMAP Password（留空保持当前）</label>
              <input type="password" value={form.imapPassword} onChange={(e) => handleChange('imapPassword', e.target.value)}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">轮询间隔（秒）</label>
                <input type="number" value={form.inboundPollIntervalSeconds} onChange={(e) => handleChange('inboundPollIntervalSeconds', parseInt(e.target.value) || 300)}
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <input type="checkbox" id="inboundEnabled" checked={form.inboundEnabled} onChange={(e) => handleChange('inboundEnabled', e.target.checked)}
                className="rounded border-gray-300 dark:border-gray-700" />
              <label htmlFor="inboundEnabled" className="text-sm text-gray-700 dark:text-gray-300">启用 IMAP 自动收信</label>
            </div>
          </div>
        )}

        <h3 className="text-lg font-semibold text-gray-900 dark:text-white pt-2">Sending Limits</h3>

        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Daily Limit</label>
            <input type="number" value={form.dailySendLimit} onChange={(e) => handleChange('dailySendLimit', parseInt(e.target.value) || 50)}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Hourly Limit</label>
            <input type="number" value={form.hourlySendLimit} onChange={(e) => handleChange('hourlySendLimit', parseInt(e.target.value) || 10)}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Interval (seconds)</label>
            <input type="number" value={form.sendIntervalSeconds} onChange={(e) => handleChange('sendIntervalSeconds', parseInt(e.target.value) || 60)}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" />
          </div>
        </div>

        <div className="flex items-center gap-2">
          <input type="checkbox" id="warmup" checked={form.warmupEnabled} onChange={(e) => handleChange('warmupEnabled', e.target.checked)}
            className="rounded border-gray-300 dark:border-gray-700" />
          <label htmlFor="warmup" className="text-sm text-gray-700 dark:text-gray-300">Enable warmup mode</label>
        </div>

        <div className="flex gap-3 pt-4">
          <button onClick={handleSave} disabled={saving}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
            <Save className="h-4 w-4" />
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
          <button onClick={handleTestConnection} disabled={saving}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-300 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50">
            <Play className="h-4 w-4" />
            Test Connection
          </button>
          <Link href="/email-accounts"
            className="inline-flex items-center gap-2 rounded-lg border border-gray-300 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800">
            Cancel
          </Link>
        </div>
      </div>
    </div>
  );
}
