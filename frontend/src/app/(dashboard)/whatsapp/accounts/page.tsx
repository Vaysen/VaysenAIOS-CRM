'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  Laptop,
  Loader2,
  LogOut,
  MessageCircle,
  Plus,
  QrCode,
  RefreshCw,
  Server,
  ShieldCheck,
  Smartphone,
  Trash2,
  WifiOff,
} from 'lucide-react';
import { Card } from '@/components/ui/card';
import { OwnerNotificationStatusPill } from '@/components/assistant/owner-notification-status';
import { useElectron, type WhatsAppLoginStatus } from '@/hooks/use-electron';
import {
  createServerWhatsAppAccount,
  deliveryFailureFrom,
  disconnectServerWhatsAppAccount,
  getServerWhatsAppQr,
  listServerWhatsAppAccounts,
  reconnectServerWhatsAppAccount,
  removeServerWhatsAppAccount,
  type ServerWhatsAppAccount,
  type ServerWhatsAppQr,
  type ServerWhatsAppStatus,
} from '@/lib/messaging-control-api';

interface ElectronAccount {
  id: string;
  label: string;
  isActive: boolean;
}

const SERVER_STATUS: Record<ServerWhatsAppStatus, { label: string; style: string }> = {
  connected: { label: '已连接', style: 'bg-emerald-50 text-emerald-700' },
  pending_qr: { label: '等待扫码', style: 'bg-blue-50 text-blue-700' },
  waiting_scan: { label: '等待扫码', style: 'bg-blue-50 text-blue-700' },
  reconnecting: { label: '正在重连', style: 'bg-amber-50 text-amber-700' },
  disconnected: { label: '已断开', style: 'bg-slate-100 text-slate-600' },
  error: { label: '连接异常', style: 'bg-red-50 text-red-700' },
  unknown: { label: '状态未知', style: 'bg-slate-100 text-slate-600' },
};

const ELECTRON_STATUS: Record<WhatsAppLoginStatus, string> = {
  logged_in: '已登录',
  waiting_scan: '等待扫码',
  unknown: '未登录',
};

function formatTime(value: string | null) {
  return value ? new Date(value).toLocaleString('zh-CN') : '—';
}

