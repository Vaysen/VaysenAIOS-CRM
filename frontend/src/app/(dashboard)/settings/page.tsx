'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import api from '@/lib/api';
import { useAuthStore } from '@/store/authStore';
import { useI18n } from '@/i18n/i18n-context';
import {
  Building2, Globe, Lock, Plus, Save, Trash2, UserCog, X,
  Upload, Camera, Edit3, Check, Package, Shield, Award, Phone, Mail, MapPin, Bot,
} from 'lucide-react';
import { useAssistantRuntime } from '@/hooks/use-assistant-runtime';
import { WechatOwnerChannelCard } from '@/components/assistant/wechat-owner-channel-card';
import { LanConnectionSettings } from '@/components/runtime/lan-connection-settings';

interface CompanyData {
  id: string;
  name: string;
  slug: string;
  logo?: string;
  website?: string;
  industry?: string;
  size?: string;
  country?: string;
  city?: string;
  address?: string;
  phone?: string;
  description?: string;
  settings?: Record<string, any>;
  createdAt: string;
}

interface CompanyUser {
  id: string;
  userId: string;
  user: { email: string; firstName: string; lastName: string };
  role: { id: string; name: string; displayName: string };
}

/* ── 公司资料可编辑字段 ── */
const COMPANY_FIELDS = [
  { key: 'brandName',       label: '品牌名称',       icon: Building2, group: '基本' },
  { key: 'website',         label: '官网',           icon: Globe,       group: '基本' },
  { key: 'founded',         label: '成立年份',       icon: Award,       group: '基本' },
  { key: 'location',        label: '所在地',         icon: MapPin,      group: '基本' },
  { key: 'address',         label: '详细地址',       icon: MapPin,      group: '基本' },
  { key: 'phone',           label: '电话',           icon: Phone,       group: '基本' },
  { key: 'whatsapp',        label: 'WhatsApp',       icon: Phone,       group: '基本' },
  { key: 'emailSales',      label: '销售邮箱',       icon: Mail,        group: '基本' },
  { key: 'positioning',     label: '公司定位',       icon: Building2,   group: '介绍' },
  { key: 'tagline',         label: '宣传语',         icon: Edit3,       group: '介绍' },
  { key: 'description',     label: '公司简介',       icon: Edit3,       group: '介绍' },
  { key: 'annualCapacity',  label: '年产能',         icon: Package,     group: '生产' },
  { key: 'teamSize',        label: '团队规模',       icon: UserCog,     group: '生产' },
  { key: 'moqTrial',        label: '试单MOQ',        icon: Package,     group: '生产' },
  { key: 'moqStandard',     label: '标准MOQ',        icon: Package,     group: '生产' },
  { key: 'sampleTime',      label: '打样周期',       icon: Package,     group: '生产' },
  { key: 'leadTime',        label: '交货周期',       icon: Package,     group: '生产' },
  { key: 'certifications',  label: '认证资质',       icon: Shield,      group: '资质' },
  { key: 'targetMarkets',   label: '目标市场',       icon: Globe,       group: '市场' },
  { key: 'customerTypes',   label: '目标客户类型',   icon: UserCog,     group: '市场' },
  { key: 'mainProducts',    label: '主营产品',       icon: Package,     group: '产品' },
  { key: 'priceRange',      label: '价格区间',       icon: Package,     group: '产品' },
] as const;

const FIELD_GROUPS = ['基本', '介绍', '生产', '资质', '市场', '产品'];

