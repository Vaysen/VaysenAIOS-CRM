'use client';

import { useEffect, useState, useCallback } from 'react';
import api from '@/lib/api';
import { useAuthStore } from '@/store/authStore';
import { useT } from '@/i18n/use-translation';
import { Plus, Trash2, Shield, Ban, CheckCircle, Edit3, X } from 'lucide-react';

interface UserData {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone?: string;
  isActive: boolean;
  lastLoginAt?: string;
  createdAt: string;
  companies?: { company: { id: string; name: string; slug: string }; role: { id: string; name: string; displayName: string } }[];
}

interface RoleData {
  id: string;
  name: string;
  label: string;
  displayName?: string;
}

interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

function toUsernameError(message: string) {
  return message.replace(/Email/g, 'Username').replace(/email/g, 'username');
}

export default function UsersPage() {
  const { t } = useT();
  const { user: currentUser } = useAuthStore();
  const [users, setUsers] = useState<UserData[]>([]);
  const [roles, setRoles] = useState<RoleData[]>([]);
  const [meta, setMeta] = useState<PaginationMeta>({ page: 1, limit: 20, total: 0, totalPages: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [editingUser, setEditingUser] = useState<UserData | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const [form, setForm] = useState({
    email: '',
    password: '',
    firstName: '',
    lastName: '',
    phone: '',
    roleId: '',
  });

  const [editForm, setEditForm] = useState({
    email: '',
    password: '',
    firstName: '',
    lastName: '',
    phone: '',
    roleId: '',
    isActive: true,
  });

  const currentCompany = currentUser?.companies?.[0];
  const companyId = currentCompany?.id;
  const isSuperAdmin = currentUser?.companies?.some((c: any) => c.role === 'super_admin');
  const isAdmin = isSuperAdmin || currentCompany?.role === 'company_admin';

  const fetchUsers = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await api.get('/users', { params: { page: 1, limit: 50 } });
      setUsers(res.data.data || []);
      setMeta(res.data.meta || { page: 1, limit: 50, total: 0, totalPages: 0 });
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to load users');
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchRoles = useCallback(async () => {
    try {
      const res = await api.get('/users/roles');
      setRoles(res.data?.data || []);
    } catch (error) {
      console.error('[UsersPage] load roles failed:', error);
    }
  }, []);

  useEffect(() => {
    fetchUsers();
    fetchRoles();
  }, [fetchUsers, fetchRoles]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!companyId || !form.roleId) {
      setError('Company and role are required');
      return;
    }
    try {
      setActionLoading('create');
      setError(null);
      await api.post('/users', {
        email: form.email,
        password: form.password,
        firstName: form.firstName,
        lastName: form.lastName,
        phone: form.phone || undefined,
        roleId: form.roleId,
        companyId,
      });
      setShowCreate(false);
      setForm({ email: '', password: '', firstName: '', lastName: '', phone: '', roleId: '' });
      fetchUsers();
    } catch (err: any) {
      setError(toUsernameError(err.response?.data?.message || 'Failed to create user'));
    } finally {
      setActionLoading(null);
    }
  };

  const handleToggleStatus = async (userId: string, isActive: boolean) => {
    try {
      setActionLoading(userId);
      await api.patch(`/users/${userId}/status`, { isActive: !isActive });
      fetchUsers();
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to update user status');
    } finally {
      setActionLoading(null);
    }
  };

  const handleDelete = async (userId: string) => {
    if (!confirm(t('users.confirmDelete'))) return;
    try {
      setActionLoading(userId);
      await api.delete(`/users/${userId}`);
      fetchUsers();
    } catch (err: any) {
      setError(err.response?.data?.message || 'Failed to delete user');
    } finally {
      setActionLoading(null);
    }
  };

  const openEditModal = (u: UserData) => {
    const userCompany = u.companies?.[0];
    setEditingUser(u);
    setEditForm({
      email: u.email,
      password: '',
      firstName: u.firstName,
      lastName: u.lastName,
      phone: u.phone || '',
      roleId: userCompany?.role?.id || '',
      isActive: u.isActive,
    });
  };

  const handleAdminUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingUser) return;
    try {
      setActionLoading('edit');
      setError(null);
      const payload: any = {};
      if (editForm.email !== editingUser.email) payload.email = editForm.email;
      if (editForm.password) payload.password = editForm.password;
      if (editForm.firstName !== editingUser.firstName) payload.firstName = editForm.firstName;
      if (editForm.lastName !== editingUser.lastName) payload.lastName = editForm.lastName;
      if (editForm.phone !== (editingUser.phone || '')) payload.phone = editForm.phone;
      if (editForm.roleId && editForm.roleId !== editingUser.companies?.[0]?.role?.id) payload.roleId = editForm.roleId;
      if (editForm.isActive !== editingUser.isActive) payload.isActive = editForm.isActive;

      if (Object.keys(payload).length === 0) {
        setEditingUser(null);
        return;
      }

      await api.patch(`/users/${editingUser.id}/admin-update`, payload);
      setEditingUser(null);
      setEditForm({ email: '', password: '', firstName: '', lastName: '', phone: '', roleId: '', isActive: true });
      fetchUsers();
    } catch (err: any) {
      setError(toUsernameError(err.response?.data?.message || 'Failed to update user'));
    } finally {
      setActionLoading(null);
    }
  };

  const getRoleLabel = (roleName: string) => {
    const found = roles.find((r) => r.name === roleName);
    return found?.label || found?.displayName || roleName;
  };

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return t('common.never');
    return new Date(dateStr).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-gray-500 dark:text-gray-400">{t('users.loading')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">
            {t('users.title')}
          </h2>
          <p className="text-gray-500 dark:text-gray-400">
            {t('users.totalUsers', { count: String(meta.total) })}
          </p>
        </div>
        {isAdmin && (
          <button
            onClick={() => setShowCreate(true)}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
          >
            <Plus className="h-4 w-4" />
            {t('users.addUser')}
          </button>
        )}
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {showCreate && (
        <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
            {t('users.createUser')}
          </h3>
          <form className="space-y-4" onSubmit={handleCreate}>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {t('users.firstName')}
                </label>
                <input
                  type="text"
                  required
                  value={form.firstName}
                  onChange={(e) => setForm({ ...form, firstName: e.target.value })}
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {t('users.lastName')}
                </label>
                <input
                  type="text"
                  required
                  value={form.lastName}
                  onChange={(e) => setForm({ ...form, lastName: e.target.value })}
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                用户名
              </label>
              <input
                type="text"
                required
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {t('users.password')}
                </label>
                <input
                  type="password"
                  required
                  minLength={6}
                  value={form.password}
                  onChange={(e) => setForm({ ...form, password: e.target.value })}
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {t('users.phone')} <span className="text-gray-400 font-normal">{t('users.phoneOptional')}</span>
                </label>
                <input
                  type="text"
                  value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })}
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                />
              </div>
            </div>
            {roles.length > 0 && (
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                  {t('users.role')}
                </label>
                <select
                  value={form.roleId}
                  onChange={(e) => setForm({ ...form, roleId: e.target.value })}
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                >
                  <option value="">{t('users.selectRole')}</option>
                  {roles.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={() => setShowCreate(false)}
                className="rounded-lg border border-gray-300 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
              >
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                disabled={actionLoading === 'create'}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
              >
                {actionLoading === 'create' ? t('users.creating') : t('users.create')}
              </button>
            </div>
          </form>
        </div>
      )}

      {editingUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setEditingUser(null)}>
          <div className="w-full max-w-lg rounded-xl border border-gray-200 bg-white p-6 shadow-xl dark:border-gray-800 dark:bg-gray-950" onClick={(e) => e.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                Edit User: {editingUser.firstName} {editingUser.lastName}
              </h3>
              <button onClick={() => setEditingUser(null)} className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600">
                <X className="h-5 w-5" />
              </button>
            </div>
            <form className="space-y-4" onSubmit={handleAdminUpdate}>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">First Name</label>
                  <input type="text" required value={editForm.firstName}
                    onChange={(e) => setEditForm({ ...editForm, firstName: e.target.value })}
                    className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Last Name</label>
                  <input type="text" required value={editForm.lastName}
                    onChange={(e) => setEditForm({ ...editForm, lastName: e.target.value })}
                    className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">用户名</label>
                <input type="text" required value={editForm.email}
                  onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">New Password (leave empty to keep current)</label>
                <input type="password" minLength={6} value={editForm.password}
                  onChange={(e) => setEditForm({ ...editForm, password: e.target.value })}
                  placeholder="Leave blank to keep current password"
                  className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Phone</label>
                  <input type="text" value={editForm.phone}
                    onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })}
                    className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Role</label>
                  <select value={editForm.roleId}
                    onChange={(e) => setEditForm({ ...editForm, roleId: e.target.value })}
                    className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none">
                    <option value="">Select role</option>
                    {roles.map((r) => (
                      <option key={r.id} value={r.id}>{r.label}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <input type="checkbox" id="edit-isActive" checked={editForm.isActive}
                  onChange={(e) => setEditForm({ ...editForm, isActive: e.target.checked })}
                  className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
                <label htmlFor="edit-isActive" className="text-sm font-medium text-gray-700 dark:text-gray-300">Active</label>
              </div>
              <div className="flex gap-2 justify-end">
                <button type="button" onClick={() => setEditingUser(null)}
                  className="rounded-lg border border-gray-300 dark:border-gray-700 px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors">
                  Cancel
                </button>
                <button type="submit" disabled={actionLoading === 'edit'}
                  className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 transition-colors">
                  {actionLoading === 'edit' ? 'Saving...' : 'Save Changes'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50">
                <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">{t('users.table.user')}</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">用户名</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">{t('users.table.role')}</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">{t('users.table.status')}</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">{t('users.table.lastLogin')}</th>
                <th className="text-left px-4 py-3 font-medium text-gray-500 dark:text-gray-400">{t('users.table.created')}</th>
                {isAdmin && (
                  <th className="text-right px-4 py-3 font-medium text-gray-500 dark:text-gray-400">{t('common.actions')}</th>
                )}
              </tr>
            </thead>
            <tbody>
              {users.length === 0 ? (
                <tr>
                  <td colSpan={isAdmin ? 7 : 6} className="px-4 py-8 text-center text-gray-400">
                    {t('users.noUsers')}
                  </td>
                </tr>
              ) : (
                users.map((u) => {
                  const userCompany = u.companies?.[0];
                  const userRole = userCompany?.role?.name || 'N/A';
                  return (
                    <tr
                      key={u.id}
                      className="border-b border-gray-100 dark:border-gray-800 last:border-0 hover:bg-gray-50 dark:hover:bg-gray-900/30"
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <div className="h-8 w-8 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center text-xs font-medium text-blue-600 dark:text-blue-400">
                            {u.firstName?.[0]}{u.lastName?.[0]}
                          </div>
                          <span className="font-medium text-gray-900 dark:text-white">
                            {u.firstName} {u.lastName}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-gray-600 dark:text-gray-300">
                        {u.email}
                      </td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 dark:bg-blue-900/20 px-2 py-0.5 text-xs font-medium text-blue-700 dark:text-blue-300">
                          <Shield className="h-3 w-3" />
                          {getRoleLabel(userRole)}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        {u.isActive ? (
                          <span className="inline-flex items-center gap-1 text-green-600 dark:text-green-400 text-xs font-medium">
                            <CheckCircle className="h-3 w-3" />
                            {t('common.active')}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-red-600 dark:text-red-400 text-xs font-medium">
                            <Ban className="h-3 w-3" />
                            {t('common.disabled')}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-gray-500 dark:text-gray-400">
                        {formatDate(u.lastLoginAt)}
                      </td>
                      <td className="px-4 py-3 text-gray-500 dark:text-gray-400">
                        {formatDate(u.createdAt)}
                      </td>
                      {isAdmin && (
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-end gap-1">
                            <button
                              onClick={() => openEditModal(u)}
                              className="rounded p-1.5 text-gray-400 hover:text-green-600 hover:bg-green-50 dark:hover:bg-green-900/20 transition-colors"
                              title="Edit user"
                            >
                              <Edit3 className="h-4 w-4" />
                            </button>
                            <button
                              onClick={() => handleToggleStatus(u.id, u.isActive)}
                              disabled={actionLoading === u.id || u.id === currentUser?.id}
                              className="rounded p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 dark:hover:bg-blue-900/20 disabled:opacity-30 transition-colors"
                              title={u.isActive ? t('common.disable') : t('common.enable')}
                            >
                              {u.isActive ? (
                                <Ban className="h-4 w-4" />
                              ) : (
                                <CheckCircle className="h-4 w-4" />
                              )}
                            </button>
                            <button
                              onClick={() => handleDelete(u.id)}
                              disabled={actionLoading === u.id || u.id === currentUser?.id}
                              className="rounded p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-30 transition-colors"
                              title={t('common.delete')}
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
