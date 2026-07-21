'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import api from '@/lib/api';
import { ArrowLeft, Save, Play } from 'lucide-react';

export default function NewEmailAccountPage() {
  const router = useRouter();
  const [provider, setProvider] = useState<'brevo' | 'custom'>('brevo');
  const [form, setForm] = useState({
    senderName: '',
    senderEmail: '',
    smtpHost: 'smtp-relay.brevo.com',
    smtpPort: 587,
    smtpSecure: false,
    smtpUsername: '',
    smtpPassword: '',
    replyToEmail: '',
    dailySendLimit: 50,
    hourlySendLimit: 10,
    sendIntervalSeconds: 60,
    warmupEnabled: false,
    userId: '',
  });
  const [companyUsers, setCompanyUsers] = useState<Array<{ userId: string; user: { email: string; firstName: string; lastName: string }; role: { displayName: string } }>>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const handleChange = (field: string, value: any) => {
    setForm((prev) => ({ ...prev, [field]: value }));
  };

  const handleProviderChange = (value: 'brevo' | 'custom') => {
    setProvider(value);
    if (value === 'brevo') {
      setForm((prev) => ({
        ...prev,
        smtpHost: 'smtp-relay.brevo.com',
        smtpPort: 587,
        smtpSecure: false,
      }));
    }
  };

  useEffect(() => {
    const loadUsers = async () => {
      try {
        const me = await api.get('/auth/me');
        const companyId = me.data?.companies?.[0]?.id;
        if (!companyId) return;
        const res = await api.get(`/companies/${companyId}/users`);
        setCompanyUsers(res.data.data || []);
      } catch {
        setCompanyUsers([]);
      }
    };
    loadUsers();
  }, []);

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
      const res = await api.post('/email-accounts', form);
      router.push('/email-accounts');
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to create email account');
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    if (!validateReceivingConfig()) return;
    try {
      setSaving(true);
      setError(null);
      setTestResult(null);
      // Save first, then test
      const res = await api.post('/email-accounts', form);
      const id = res.data.id;
      const testRes = await api.post(`/email-accounts/${id}/test-connection`);
      setTestResult({
        type: testRes.data.success ? 'success' : 'error',
        text: testRes.data.message,
      });
      // If test failed, still keep the account but show result
    } catch (err: any) {
      if (err.response?.status === 400) {
        setError(err.response?.data?.message || 'Please fill in all required fields');
      } else {
        setError(err.response?.data?.message || 'Failed to create or test');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-center gap-4">
        <Link href="/email-accounts" className="text-gray-400 hover:text-gray-600">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <h2 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">New Email Account</h2>
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

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">分配给业务员</label>
          <select
            value={form.userId}
            onChange={(e) => handleChange('userId', e.target.value)}
            className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
          >
            <option value="">公司共享邮箱（主账号/经理可见，业务员也可使用）</option>
            {companyUsers.map((item) => (
              <option key={item.userId} value={item.userId}>
                {item.user.firstName} {item.user.lastName} - {item.user.email} ({item.role.displayName})
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-gray-500">子账号不能新增邮箱，只能使用主账号分配或共享的发件邮箱。</p>
        </div>

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

        <h3 className="text-lg font-semibold text-gray-900 dark:text-white pt-2">SMTP Configuration</h3>

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">邮件服务商</label>
          <select
            value={provider}
            onChange={(e) => handleProviderChange(e.target.value as 'brevo' | 'custom')}
            className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
          >
            <option value="brevo">Brevo 免费版（推荐，每天 300 封）</option>
            <option value="custom">其他 SMTP 服务</option>
          </select>
          {provider === 'brevo' && (
            <p className="mt-1 text-xs text-blue-600">
              SMTP 用户名填写 Brevo 登录邮箱，密码填写 Brevo 生成的 SMTP Key，不是网页登录密码。
            </p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">SMTP Host *</label>
            <input type="text" value={form.smtpHost} onChange={(e) => handleChange('smtpHost', e.target.value)} placeholder="smtp.gmail.com"
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
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">SMTP Password *</label>
          <input type="password" value={form.smtpPassword} onChange={(e) => handleChange('smtpPassword', e.target.value)}
            className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" />
        </div>

        <h3 className="text-lg font-semibold text-gray-900 dark:text-white pt-2">Receiving Configuration</h3>

        <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800">
          <p className="font-medium">Brevo 收信通过 Inbound Parsing 自动回写 CRM，不使用 IMAP。</p>
          <p className="mt-1 text-xs text-blue-700">
            请填写回复地址，例如 sales@reply.example.com。发给客户的邮件会使用该地址作为 Reply-To，客户回复后自动进入“邮件中心 → 收件箱”并关联客户。
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Reply-To / CRM 收件地址 *</label>
          <input
            type="email"
            value={form.replyToEmail}
            onChange={(e) => handleChange('replyToEmail', e.target.value)}
            placeholder="sales@reply.example.com"
            className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
          />
        </div>

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
            {saving ? 'Saving...' : 'Save Account'}
          </button>
          <button onClick={handleTest} disabled={saving}
            className="inline-flex items-center gap-2 rounded-lg border border-gray-300 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 disabled:opacity-50">
            <Play className="h-4 w-4" />
            Save & Test Connection
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