export default function SettingsPage() {
  const { locale, setLocale } = useI18n();
  const { user: currentUser, activeCompanyId } = useAuthStore();
  const currentCompany = currentUser?.companies?.find((item) => item.id === activeCompanyId)
    || currentUser?.companies?.find((item) => item.isDefault)
    || currentUser?.companies?.[0];
  const companyId = currentCompany?.id;
  const isAdmin = !!currentCompany
    && ['company_admin', 'sales_manager', 'super_admin'].includes(currentCompany.role);
  const assistantRuntime = useAssistantRuntime({
    companyId: companyId || '',
    enabled: !!currentUser && !!companyId,
  });

  const [company, setCompany] = useState<CompanyData | null>(null);
  const [companyUsers, setCompanyUsers] = useState<CompanyUser[]>([]);
  const [roles, setRoles] = useState<{ id: string; name: string; displayName: string }[]>([]);
  const [aiPreference, setAiPreference] = useState('');
  const [businessEmail, setBusinessEmail] = useState('');
  const [whatsapp, setWhatsapp] = useState('');
  const [addUserEmail, setAddUserEmail] = useState('');
  const [addUserRoleId, setAddUserRoleId] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(true);
  const [savingPreference, setSavingPreference] = useState(false);
  const [addingUser, setAddingUser] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  /* ── 公司资料编辑状态 ── */
  const [companyFields, setCompanyFields] = useState<Record<string, string>>({});
  const [editingCompany, setEditingCompany] = useState(false);
  const [savingCompany, setSavingCompany] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const logoInputRef = useRef<HTMLInputElement>(null);

  const fetchAll = useCallback(async () => {
    if (!companyId) return;
    setLoading(true);
    try {
      const [companyRes, usersRes, rolesRes, prefRes] = await Promise.all([
        api.get(`/companies/${companyId}`),
        api.get(`/companies/${companyId}/users`).catch(() => ({ data: { data: [] } })),
        api.get('/users/roles').catch(() => ({ data: { data: [] } })),
        api.get('/users/me/preferences').catch(() => ({ data: { aiPreference: '' } })),
      ]);
      const c = companyRes.data;
      setCompany(c);
      setCompanyUsers(usersRes.data?.data || []);
      setRoles(rolesRes.data?.data || []);
      setAiPreference(prefRes.data?.aiPreference || '');
      setBusinessEmail(prefRes.data?.businessEmail || '');
      setWhatsapp(prefRes.data?.whatsapp || '');
      /* 初始化公司字段 */
      const s = c?.settings || {};
      setCompanyFields({
        brandName: s.brandName || c?.name || '',
        website: s.website || c?.website || '',
        founded: s.founded || '',
        location: s.location || [c?.city, c?.country].filter(Boolean).join(', ') || '',
        address: s.address || c?.address || '',
        phone: s.phone || c?.phone || '',
        whatsapp: s.whatsapp || '',
        emailSales: s.emailSales || '',
        positioning: s.positioning || c?.description || '',
        tagline: s.tagline || '',
        description: s.description || '',
        annualCapacity: s.annualCapacity || '',
        teamSize: s.teamSize || '',
        moqTrial: s.moqTrial || '',
        moqStandard: s.moqStandard || '',
        sampleTime: s.sampleTime || '',
        leadTime: s.leadTime || '',
        certifications: s.certifications || '',
        targetMarkets: s.targetMarkets || '',
        customerTypes: s.customerTypes || '',
        mainProducts: s.mainProducts || c?.industry || '',
        priceRange: s.priceRange || '',
      });
    } catch (err: any) {
      setError(err.response?.data?.message || '加载系统设置失败');
    } finally {
      setLoading(false);
    }
  }, [companyId]);

  useEffect(() => { fetchAll().catch((error) => { console.error('[Frontend] background operation failed:', error); }); }, [fetchAll]);

  /* ── 保存公司资料 ── */
  const saveCompanyFields = async () => {
    if (!companyId) return;
    setSavingCompany(true);
    setError(null);
    setSuccess(null);
    try {
      await api.patch(`/companies/${companyId}`, {
        name: companyFields.brandName || company?.name,
        website: companyFields.website || company?.website,
        industry: companyFields.mainProducts || company?.industry,
        description: companyFields.positioning || company?.description,
        address: companyFields.address || company?.address,
        phone: companyFields.phone || company?.phone,
        settings: { ...(company?.settings || {}), ...companyFields },
      });
      setEditingCompany(false);
      await fetchAll();
      setSuccess('公司资料已保存。');
    } catch (err: any) {
      setError(err.response?.data?.message || '保存公司资料失败');
    } finally {
      setSavingCompany(false);
    }
  };

  /* ── 上传 Logo ── */
  const uploadLogo = async (file: File) => {
    if (!companyId) return;
    setUploadingLogo(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append('logo', file);
      const res = await api.post(`/companies/${companyId}/logo`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      await fetchAll();
      setSuccess('品牌 Logo 已上传。');
    } catch (err: any) {
      setError(err.response?.data?.message || '上传 Logo 失败');
    } finally {
      setUploadingLogo(false);
    }
  };

  const savePreference = async () => {
    setSavingPreference(true);
    setError(null);
    setSuccess(null);
    try {
      await api.patch('/users/me/preferences', { aiPreference, businessEmail, whatsapp });
      setSuccess('个人 AI 偏好和联系方式已保存，后续 AI 写作与外发邮件会使用这些设置。');
    } catch (err: any) {
      setError(err.response?.data?.message || '保存 AI 偏好失败');
    } finally {
      setSavingPreference(false);
    }
  };

  const addUser = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!companyId || !addUserEmail || !addUserRoleId) return;
    setAddingUser(true);
    setError(null);
    setSuccess(null);
    try {
      // Generate a random temporary password
      const tempPassword = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6).toUpperCase() + '!';
      await api.post('/users', {
        email: addUserEmail,
        password: tempPassword,
        firstName: addUserEmail.split('@')[0],
        lastName: '',
        companyId,
        roleId: addUserRoleId,
      });
      setAddUserEmail('');
      setAddUserRoleId('');
      await fetchAll();
      setSuccess(`账号已创建，临时密码：${tempPassword}`);
    } catch (err: any) {
      setError(err.response?.data?.message || '创建账号失败');
    } finally {
      setAddingUser(false);
    }
  };

  const removeUser = async (userId: string, name: string) => {
    if (!companyId || !confirm(`确认将 ${name} 从本公司移除吗？`)) return;
    setError(null);
    try {
      await api.delete(`/companies/${companyId}/users/${userId}`);
      await fetchAll();
      setSuccess('账号已移除');
    } catch (err: any) {
      setError(err.response?.data?.message || '移除账号失败');
    }
  };

  const changePassword = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setSuccess(null);
    if (newPassword !== confirmPassword) {
      setError('两次输入的新密码不一致');
      return;
    }
    setChangingPassword(true);
    try {
      await api.post('/users/change-password', { currentPassword, newPassword });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setSuccess('密码已修改');
    } catch (err: any) {
      setError(err.response?.data?.message || '修改密码失败');
    } finally {
      setChangingPassword(false);
    }
  };

  if (loading) return <div className="py-20 text-center text-gray-500">正在加载系统设置...</div>;

  const settings = company?.settings || {};

  return (
    <div className="space-y-6">
      <LanConnectionSettings inline />
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">系统设置</h2>
          <p className="text-gray-500 dark:text-gray-400">管理公司资料、团队账号、AI 偏好与安全设置。</p>
        </div>
        <span className="rounded-full bg-blue-100 px-3 py-1 text-xs font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
          {locale === 'zh-CN' ? '中文' : 'English'}
        </span>
      </div>

      {error && <Notice color="red" text={error} onClose={() => setError(null)} />}
      {success && <Notice color="green" text={success} onClose={() => setSuccess(null)} />}

      {/* ── 公司资料 ── */}
      <section className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-950">
        <div className="mb-5 flex items-center justify-between">
          <SectionTitle
            icon={<Building2 className="h-5 w-5 text-blue-600" />}
            title="公司资料"
            subtitle={`工作区：${company?.slug || currentCompany?.slug || '-'}`}
          />
          <div className="flex gap-2">
            {!editingCompany ? (
              <button onClick={() => setEditingCompany(true)} className="inline-flex items-center gap-2 rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300">
                <Edit3 className="h-4 w-4" /> 编辑
              </button>
            ) : (
              <>
                <button onClick={() => { setEditingCompany(false); fetchAll(); }} className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-400">取消</button>
                <button onClick={saveCompanyFields} disabled={savingCompany} className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
                  <Save className="h-4 w-4" />
                  {savingCompany ? '保存中...' : '保存'}
                </button>
              </>
            )}
          </div>
        </div>

        {/* Logo */}
        <div className="mb-6 flex items-center gap-4">
          <div className="relative">
            {company?.logo ? (
              <img src={company.logo} alt="Logo" className="h-16 w-16 rounded-xl object-cover" />
            ) : (
              <div className="flex h-16 w-16 items-center justify-center rounded-xl bg-blue-100 dark:bg-blue-900/30">
                <Building2 className="h-8 w-8 text-blue-600" />
              </div>
            )}
            <button
              onClick={() => logoInputRef.current?.click()}
              disabled={uploadingLogo}
              className="absolute -bottom-1 -right-1 flex h-6 w-6 items-center justify-center rounded-full bg-blue-600 text-white hover:bg-blue-700"
            >
              {uploadingLogo ? <span className="h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" /> : <Camera className="h-3 w-3" />}
            </button>
            <input ref={logoInputRef} type="file" accept="image/*" className="hidden" onChange={(e) => e.target.files?.[0] && uploadLogo(e.target.files[0])} />
          </div>
          <div>
            <div className="text-lg font-semibold text-gray-900 dark:text-white">{companyFields.brandName || company?.name || '-'}</div>
            <div className="text-sm text-gray-500">{companyFields.website || company?.website || '-'}</div>
          </div>
        </div>

        {/* 字段分组 */}
        {FIELD_GROUPS.map((group) => {
          const fields = COMPANY_FIELDS.filter((f) => f.group === group);
          return (
            <div key={group} className="mb-4">
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-gray-400">{group}</h4>
              <div className="grid gap-3 md:grid-cols-2">
                {fields.map((field) => {
                  const Icon = field.icon;
                  return (
                    <div key={field.key} className="rounded-lg bg-gray-50 p-3 dark:bg-gray-900">
                      <div className="mb-1 flex items-center gap-2 text-xs text-gray-500">
                        <Icon className="h-3 w-3" /> {field.label}
                      </div>
                      {editingCompany ? (
                        field.label === '公司简介' || field.label === '主营产品' || field.label === '目标市场' || field.label === '目标客户类型' || field.label === '认证资质' ? (
                          <textarea
                            rows={3}
                            value={companyFields[field.key] || ''}
                            onChange={(e) => setCompanyFields({ ...companyFields, [field.key]: e.target.value })}
                            className="w-full rounded border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                          />
                        ) : (
                          <input
                            value={companyFields[field.key] || ''}
                            onChange={(e) => setCompanyFields({ ...companyFields, [field.key]: e.target.value })}
                            className="w-full rounded border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                          />
                        )
                      ) : (
                        <div className="whitespace-pre-wrap text-sm text-gray-900 dark:text-white">{companyFields[field.key] || '-'}</div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </section>

      {/* ── AI Preference ── */}
      <section className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-950">
        <SectionTitle icon={<UserCog className="h-5 w-5 text-emerald-600" />} title="个人 AI 偏好" subtitle="仅影响当前用户的 AI 获客、邮件写作和跟进建议。" />
        <div className="mb-4 grid gap-3 md:grid-cols-2">
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">主要回复邮箱</label>
            <input
              type="email"
              value={businessEmail}
              onChange={(event) => setBusinessEmail(event.target.value)}
              placeholder="e.g. chris@vaysen.com"
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-800 dark:text-white"
            />
            <p className="mt-1 text-xs text-gray-400">外发活动可使用其他域名，但客户回复会优先指向此邮箱。</p>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">WhatsApp</label>
            <input
              value={whatsapp}
              onChange={(event) => setWhatsapp(event.target.value)}
              placeholder="e.g. +8618959231841"
              className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-800 dark:text-white"
            />
            <p className="mt-1 text-xs text-gray-400">用于 AI 模板和可选的邮件 WhatsApp 联系按钮。</p>
          </div>
        </div>
        <textarea
          rows={6}
          value={aiPreference}
          onChange={(event) => setAiPreference(event.target.value)}
          placeholder="例如：优先开发美国户外、电商和零售品牌；邮件简短直接；重点强调低 MOQ、打样、目录和合规。"
          className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-800 dark:text-white"
        />
        <button onClick={savePreference} disabled={savingPreference} className="mt-3 inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
          <Save className="h-4 w-4" />
          {savingPreference ? '保存中...' : '保存偏好'}
        </button>
      </section>

      {/* ── AI execution runtime and owner WeChat channel ── */}
      <section
        id="assistant-wechat-binding"
        className="scroll-mt-6 rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-950"
      >
        <SectionTitle
          icon={<Bot className="h-5 w-5 text-indigo-600" />}
          title="AI 业务助理执行与负责人微信"
          subtitle="OpenClaw 作为 JY AI 业务助理的受限执行内核；CRM 仍是权限与业务数据真相源。"
        />
        <WechatOwnerChannelCard
          companyId={companyId}
          snapshot={assistantRuntime.snapshot}
          loading={assistantRuntime.loading}
          error={assistantRuntime.error}
          onRefresh={() => void assistantRuntime.refresh()}
        />
      </section>

      {/* ── Company Users ── */}
      <section className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-950">
        <SectionTitle icon={<UserCog className="h-5 w-5 text-indigo-600" />} title={`公司用户（${companyUsers.length}）`} subtitle="管理员可创建和移除账号；业务员仅能查看自己负责的客户。" />
        {isAdmin && (
          <form className="mb-4 flex flex-col gap-2 md:flex-row" onSubmit={addUser}>
            <input type="email" required value={addUserEmail} onChange={(event) => setAddUserEmail(event.target.value)} placeholder="用户邮箱" className="flex-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-800 dark:text-white" />
            <select required value={addUserRoleId} onChange={(event) => setAddUserRoleId(event.target.value)} className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-800 dark:text-white">
              <option value="">选择角色</option>
              {roles.map((role) => <option key={role.id} value={role.id}>{role.displayName}</option>)}
            </select>
            <button disabled={addingUser} className="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50">
              <Plus className="h-4 w-4" />
              {addingUser ? '创建中...' : '创建用户'}
            </button>
          </form>
        )}
        <div className="space-y-2">
          {companyUsers.map((item) => (
            <div key={item.id} className="flex items-center justify-between rounded-lg border border-gray-100 p-3 dark:border-gray-800">
              <div>
                <div className="text-sm font-medium text-gray-900 dark:text-white">{item.user.firstName} {item.user.lastName}</div>
                <div className="text-xs text-gray-500">{item.user.email}</div>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-gray-500">{item.role.displayName}</span>
                {isAdmin && item.userId !== currentUser?.id && (
                  <button onClick={() => removeUser(item.userId, `${item.user.firstName} ${item.user.lastName}`)} className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600">
                    <Trash2 className="h-4 w-4" />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Change Password ── */}
      <section className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-950">
        <SectionTitle icon={<Lock className="h-5 w-5 text-amber-600" />} title="修改密码" />
        <form onSubmit={changePassword} className="grid max-w-xl gap-3">
          <input type="password" required value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} placeholder="当前密码" className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-800 dark:text-white" />
          <input type="password" required minLength={6} value={newPassword} onChange={(event) => setNewPassword(event.target.value)} placeholder="新密码" className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-800 dark:text-white" />
          <input type="password" required minLength={6} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} placeholder="再次输入新密码" className="rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-800 dark:text-white" />
          <button disabled={changingPassword} className="w-fit rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white hover:bg-amber-700 disabled:opacity-50">
            {changingPassword ? '修改中...' : '修改密码'}
          </button>
        </form>
      </section>

      {/* ── Language ── */}
      <section className="rounded-xl border border-gray-200 bg-white p-6 dark:border-gray-800 dark:bg-gray-950">
        <SectionTitle icon={<Globe className="h-5 w-5 text-purple-600" />} title="界面语言" subtitle={`当前：${locale === 'zh-CN' ? '中文' : 'English'}`} />
        <div className="flex gap-3">
          <button onClick={() => setLocale('zh-CN')} className={`rounded-lg border px-4 py-2 text-sm ${locale === 'zh-CN' ? 'border-purple-500 bg-purple-50 text-purple-700' : 'border-gray-200 text-gray-600'}`}>中文</button>
          <button onClick={() => setLocale('en')} className={`rounded-lg border px-4 py-2 text-sm ${locale === 'en' ? 'border-purple-500 bg-purple-50 text-purple-700' : 'border-gray-200 text-gray-600'}`}>English</button>
        </div>
      </section>
    </div>
  );
}

/* ── Helper Components ── */

function SectionTitle({ icon, title, subtitle }: { icon: ReactNode; title: string; subtitle?: string }) {
  return (
    <div className="mb-5 flex items-center gap-3">
      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gray-100 dark:bg-gray-900">{icon}</div>
      <div>
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{title}</h3>
        {subtitle && <p className="text-sm text-gray-500 dark:text-gray-400">{subtitle}</p>}
      </div>
    </div>
  );
}

function Info({ label, value }: { label: string; value?: string }) {
  return (
    <div className="rounded-lg bg-gray-50 p-3 dark:bg-gray-900">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="mt-1 text-sm text-gray-900 dark:text-white">{value || '-'}</div>
    </div>
  );
}

function InfoBlock({ label, value }: { label: string; value?: string }) {
  return (
    <div className="rounded-lg bg-gray-50 p-3 dark:bg-gray-900">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="mt-1 whitespace-pre-wrap text-sm leading-6 text-gray-900 dark:text-white">{value || '-'}</div>
    </div>
  );
}

function Notice({ color, text, onClose }: { color: 'red' | 'green'; text: string; onClose: () => void }) {
  const cls = color === 'red'
    ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300'
    : 'border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-900/20 dark:text-green-300';
  return (
    <div className={`flex items-center justify-between rounded-lg border p-3 text-sm ${cls}`}>
      <span>{text}</span>
      <button onClick={onClose}><X className="h-4 w-4" /></button>
    </div>
  );
}
