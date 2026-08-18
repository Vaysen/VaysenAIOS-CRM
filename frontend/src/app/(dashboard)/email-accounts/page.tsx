'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import Link from 'next/link';
import api from '@/lib/api';
import { useAuthStore } from '@/store/authStore';
import { useT } from '@/i18n/use-translation';
import { ArrowLeft, Plus, Trash2, Pencil, Play, Send, Power, PowerOff, Mail } from 'lucide-react';
import { createClientUuid } from '@/lib/client-id';

interface EmailAccount {
  id: string; senderName: string; senderEmail: string; smtpHost: string; smtpPort: number;
  smtpSecure: boolean; smtpUsername: string; dailySendLimit: number; hourlySendLimit: number;
  sendIntervalSeconds: number; warmupEnabled: boolean; status: string;
  lastTestedAt?: string; failureCount: number; spfConfigured: boolean; dkimConfigured: boolean;
  dmarcConfigured: boolean; createdAt: string; userId?: string; replyToEmail?: string;
  accountRole?: string; tags?: string[];
}
interface VerifiedLeadOption {
  id: string;
  companyName?: string | null;
  contactEmail: string;
  emailVerificationStatus: string;
}

const STATUS_COLORS: Record<string, string> = {
  active: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  inactive: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  testing: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400',
  failed: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  suspended: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
};

