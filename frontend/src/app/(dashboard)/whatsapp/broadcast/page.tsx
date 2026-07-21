'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { useElectron } from '@/hooks/use-electron';
import api from '@/lib/api';
import {
  AlertCircle,
  CalendarClock,
  CheckCircle2,
  Clock,
  FileText,
  Loader2,
  Megaphone,
  MessageCircle,
  Search,
  Send,
  Shield,
  Smartphone,
  Trash2,
  Users,
  X,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

interface ElectronAccount {
  id: string;
  label: string;
  isActive: boolean;
}

interface CustomerOption {
  id: string;
  companyName: string;
  contactName: string | null;
  contactPhone?: string | null;
  whatsapp?: string | null;
  country?: string | null;
}

type TaskStatus = 'pending' | 'sending' | 'completed' | 'cancelled';

interface BroadcastTask {
  id: string;
  name: string;
  status: TaskStatus;
  sentCount: number;
  totalCount: number;
  createdAt: string;
  scheduledAt?: string | null;
  accountId?: string;
}

const STATUS_META: Record<
  TaskStatus,
  { label: string; color: string }
> = {
  pending: { label: '待发送', color: 'bg-gray-100 text-gray-600' },
  sending: { label: '发送中', color: 'bg-blue-50 text-blue-600' },
  completed: { label: '已完成', color: 'bg-green-50 text-green-600' },
  cancelled: { label: '已取消', color: 'bg-red-50 text-red-500' },
};

const TEMPLATE_VARS = [
  { token: '{name}', desc: '客户名称' },
  { token: '{product}', desc: '产品名称' },
];

const QUICK_TEMPLATES = [
  'Hello {name}, this is regarding our packaging products. Would you like to know more?',
  'Hi {name}, we have a new {product} catalog available. Please let me know if interested.',
  'Dear {name}, following up on our previous conversation about {product}. Any updates?',
];

export default function WhatsAppBroadcastPage() {
  const { isElectron, api: electronAPI } = useElectron();

  // 账号列表
  const [accounts, setAccounts] = useState<ElectronAccount[]>([]);
  // 客户列表
  const [customers, setCustomers] = useState<CustomerOption[]>([]);
  const [customerSearch, setCustomerSearch] = useState('');
  const [loadingCustomers, setLoadingCustomers] = useState(true);

  // 任务列表
  const [tasks, setTasks] = useState<BroadcastTask[]>([]);
  const [loadingTasks, setLoadingTasks] = useState(true);
  const [taskFeatureAvailable, setTaskFeatureAvailable] = useState(true);

  // 表单状态
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [selectedCustomerIds, setSelectedCustomerIds] = useState<Set<string>>(
    new Set(),
  );
  const [messageTemplate, setMessageTemplate] = useState('');
  const [sendMode, setSendMode] = useState<'immediate' | 'scheduled'>(
    'immediate',
  );
  const [scheduledAt, setScheduledAt] = useState('');
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [formSuccess, setFormSuccess] = useState<string | null>(null);

  // 1. 加载账号列表（Electron）
  useEffect(() => {
    if (!electronAPI) return;
    let cancelled = false;
    (async () => {
      try {
        const list = await electronAPI.whatsapp.listAccounts();
        if (cancelled) return;
        const arr = Array.isArray(list) ? list : [];
        setAccounts(arr);
        const active = arr.find((a) => a.isActive);
        if (active) setSelectedAccountId(active.id);
        else if (arr[0]) setSelectedAccountId(arr[0].id);
      } catch (err) {
        console.error('[Broadcast] 加载账号列表失败:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [electronAPI]);

  // 2. 加载客户列表（后端 /leads）
  useEffect(() => {
    api
      .get('/leads', { params: { page: 1, limit: 200 } })
      .then((res) => {
        const data = res.data?.data || res.data || [];
        setCustomers(Array.isArray(data) ? data : []);
      })
      .catch((err) => {
        console.error('[Broadcast] 加载客户列表失败:', err);
      })
      .finally(() => setLoadingCustomers(false));
  }, []);

  // 3. 加载群发任务列表（后端）
  const fetchTasks = useCallback(async () => {
    setLoadingTasks(true);
    try {
      const res = await api.get('/whatsapp/broadcast/tasks');
      const data = res.data?.data || res.data || [];
      setTasks(Array.isArray(data) ? data : []);
      setTaskFeatureAvailable(true);
    } catch (err: any) {
      // 后端接口可能尚未实现
      setTaskFeatureAvailable(false);
      setTasks([]);
    } finally {
      setLoadingTasks(false);
    }
  }, []);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  // 客户搜索过滤
  const filteredCustomers = useMemo(() => {
    if (!customerSearch.trim()) return customers;
    const q = customerSearch.toLowerCase();
    return customers.filter(
      (c) =>
        c.companyName?.toLowerCase().includes(q) ||
        c.contactName?.toLowerCase().includes(q) ||
        c.contactPhone?.includes(q),
    );
  }, [customers, customerSearch]);

  const toggleCustomer = (id: string) => {
    setSelectedCustomerIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const insertVar = (token: string) => {
    setMessageTemplate((prev) => `${prev}${token}`);
  };

  const handleCreateTask = async () => {
    setFormError(null);
    setFormSuccess(null);

    if (!selectedAccountId) {
      setFormError('请选择发送账号');
      return;
    }
    if (selectedCustomerIds.size === 0) {
      setFormError('请至少选择一个目标客户');
      return;
    }
    if (!messageTemplate.trim()) {
      setFormError('请输入消息模板');
      return;
    }
    if (selectedCustomerIds.size > 50) {
      setFormError('单次群发不超过 50 人，请减少目标客户数量');
      return;
    }
    if (sendMode === 'scheduled' && !scheduledAt) {
      setFormError('请选择定时发送时间');
      return;
    }

    setCreating(true);
    try {
      await api.post('/whatsapp/broadcast/tasks', {
        accountId: selectedAccountId,
        customerIds: Array.from(selectedCustomerIds),
        messageTemplate: messageTemplate.trim(),
        sendMode,
        scheduledAt: sendMode === 'scheduled' ? scheduledAt : null,
      });
      setFormSuccess('群发任务创建成功');
      setMessageTemplate('');
      setSelectedCustomerIds(new Set());
      setScheduledAt('');
      setSendMode('immediate');
      await fetchTasks();
    } catch (err: any) {
      setFormError(
        err?.response?.data?.message ||
          '群发任务创建失败，该功能可能仍在开发中',
      );
    } finally {
      setCreating(false);
    }
  };

  const handleCancelTask = async (taskId: string) => {
    if (!confirm('确定取消此群发任务？')) return;
    try {
      await api.post(`/whatsapp/broadcast/tasks/${taskId}/cancel`);
      await fetchTasks();
    } catch (err: any) {
      setFormError(err?.response?.data?.message || '取消任务失败');
    }
  };

  const formatDateTime = (ts: string | null | undefined) => {
    if (!ts) return '-';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return ts;
    return d.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-bold text-gray-900">
            <Megaphone className="h-5 w-5 text-blue-600" />
            WhatsApp 群发营销
          </h1>
          <p className="mt-0.5 text-sm text-gray-500">
            模板群发 · 定时发送 · 进度跟踪
          </p>
        </div>
        <Link
          href="/whatsapp/chat"
          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50"
        >
          <MessageCircle className="h-3.5 w-3.5" />
          返回聊天
        </Link>
      </div>

      {/* 安全提示 */}
      <Card className="border-amber-200 bg-amber-50 p-4">
        <div className="flex items-center gap-2">
          <Shield className="h-4 w-4 text-amber-600" />
          <span className="text-sm font-semibold text-amber-800">安全提示</span>
        </div>
        <ul className="mt-2 space-y-1 text-xs text-amber-700">
          <li className="flex items-start gap-1.5">
            <span className="mt-0.5">·</span>
            <span>群发营销功能应合理使用，避免频繁发送导致账号被限制。</span>
          </li>
          <li className="flex items-start gap-1.5">
            <span className="mt-0.5">·</span>
            <span>建议每次群发不超过 50 人，间隔 2 分钟以上。</span>
          </li>
          <li className="flex items-start gap-1.5">
            <span className="mt-0.5">·</span>
            <span>仅向已有客户或主动咨询的客户发送，避免陌生触达触发风控。</span>
          </li>
        </ul>
      </Card>

      {/* 两栏布局 */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {/* 左栏：创建表单 */}
        <Card className="flex flex-col p-4">
          <h3 className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-gray-900">
            <Send className="h-4 w-4 text-blue-600" />
            创建群发任务
          </h3>

          {/* 选择账号 */}
          <div className="mb-3">
            <label className="mb-1 block text-xs font-medium text-gray-600">
              发送账号
            </label>
            {isElectron ? (
              <select
                value={selectedAccountId}
                onChange={(e) => setSelectedAccountId(e.target.value)}
                className="w-full rounded border border-gray-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
              >
                {accounts.length === 0 && (
                  <option value="">暂无可用账号</option>
                )}
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}（{a.id}）{a.isActive ? ' · 活跃' : ''}
                  </option>
                ))}
              </select>
            ) : (
              <div className="flex items-center gap-2 rounded border border-gray-200 bg-gray-50 px-3 py-2 text-xs text-gray-400">
                <Smartphone className="h-3.5 w-3.5" />
                请在桌面应用中选择账号
              </div>
            )}
          </div>

          {/* 选择目标客户 */}
          <div className="mb-3">
            <div className="mb-1 flex items-center justify-between">
              <label className="text-xs font-medium text-gray-600">
                目标客户
              </label>
              <span className="text-[11px] text-gray-400">
                已选 {selectedCustomerIds.size} 人
                {selectedCustomerIds.size > 50 && (
                  <span className="ml-1 text-red-500">（超过 50 人上限）</span>
                )}
              </span>
            </div>
            <div className="relative mb-1.5">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-gray-400" />
              <input
                value={customerSearch}
                onChange={(e) => setCustomerSearch(e.target.value)}
                placeholder="搜索客户名称 / 电话"
                className="w-full rounded border border-gray-200 bg-gray-50 py-1.5 pl-8 pr-2 text-xs focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
              />
            </div>
            <div className="max-h-44 overflow-y-auto rounded border border-gray-100">
              {loadingCustomers ? (
                <div className="flex items-center justify-center py-4 text-xs text-gray-400">
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  加载中...
                </div>
              ) : filteredCustomers.length === 0 ? (
                <div className="py-4 text-center text-xs text-gray-400">
                  暂无客户
                </div>
              ) : (
                <ul>
                  {filteredCustomers.slice(0, 100).map((c) => {
                    const checked = selectedCustomerIds.has(c.id);
                    return (
                      <li key={c.id}>
                        <label className="flex cursor-pointer items-center gap-2 border-b border-gray-50 px-2.5 py-1.5 text-xs hover:bg-gray-50">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => toggleCustomer(c.id)}
                            className="h-3.5 w-3.5 rounded border-gray-300 text-blue-600 focus:ring-blue-400"
                          />
                          <span className="flex-1 truncate font-medium text-gray-700">
                            {c.companyName || c.contactName || '未命名'}
                          </span>
                          {c.contactPhone && (
                            <span className="text-[10px] text-gray-400">
                              {c.contactPhone}
                            </span>
                          )}
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </div>

          {/* 消息模板 */}
          <div className="mb-3">
            <label className="mb-1 block text-xs font-medium text-gray-600">
              消息模板
            </label>
            <textarea
              value={messageTemplate}
              onChange={(e) => setMessageTemplate(e.target.value)}
              placeholder="输入消息内容，支持变量 {name}、{product}..."
              rows={4}
              className="w-full resize-none rounded border border-gray-200 px-3 py-2 text-sm focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
            />
            {/* 变量插入 */}
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] text-gray-400">插入变量：</span>
              {TEMPLATE_VARS.map((v) => (
                <button
                  key={v.token}
                  onClick={() => insertVar(v.token)}
                  className="rounded bg-blue-50 px-1.5 py-0.5 text-[10px] text-blue-600 hover:bg-blue-100"
                >
                  {v.token} {v.desc}
                </button>
              ))}
            </div>
            {/* 快捷模板 */}
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <span className="text-[10px] text-gray-400">快捷模板：</span>
              {QUICK_TEMPLATES.map((t, i) => (
                <button
                  key={i}
                  onClick={() => setMessageTemplate(t)}
                  className="rounded bg-gray-50 px-1.5 py-0.5 text-[10px] text-gray-500 hover:bg-gray-100"
                >
                  模板 {i + 1}
                </button>
              ))}
            </div>
          </div>

          {/* 发送时间 */}
          <div className="mb-3">
            <label className="mb-1 block text-xs font-medium text-gray-600">
              发送时间
            </label>
            <div className="flex gap-3">
              <label className="flex cursor-pointer items-center gap-1.5 text-xs text-gray-700">
                <input
                  type="radio"
                  name="sendMode"
                  checked={sendMode === 'immediate'}
                  onChange={() => setSendMode('immediate')}
                  className="h-3.5 w-3.5 text-blue-600 focus:ring-blue-400"
                />
                立即发送
              </label>
              <label className="flex cursor-pointer items-center gap-1.5 text-xs text-gray-700">
                <input
                  type="radio"
                  name="sendMode"
                  checked={sendMode === 'scheduled'}
                  onChange={() => setSendMode('scheduled')}
                  className="h-3.5 w-3.5 text-blue-600 focus:ring-blue-400"
                />
                定时发送
              </label>
            </div>
            {sendMode === 'scheduled' && (
              <input
                type="datetime-local"
                value={scheduledAt}
                onChange={(e) => setScheduledAt(e.target.value)}
                className="mt-1.5 w-full rounded border border-gray-200 px-3 py-1.5 text-xs focus:border-blue-400 focus:outline-none focus:ring-1 focus:ring-blue-400"
              />
            )}
          </div>

          {/* 提示信息 */}
          {formError && (
            <div className="mb-2 flex items-center gap-1.5 rounded border border-red-200 bg-red-50 px-2.5 py-1.5 text-xs text-red-600">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              {formError}
            </div>
          )}
          {formSuccess && (
            <div className="mb-2 flex items-center gap-1.5 rounded border border-green-200 bg-green-50 px-2.5 py-1.5 text-xs text-green-600">
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
              {formSuccess}
            </div>
          )}

          {/* 创建按钮 */}
          <button
            onClick={handleCreateTask}
            disabled={creating}
            className="inline-flex items-center justify-center gap-1.5 rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {creating ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Megaphone className="h-4 w-4" />
            )}
            {creating ? '创建中...' : '创建群发任务'}
          </button>
        </Card>

        {/* 右栏：任务列表 */}
        <Card className="flex flex-col p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold text-gray-900">
              <Clock className="h-4 w-4 text-blue-600" />
              群发任务列表
            </h3>
            <button
              onClick={fetchTasks}
              className="text-xs text-gray-500 hover:text-gray-700"
            >
              刷新
            </button>
          </div>

          {loadingTasks ? (
            <div className="flex items-center justify-center py-8 text-gray-400">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              加载中...
            </div>
          ) : !taskFeatureAvailable ? (
            <div className="flex flex-col items-center py-10 text-center text-gray-400">
              <Megaphone className="mb-2 h-10 w-10 text-gray-300" />
              <p className="text-sm font-medium text-gray-500">功能开发中</p>
              <p className="mt-1 max-w-xs text-xs">
                群发任务后端接口（/api/whatsapp/broadcast/tasks）尚未就绪，
                创建的任务将在接口可用后自动同步。
              </p>
            </div>
          ) : tasks.length === 0 ? (
            <div className="flex flex-col items-center py-10 text-center text-gray-400">
              <Users className="mb-2 h-10 w-10 text-gray-300" />
              <p className="text-sm">暂无群发任务</p>
              <p className="mt-1 text-xs">在左侧创建第一个群发任务</p>
            </div>
          ) : (
            <ul className="space-y-2.5">
              {tasks.map((task) => {
                const meta = STATUS_META[task.status] || STATUS_META.pending;
                const progress =
                  task.totalCount > 0
                    ? Math.round((task.sentCount / task.totalCount) * 100)
                    : 0;
                const cancellable =
                  task.status === 'pending' || task.status === 'sending';
                return (
                  <li
                    key={task.id}
                    className="rounded-lg border border-gray-100 p-3"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-gray-900">
                          {task.name || `任务 ${task.id.slice(0, 8)}`}
                        </p>
                        <p className="mt-0.5 flex items-center gap-2 text-[11px] text-gray-400">
                          <CalendarClock className="h-3 w-3" />
                          {formatDateTime(task.createdAt)}
                          {task.scheduledAt && (
                            <span className="text-blue-400">
                              · 定时 {formatDateTime(task.scheduledAt)}
                            </span>
                          )}
                        </p>
                      </div>
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${meta.color}`}
                      >
                        {meta.label}
                      </span>
                    </div>

                    {/* 进度条 */}
                    <div className="mt-2">
                      <div className="mb-1 flex items-center justify-between text-[11px] text-gray-500">
                        <span>
                          已发送 {task.sentCount} / {task.totalCount}
                        </span>
                        <span>{progress}%</span>
                      </div>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-100">
                        <div
                          className="h-full rounded-full bg-blue-500 transition-all"
                          style={{ width: `${progress}%` }}
                        />
                      </div>
                    </div>

                    {/* 操作 */}
                    <div className="mt-2.5 flex justify-end gap-2">
                      <button className="rounded bg-gray-50 px-2 py-1 text-[11px] text-gray-500 hover:bg-gray-100">
                        查看详情
                      </button>
                      {cancellable && (
                        <button
                          onClick={() => handleCancelTask(task.id)}
                          className="inline-flex items-center gap-1 rounded bg-red-50 px-2 py-1 text-[11px] text-red-500 hover:bg-red-100"
                        >
                          <X className="h-3 w-3" />
                          取消任务
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      {/* 底部：模板管理快捷入口 */}
      <Card className="flex items-center justify-between p-4">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-gray-500" />
          <div>
            <p className="text-sm font-medium text-gray-700">群发模板管理</p>
            <p className="text-xs text-gray-400">
              统一管理常用消息模板，支持变量与多语言版本
            </p>
          </div>
        </div>
        <Link
          href="/email-templates"
          className="inline-flex items-center gap-1 rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-50"
        >
          <Trash2 className="h-3.5 w-3.5" />
          前往模板列表
        </Link>
      </Card>
    </div>
  );
}