export default function WhatsAppAccountsPage() {
  const {
    isElectron,
    api: electronApi,
    whatsappStatus,
    onWhatsappAccountSwitched,
  } = useElectron();
  const [serverAccounts, setServerAccounts] = useState<ServerWhatsAppAccount[]>([]);
  const [electronAccounts, setElectronAccounts] = useState<ElectronAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [accountName, setAccountName] = useState('');
  const [phone, setPhone] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [qrAccount, setQrAccount] = useState<ServerWhatsAppAccount | null>(null);
  const [qr, setQr] = useState<ServerWhatsAppQr | null>(null);
  const [qrLoading, setQrLoading] = useState(false);

  const loadServerAccounts = useCallback(async () => {
    try {
      const accounts = await listServerWhatsAppAccounts();
      setServerAccounts(accounts);
      setError(null);
    } catch (cause) {
      const failure = deliveryFailureFrom(cause);
      setError(`${failure.code}：${failure.message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadElectronAccounts = useCallback(async () => {
    if (!electronApi) return;
    try {
      const accounts = await electronApi.whatsapp.listAccounts();
      setElectronAccounts(Array.isArray(accounts) ? accounts : []);
    } catch (cause) {
      console.error('读取桌面 WhatsApp 账号失败', cause);
    }
  }, [electronApi]);

  useEffect(() => {
    void loadServerAccounts();
  }, [loadServerAccounts]);

  useEffect(() => {
    if (!isElectron) return;
    void loadElectronAccounts();
    return onWhatsappAccountSwitched(() => void loadElectronAccounts());
  }, [isElectron, loadElectronAccounts, onWhatsappAccountSwitched]);

  useEffect(() => {
    if (!qrAccount || qr?.status === 'connected') return;
    const timer = window.setInterval(async () => {
      try {
        const next = await getServerWhatsAppQr(qrAccount.id);
        setQr(next);
        if (next.status === 'connected') void loadServerAccounts();
      } catch (cause) {
        setError(deliveryFailureFrom(cause).message);
      }
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [loadServerAccounts, qr?.status, qrAccount]);

  const openQr = async (account: ServerWhatsAppAccount, reconnect = false) => {
    setQrAccount(account);
    setQr(null);
    setQrLoading(true);
    setError(null);
    try {
      const next = reconnect
        ? await reconnectServerWhatsAppAccount(account.id)
        : await getServerWhatsAppQr(account.id);
      setQr(next);
      void loadServerAccounts();
    } catch (cause) {
      const failure = deliveryFailureFrom(cause);
      setError(`${failure.code}：${failure.message}`);
    } finally {
      setQrLoading(false);
    }
  };

  const createAccount = async () => {
    const name = accountName.trim();
    if (!name || creating) return;
    setCreating(true);
    setError(null);
    try {
      const account = await createServerWhatsAppAccount({
        name,
        ...(phone.trim() ? { phone: phone.trim() } : {}),
      });
      setAccountName('');
      setPhone('');
      await loadServerAccounts();
      await openQr(account);
    } catch (cause) {
      const failure = deliveryFailureFrom(cause);
      setError(`${failure.code}：${failure.message}`);
    } finally {
      setCreating(false);
    }
  };

  const disconnect = async (account: ServerWhatsAppAccount) => {
    setBusyId(account.id);
    try {
      await disconnectServerWhatsAppAccount(account.id);
      await loadServerAccounts();
    } catch (cause) {
      const failure = deliveryFailureFrom(cause);
      setError(`${failure.code}：${failure.message}`);
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (account: ServerWhatsAppAccount) => {
    if (!window.confirm(`确定删除服务器 WhatsApp 账号“${account.accountName}”及其登录会话？`)) return;
    setBusyId(account.id);
    try {
      await removeServerWhatsAppAccount(account.id);
      if (qrAccount?.id === account.id) {
        setQrAccount(null);
        setQr(null);
      }
      await loadServerAccounts();
    } catch (cause) {
      const failure = deliveryFailureFrom(cause);
      setError(`${failure.code}：${failure.message}`);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-900">WhatsApp 账号与消息通道</h1>
          <p className="mt-1 text-sm text-slate-500">
            Linux 后端 Baileys 负责 AI 助理与微信通知链路；桌面 WhatsApp Web 继续用于人工操作。
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <OwnerNotificationStatusPill />
          <button
            type="button"
            onClick={() => void loadServerAccounts()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-lg border bg-white px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            刷新真实状态
          </button>
        </div>
      </div>

      {error && (
        <Card className="flex items-start justify-between gap-3 border-red-200 bg-red-50 p-3" role="alert">
          <div className="flex items-start gap-2 text-sm text-red-700">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
          <button type="button" onClick={() => setError(null)} aria-label="关闭错误">×</button>
        </Card>
      )}

      <section className="space-y-3" aria-labelledby="server-whatsapp-title">
        <div className="flex items-center gap-2">
          <Server className="h-4 w-4 text-emerald-600" />
          <h2 id="server-whatsapp-title" className="font-semibold text-slate-900">Linux 后端 Baileys 通道</h2>
          <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] text-emerald-700">
            AI 助理使用此通道
          </span>
        </div>

        <Card className="border-emerald-200 bg-emerald-50/60 p-4 text-xs leading-5 text-emerald-900">
          <div className="flex items-start gap-2">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
            <p>
              只有状态为“已连接”且服务器返回真实 provider messageId 时，系统才会显示发送成功。
              二维码来自当前 Linux Baileys 会话，不会使用 Electron 的浏览器 Cookie 代替服务器登录。
            </p>
          </div>
        </Card>

        {loading && serverAccounts.length === 0 ? (
          <Card className="p-8 text-center text-sm text-slate-400">
            <Loader2 className="mx-auto mb-2 h-5 w-5 animate-spin" />
            正在读取服务器账号……
          </Card>
        ) : serverAccounts.length === 0 ? (
          <Card className="p-8 text-center">
            <WifiOff className="mx-auto mb-2 h-8 w-8 text-slate-300" />
            <p className="text-sm font-medium text-slate-700">服务器尚未建立 WhatsApp 会话</p>
            <p className="mt-1 text-xs text-slate-400">在下方创建账号后，本页会直接显示可扫描二维码。</p>
          </Card>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {serverAccounts.map((account) => {
              const status = SERVER_STATUS[account.status];
              const busy = busyId === account.id;
              return (
                <Card key={account.id} className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-emerald-100">
                        <Smartphone className="h-4 w-4 text-emerald-700" />
                      </div>
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-slate-900">{account.accountName}</p>
                        <p className="truncate text-[10px] text-slate-400" title={account.id}>{account.id}</p>
                      </div>
                    </div>
                    <span className={`shrink-0 rounded-full px-2 py-1 text-[10px] font-medium ${status.style}`}>
                      {status.label}
                    </span>
                  </div>
                  <dl className="mt-3 grid grid-cols-[72px_1fr] gap-y-1 text-[11px]">
                    <dt className="text-slate-400">绑定号码</dt>
                    <dd className="truncate text-slate-700">{account.phoneNumber || '扫码后由服务器回写'}</dd>
                    <dt className="text-slate-400">最近在线</dt>
                    <dd className="text-slate-700">{formatTime(account.lastSeenAt)}</dd>
                  </dl>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {account.status !== 'connected' ? (
                      <button
                        type="button"
                        onClick={() => void openQr(account, account.status === 'disconnected' || account.status === 'error')}
                        disabled={busy}
                        className="inline-flex flex-1 items-center justify-center gap-1 rounded bg-emerald-600 px-2 py-1.5 text-xs text-white hover:bg-emerald-700 disabled:opacity-50"
                      >
                        <QrCode className="h-3.5 w-3.5" />扫码连接
                      </button>
                    ) : (
                      <Link
                        href="/whatsapp/chat"
                        className="inline-flex flex-1 items-center justify-center gap-1 rounded bg-emerald-50 px-2 py-1.5 text-xs text-emerald-700 hover:bg-emerald-100"
                      >
                        <MessageCircle className="h-3.5 w-3.5" />打开聊天
                      </Link>
                    )}
                    {account.status === 'connected' && (
                      <button
                        type="button"
                        onClick={() => void disconnect(account)}
                        disabled={busy}
                        className="inline-flex items-center gap-1 rounded bg-amber-50 px-2 py-1.5 text-xs text-amber-700 hover:bg-amber-100 disabled:opacity-50"
                      >
                        <LogOut className="h-3.5 w-3.5" />断开
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => void remove(account)}
                      disabled={busy}
                      className="rounded bg-red-50 p-1.5 text-red-500 hover:bg-red-100 disabled:opacity-50"
                      aria-label={`删除 ${account.accountName}`}
                    >
                      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                    </button>
                  </div>
                </Card>
              );
            })}
          </div>
        )}

        <Card className="p-4">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-900">
            <Plus className="h-4 w-4 text-emerald-600" />新增服务器 WhatsApp 账号
          </h3>
          <div className="mt-3 flex flex-col gap-2 sm:flex-row">
            <input
              value={accountName}
              onChange={(event) => setAccountName(event.target.value)}
              placeholder="账号名称（如：外贸客服）"
              maxLength={80}
              className="flex-1 rounded-lg border px-3 py-2 text-sm outline-none focus:border-emerald-400"
            />
            <input
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              placeholder="预期号码（可选）"
              maxLength={32}
              className="rounded-lg border px-3 py-2 text-sm outline-none focus:border-emerald-400 sm:w-56"
            />
            <button
              type="button"
              onClick={() => void createAccount()}
              disabled={creating || !accountName.trim()}
              className="inline-flex items-center justify-center gap-1 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <QrCode className="h-4 w-4" />}
              创建并扫码
            </button>
          </div>
        </Card>
      </section>

      {isElectron && (
        <section className="space-y-3" aria-labelledby="electron-whatsapp-title">
          <div className="flex items-center gap-2">
            <Laptop className="h-4 w-4 text-blue-600" />
            <h2 id="electron-whatsapp-title" className="font-semibold text-slate-900">桌面 WhatsApp Web 会话</h2>
            <span className="rounded-full bg-blue-50 px-2 py-0.5 text-[10px] text-blue-700">人工操作</span>
          </div>
          <Card className="p-4">
            {electronAccounts.length === 0 ? (
              <p className="text-sm text-slate-400">当前桌面端尚未创建本地 WhatsApp Web 会话。</p>
            ) : (
              <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                {electronAccounts.map((account) => (
                  <div key={account.id} className="flex items-center justify-between rounded-lg border p-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-slate-800">{account.label}</p>
                      <p className="text-[10px] text-slate-400">
                        {account.isActive ? ELECTRON_STATUS[whatsappStatus] : '未激活'}
                      </p>
                    </div>
                    <Link href="/whatsapp/chat" className="text-xs font-medium text-blue-600 hover:underline">
                      打开
                    </Link>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </section>
      )}

      <Card className="border-slate-200 bg-slate-50 p-4 text-xs leading-5 text-slate-600">
        <div className="flex items-start gap-2">
          <ExternalLink className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            Baileys 通道与 Electron 会话是两套独立登录状态。要让 OpenClaw 在 Linux 后端真实收发消息，
            必须至少有一个上方服务器账号显示“已连接”；只登录桌面 WhatsApp Web 不等于后端已获得发送能力。
          </p>
        </div>
      </Card>

      {qrAccount && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/45 p-4" role="dialog" aria-modal="true" aria-label="WhatsApp 扫码登录">
          <Card className="w-full max-w-md p-5 shadow-2xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="font-semibold text-slate-900">扫描服务器 WhatsApp 二维码</h2>
                <p className="mt-1 text-xs text-slate-500">账号：{qrAccount.accountName}</p>
              </div>
              <button type="button" onClick={() => { setQrAccount(null); setQr(null); }} aria-label="关闭扫码窗口">×</button>
            </div>
            <div className="mt-4 flex min-h-72 items-center justify-center rounded-xl border bg-white p-4">
              {qrLoading || !qr ? (
                <div className="text-center text-sm text-slate-400">
                  <Loader2 className="mx-auto mb-2 h-6 w-6 animate-spin" />
                  正在向 Linux Baileys 获取二维码……
                </div>
              ) : qr.status === 'connected' ? (
                <div className="text-center text-emerald-700">
                  <CheckCircle2 className="mx-auto mb-2 h-12 w-12" />
                  <p className="font-semibold">服务器 WhatsApp 已连接</p>
                  <p className="mt-1 text-xs">{qr.phoneNumber || '号码正在同步'}</p>
                </div>
              ) : qr.qrDataUrl ? (
                <div className="text-center">
                  <Image
                    src={qr.qrDataUrl}
                    width={256}
                    height={256}
                    unoptimized
                    alt={`扫描以连接 ${qrAccount.accountName}`}
                    className="mx-auto rounded-lg"
                  />
                  <p className="mt-2 text-xs text-slate-500">WhatsApp 手机端 → 已连接的设备 → 连接设备</p>
                  <p className="mt-1 text-[10px] text-slate-400">本页每 2 秒核验服务器连接状态</p>
                </div>
              ) : (
                <div className="text-center text-amber-700">
                  <AlertCircle className="mx-auto mb-2 h-8 w-8" />
                  <p className="text-sm">服务器尚未返回有效二维码</p>
                  <button
                    type="button"
                    onClick={() => void openQr(qrAccount, true)}
                    className="mt-3 rounded-lg bg-amber-100 px-3 py-2 text-xs font-medium"
                  >
                    重新生成
                  </button>
                </div>
              )}
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