const ROLE_META: Record<string, { label: string; cls: string }> = {
  MARKETING: { label: '营销邮箱', cls: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400' },
  CORE: { label: '核心邮箱', cls: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400' },
  SUPPORT: { label: '客服邮箱', cls: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400' },
};

export default function EmailAccountsPage() {
  const { t } = useT();
  const { user: currentUser } = useAuthStore();
  const [accounts, setAccounts] = useState<EmailAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resultMsg, setResultMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [testEmail, setTestEmail] = useState('');
  const [testLeadId, setTestLeadId] = useState('');
  const [verifiedLeads, setVerifiedLeads] = useState<VerifiedLeadOption[]>([]);
  const testActionRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const [showTestModal, setShowTestModal] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [users, setUsers] = useState<any[]>([]);
  const [assigningId, setAssigningId] = useState<string | null>(null);
  const [brevoStatus, setBrevoStatus] = useState<{ enabled: boolean; inboundDomain?: string | null } | null>(null);

  const currentCompany = currentUser?.companies?.[0];
  const canWrite = currentUser?.companies?.some((c: any) => ['super_admin', 'company_admin', 'sales_manager'].includes(c.role)) || false;

  const fetchAccounts = useCallback(async () => {
    try {
      setLoading(true); setError(null);
      const params: any = { page, limit: 20 };
      if (statusFilter) params.status = statusFilter;
      if (roleFilter) params.accountRole = roleFilter;
      const res = await api.get('/email-accounts', { params });
      setAccounts(res.data.data || []);
      setTotalPages(res.data.meta?.totalPages || 1);
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to load email accounts');
    } finally { setLoading(false); }
  }, [page, statusFilter, roleFilter]);

  useEffect(() => { fetchAccounts(); }, [fetchAccounts]);
  useEffect(() => { api.get('/users', { params: { limit: 100 } }).then(r => setUsers(r.data?.data || [])).catch((error) => { console.error('[Frontend] background operation failed:', error); }); }, []);
  useEffect(() => {
    api.get('/integrations/brevo/status')
      .then((response) => setBrevoStatus(response.data))
      .catch(() => setBrevoStatus({ enabled: false }));
  }, []);
  useEffect(() => {
    api.get('/leads', { params: { page: 1, limit: 100 } })
      .then((response) => {
        const rows = Array.isArray(response.data?.data) ? response.data.data : [];
        setVerifiedLeads(rows.filter((lead: VerifiedLeadOption) => (
          !!lead.contactEmail
          && ['smtp_verified', 'official_page_verified', 'verified_public_source']
            .includes(lead.emailVerificationStatus)
        )));
      })
      .catch(() => setVerifiedLeads([]));
  }, []);

  const handleAssignUser = async (accountId: string, userId: string) => {
    try {
      await api.patch(`/email-accounts/${accountId}`, { userId: userId || null });
      setResultMsg({ type: 'success', text: '已更新邮箱归属' });
      fetchAccounts();
    } catch (err: any) {
      setResultMsg({ type: 'error', text: err.response?.data?.message || '分配失败' });
    } finally { setAssigningId(null); }
  };

  const handleDelete = async (id: string, email: string) => {
    if (!confirm(t('emailAccounts.confirmDeactivate', { email }))) return;
    try {
      setActionLoading(id);
      await api.delete(`/email-accounts/${id}`);
      setResultMsg({ type: 'success', text: t('emailAccounts.deactivated') });
      fetchAccounts();
    } catch (err: any) {
      setResultMsg({ type: 'error', text: err.response?.data?.message || 'Failed to deactivate' });
    } finally { setActionLoading(null); }
  };

  const handleToggleStatus = async (account: EmailAccount) => {
    const newStatus = account.status === 'active' ? 'inactive' : 'active';
    try {
      setActionLoading(account.id);
      await api.patch(`/email-accounts/${account.id}/status`, { status: newStatus });
      setResultMsg({ type: 'success', text: newStatus === 'active' ? t('emailAccounts.activated') : t('emailAccounts.deactivated') });
      fetchAccounts();
    } catch (err: any) {
      setResultMsg({ type: 'error', text: err.response?.data?.message || 'Failed to update status' });
    } finally { setActionLoading(null); }
  };

  const handleTestConnection = async (id: string) => {
    try {
      setActionLoading(id); setResultMsg(null);
      const res = await api.post(`/email-accounts/${id}/test-connection`);
      setResultMsg({ type: res.data.success ? 'success' : 'error', text: res.data.message });
    } catch (err: any) {
      setResultMsg({ type: 'error', text: err.response?.data?.message || 'Test failed' });
    } finally { setActionLoading(null); }
  };

  const handleSendTest = async (id: string) => {
    if (!testEmail || !testLeadId) return;
    try {
      setActionLoading(id); setResultMsg(null);
      const fingerprint = `${id}:${testLeadId}:${testEmail.toLowerCase()}`;
      if (testActionRef.current?.fingerprint !== fingerprint) {
        testActionRef.current = { fingerprint, key: `smtp-test-ui:${createClientUuid()}` };
      }
      const res = await api.post(`/email-accounts/${id}/send-test`, {
        recipientEmail: testEmail,
        leadId: testLeadId,
      }, {
        headers: { 'Idempotency-Key': testActionRef.current.key },
      });
      setResultMsg({ type: res.data.success ? 'success' : 'error', text: res.data.message });
      testActionRef.current = null;
      setShowTestModal(null); setTestEmail(''); setTestLeadId('');
    } catch (err: any) {
      setResultMsg({ type: 'error', text: err.response?.data?.message || 'Send failed' });
    } finally { setActionLoading(null); }
  };

  const formatDate = (d?: string) => {
    if (!d) return t('common.never');
    return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  const getStatusLabel = (s: string) => t(`emailAccounts.status.${s}`) || s;

  return (
    <div className="space-y-6">
      <Link href="/emails" className="inline-flex items-center gap-2 text-sm font-medium text-blue-600 hover:text-blue-700">
        <ArrowLeft className="h-4 w-4" />
        返回邮件工作台
      </Link>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">{t('emailAccounts.title')}</h2>
          <p className="text-gray-500 dark:text-gray-400">{t('emailAccounts.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/imap-inbound"
            className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors">
            <Mail className="h-4 w-4" />
            IMAP 收件配置
          </Link>
          {canWrite && (
            <Link href="/email-accounts/new"
              className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors">
              <Plus className="h-4 w-4" />
              {t('emailAccounts.addAccount')}
            </Link>
          )}
        </div>
      </div>

      {resultMsg && (
        <div className={`rounded-lg p-3 text-sm flex items-center gap-2 ${resultMsg.type === 'success'
          ? 'bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 text-green-600 dark:text-green-400'
          : 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400'}`}>
          {resultMsg.text}
          <button onClick={() => setResultMsg(null)} className="ml-auto text-gray-400 hover:text-gray-600">&times;</button>
        </div>
      )}

      {error && (
        <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-3 text-sm text-red-600 dark:text-red-400">{error}</div>
      )}

      {brevoStatus && (
        <div className={`rounded-lg border p-3 text-sm ${brevoStatus.enabled
          ? 'border-green-200 bg-green-50 text-green-800'
          : 'border-amber-200 bg-amber-50 text-amber-800'}`}>
          <div className="font-medium">
            Brevo 收信：{brevoStatus.enabled ? '服务端已启用' : '等待服务端激活'}
          </div>
          <div className="mt-1 text-xs">
            {brevoStatus.enabled
              ? `收信域名：${brevoStatus.inboundDomain || '尚未填写'}`
              : '需要配置收信域名、DNS MX、HTTPS webhook 和安全令牌后，客户回复才会进入 CRM。'}
          </div>
        </div>
      )}

      <div className="flex items-center gap-3">
        <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none">
          <option value="">{t('emailAccounts.filters.allStatuses')}</option>
          {['active', 'inactive', 'testing', 'failed', 'suspended'].map((s) => (
            <option key={s} value={s}>{getStatusLabel(s)}</option>
          ))}
        </select>
        <select value={roleFilter} onChange={(e) => { setRoleFilter(e.target.value); setPage(1); }}
          className="rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none">
          <option value="">全部角色</option>
          <option value="MARKETING">营销邮箱</option>
          <option value="CORE">核心邮箱</option>
          <option value="SUPPORT">客服邮箱</option>
        </select>
      </div>

      <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50">
                <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">{t('emailAccounts.table.sender')}</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">角色</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">归属业务员</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">{t('emailAccounts.table.smtpServer')}</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">{t('emailAccounts.table.status')}</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">{t('emailAccounts.table.dailyLimit')}</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">{t('emailAccounts.table.lastTested')}</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">{t('emailAccounts.table.dns')}</th>
                <th className="text-right px-4 py-3 font-medium text-gray-500 dark:text-gray-400">{t('emailAccounts.table.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={9} className="px-4 py-8 text-center text-gray-400">{t('common.loading')}</td></tr>
              ) : accounts.length === 0 ? (
                <tr><td colSpan={9} className="px-4 py-8 text-center text-gray-400">{t('emailAccounts.noAccounts')}</td></tr>
              ) : (
                accounts.map((a) => (
                  <tr key={a.id} className="border-b border-gray-100 dark:border-gray-800 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-900/30">
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900 dark:text-white">{a.senderName}</div>
                      <div className="text-xs text-gray-400">{a.senderEmail}</div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-1">
                        <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${ROLE_META[a.accountRole || 'CORE']?.cls || ROLE_META.CORE.cls}`}>
                          {ROLE_META[a.accountRole || 'CORE']?.label || '核心邮箱'}
                        </span>
                        {(a.tags || []).map((tag) => (
                          <span key={tag} className="inline-flex rounded-full bg-gray-100 px-2 py-0.5 text-xs text-gray-500 dark:bg-gray-800 dark:text-gray-400">{tag}</span>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {canWrite ? (
                        <select
                          value={a.userId || ''}
                          onChange={(e) => handleAssignUser(a.id, e.target.value)}
                          className="rounded border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-2 py-1 text-xs text-gray-900 dark:text-white"
                        >
                          <option value="">未分配</option>
                          {users.map((u: any) => (
                            <option key={u.id} value={u.id}>{u.firstName} {u.lastName}</option>
                          ))}
                        </select>
                      ) : (
                        <span className="text-xs text-gray-400">
                          {a.userId ? users.find((u: any) => u.id === a.userId)?.firstName || '已分配' : '未分配'}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-300 font-mono text-xs">
                      <div>{a.smtpHost}:{a.smtpPort} ({a.smtpSecure ? t('emailAccounts.ssl') : t('emailAccounts.noSsl')})</div>
                      {a.smtpHost.toLowerCase() === 'smtp-relay.brevo.com' && (
                        <div className={`mt-1 font-sans ${a.replyToEmail ? 'text-green-600' : 'text-amber-600'}`}>
                          {a.replyToEmail ? `收件：${a.replyToEmail}` : '收件地址未配置'}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_COLORS[a.status] || ''}`}>
                        {getStatusLabel(a.status)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-300 text-xs">{a.dailySendLimit}{t('emailAccounts.day')}</td>
                    <td className="px-4 py-3 text-gray-500 dark:text-gray-400 text-xs">{formatDate(a.lastTestedAt)}</td>
                    <td className="px-4 py-3">
                      <div className="flex gap-1">
                        <span className={`text-xs px-1.5 py-0.5 rounded ${a.spfConfigured ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-gray-100 text-gray-400 dark:bg-gray-800'}`}>SPF</span>
                        <span className={`text-xs px-1.5 py-0.5 rounded ${a.dkimConfigured ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-gray-100 text-gray-400 dark:bg-gray-800'}`}>DKIM</span>
                        <span className={`text-xs px-1.5 py-0.5 rounded ${a.dmarcConfigured ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' : 'bg-gray-100 text-gray-400 dark:bg-gray-800'}`}>DMARC</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        {canWrite && (
                          <>
                            <button onClick={() => handleTestConnection(a.id)} disabled={actionLoading === a.id}
                              className="rounded p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 disabled:opacity-30 transition-colors"
                              title={t('emailAccounts.testConnection')}>
                              <Play className="h-4 w-4" />
                            </button>
                            <button onClick={() => { setShowTestModal(a.id); setTestEmail(''); }} disabled={actionLoading === a.id}
                              className="rounded p-1.5 text-gray-400 hover:text-purple-600 hover:bg-purple-50 dark:hover:bg-purple-900/20 disabled:opacity-30 transition-colors"
                              title={t('emailAccounts.sendTestEmail')}>
                              <Send className="h-4 w-4" />
                            </button>
                            <Link href={`/email-accounts/${a.id}/edit`}
                              className="rounded p-1.5 text-gray-400 hover:text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20 transition-colors"
                              title={t('emailAccounts.edit')}>
                              <Pencil className="h-4 w-4" />
                            </Link>
                            <button onClick={() => handleToggleStatus(a)} disabled={actionLoading === a.id}
                              className="rounded p-1.5 text-gray-400 hover:text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-900/20 disabled:opacity-30 transition-colors"
                              title={a.status === 'active' ? t('emailAccounts.deactivate') : t('emailAccounts.activate')}>
                              {a.status === 'active' ? <PowerOff className="h-4 w-4" /> : <Power className="h-4 w-4" />}
                            </button>
                            <button onClick={() => handleDelete(a.id, a.senderEmail)} disabled={actionLoading === a.id}
                              className="rounded p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-30 transition-colors"
                              title={t('emailAccounts.delete')}>
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
            <span className="text-sm text-gray-500">{t('common.page', { page: String(page) })} {t('common.pagination.info', { page: String(page), totalPages: String(totalPages), total: '?' })}</span>
            <div className="flex gap-1">
              <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}
                className="rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-1 text-sm disabled:opacity-50 hover:bg-gray-50 dark:hover:bg-gray-800">{t('common.pagination.prev')}</button>
              <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages}
                className="rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-1 text-sm disabled:opacity-50 hover:bg-gray-50 dark:hover:bg-gray-800">{t('common.pagination.next')}</button>
            </div>
          </div>
        )}
      </div>

      {showTestModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white dark:bg-gray-950 rounded-xl border border-gray-200 dark:border-gray-800 p-6 w-full max-w-md shadow-xl">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">{t('emailAccounts.testModalTitle')}</h3>
            <label className="block text-sm text-gray-500 mb-1">Verified customer</label>
            <select value={testLeadId} onChange={(event) => {
              const lead = verifiedLeads.find((item) => item.id === event.target.value);
              setTestLeadId(event.target.value);
              setTestEmail(lead?.contactEmail || '');
              testActionRef.current = null;
            }}
              className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none mb-4">
              <option value="">Select a verified lead</option>
              {verifiedLeads.map((lead) => (
                <option key={lead.id} value={lead.id}>
                  {lead.companyName || lead.contactEmail} — {lead.contactEmail}
                </option>
              ))}
            </select>
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowTestModal(null)}
                className="rounded-lg border border-gray-300 dark:border-gray-700 px-4 py-2 text-sm text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800">
                {t('common.cancel')}
              </button>
              <button onClick={() => handleSendTest(showTestModal)} disabled={!testEmail || !testLeadId || actionLoading === showTestModal}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
                {actionLoading === showTestModal ? t('common.loading') : t('emailAccounts.sendTest')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
