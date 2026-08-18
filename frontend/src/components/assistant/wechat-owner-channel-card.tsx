'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  CheckCircle2,
  Clock3,
  Copy,
  Cpu,
  Loader2,
  MessageCircle,
  QrCode,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AssistantRuntimeSnapshot } from '@/types/assistant-runtime';
import { runtimeLabel, wechatLabel } from './assistant-runtime-strip';
import {
  startWechatOwnerPairing,
  waitWechatOwnerPairing,
  type WechatPairingStartResult,
} from '@/lib/assistant-runtime-api';

const WECHAT_LOGIN_COMMAND = 'bash scripts/openclaw-weixin-login.sh';

const CAPABILITY_LABELS: Record<string, string> = {
  'openclaw.crm_chat': 'CRM 对话协作',
  'crm.work_brief': '工作简报',
  'crm.customer_search': '客户检索（只读）',
  'crm.start_background_research': '客户背调',
  'crm.prepare_quote_delivery': '准备报价交付',
  'wechat.owner_control': '负责人微信受控操作',
  'external.confirmed_send': '单次确认外发',
};

Object.assign(CAPABILITY_LABELS, {
  'crm.customer_get': '客户详情',
  'crm.customer_add_note': '新增客户备注',
  'crm.customer_update': '更新客户资料',
  'crm.customer_set_stage': '更新客户阶段',
  'crm.task_create': '创建跟进待办',
  'crm.order_list': '查询客户订单',
  'crm.order_create_draft': '创建订单草稿',
  'crm.order_update_stage': '更新订单阶段',
  'crm.quote_list': '查询客户报价',
  'crm.quote_create_draft': '创建美元报价草稿',
  'crm.product_search': '查询产品美元价格',
});

function formatTime(value?: string | null) {
  if (!value) return '—';
  return new Date(value).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function toneTextClass(tone: ReturnType<typeof runtimeLabel>['tone']) {
  if (tone === 'ready') return 'text-emerald-700';
  if (tone === 'down') return 'text-red-700';
  if (tone === 'muted') return 'text-slate-500';
  return 'text-amber-700';
}

export function WechatOwnerChannelCard({
  companyId,
  snapshot,
  loading,
  error,
  onRefresh,
  compact = false,
}: {
  companyId?: string;
  snapshot: AssistantRuntimeSnapshot | null;
  loading: boolean;
  error: string | null;
  onRefresh?: () => void;
  compact?: boolean;
}) {
  const [pairing, setPairing] = useState<WechatPairingStartResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [pairingLoading, setPairingLoading] = useState(false);
  const [pairingError, setPairingError] = useState<string | null>(null);
  const runtime = runtimeLabel(snapshot);
  const wechat = wechatLabel(snapshot);
  const channel = snapshot?.wechatOwnerChannel;
  const permissions = snapshot?.permissions;
  const channelNotAuthorized = channel?.errorCode === 'CHANNEL_NOT_AUTHORIZED';
  const waitingForTerminal = channel
    ? !channelNotAuthorized && ['PAIRING', 'WAITING_SCAN', 'AUTHENTICATING'].includes(channel.status)
    : false;
  const knownCapabilities = (snapshot?.capabilities || [])
    .filter((item) => CAPABILITY_LABELS[item.id] && item.status !== 'DISABLED');
  const showBindingEntry = !channelNotAuthorized
    && permissions?.canManageChannel === true
    && channel?.status !== 'CONNECTED';

  const startPairing = async () => {
    if (!companyId || pairingLoading) return;
    setPairingLoading(true);
    setPairingError(null);
    try {
      setPairing(await startWechatOwnerPairing(companyId));
    } catch (pairingFailure: unknown) {
      setPairingError(pairingFailure instanceof Error ? pairingFailure.message : '无法启动微信扫码');
    } finally {
      setPairingLoading(false);
    }
  };

  const copyLoginCommand = async () => {
    try {
      await navigator.clipboard.writeText(WECHAT_LOGIN_COMMAND);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch {
      setCopied(false);
    }
  };

  useEffect(() => {
    if (!companyId || !pairing || !['WAITING_SCAN', 'AUTHENTICATING'].includes(pairing.status)) return undefined;
    let cancelled = false;
    let timer: number | null = null;
    const poll = async () => {
      try {
        const result = await waitWechatOwnerPairing(companyId, pairing.pairingId);
        if (cancelled) return;
        if (result.status === 'CONNECTED_PENDING_MESSAGE') {
          setPairing((current) => current
            ? { ...current, status: 'CONNECTED_PENDING_MESSAGE', expiresAt: result.expiresAt }
            : current);
          onRefresh?.();
          return;
        }
        if (result.status === 'AUTHENTICATING') {
          setPairing((current) => current
            ? { ...current, status: 'AUTHENTICATING', expiresAt: result.expiresAt }
            : current);
        }
        if (result.status === 'EXPIRED') {
          setPairing(null);
          setPairingError('二维码已过期，请重新生成');
          return;
        }
        timer = window.setTimeout(() => void poll(), 1_500);
      } catch (pollFailure: unknown) {
        if (!cancelled) {
          setPairingError(pollFailure instanceof Error ? pollFailure.message : '检查扫码状态失败');
        }
      }
    };
    timer = window.setTimeout(() => void poll(), 500);
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [companyId, onRefresh, pairing]);

  return (
    <section
      className={cn(
        'overflow-hidden rounded-xl border border-slate-200 bg-white',
        compact ? 'text-[11px]' : 'text-sm',
      )}
      aria-label="OpenClaw 与负责人微信状态"
      data-testid="wechat-owner-channel-card"
    >
      <div className={cn('flex items-start justify-between gap-3 border-b bg-slate-50', compact ? 'p-3' : 'p-4')}>
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-100 text-indigo-700">
            <Cpu className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <h3 className={cn('font-semibold text-slate-900', !compact && 'text-base')}>
              OpenClaw 执行内核
            </h3>
            <p className="mt-0.5 text-xs text-slate-500">
              JY AI 业务助理的业务主管执行引擎
            </p>
          </div>
        </div>
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="rounded-lg border bg-white p-2 text-slate-500 hover:bg-slate-100 disabled:opacity-50"
            aria-label="刷新 AI 执行内核状态"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </button>
        )}
      </div>

      <div className={cn('space-y-3', compact ? 'p-3' : 'p-4')}>
        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-800">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="grid gap-2 sm:grid-cols-2">
          <div className="rounded-lg border bg-slate-50 p-3">
            <div className="flex items-center gap-2 text-xs font-medium text-slate-700">
              <Cpu className="h-3.5 w-3.5" /> 执行状态
            </div>
            <p className={cn('mt-1 font-semibold', toneTextClass(runtime.tone))}>
              {runtime.label}
            </p>
            {snapshot && (
              <p className="mt-1 text-[10px] text-slate-400">
                最近心跳：{formatTime(snapshot.runtime.lastHeartbeatAt)}
              </p>
            )}
          </div>
          <div className="rounded-lg border bg-slate-50 p-3">
            <div className="flex items-center gap-2 text-xs font-medium text-slate-700">
              <MessageCircle className="h-3.5 w-3.5" /> 负责人微信
            </div>
            <p className={cn('mt-1 font-semibold', toneTextClass(wechat.tone))}>
              {wechat.label}
            </p>
            {!channelNotAuthorized && channel?.binding && (
              <p className="mt-1 text-[10px] text-slate-500">
                {channel.binding.displayName} · {channel.binding.maskedAccount}
              </p>
            )}
          </div>
        </div>

        {waitingForTerminal && (
          <div className="flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs leading-5 text-blue-800">
            <Clock3 className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-semibold">
                {channel?.status === 'AUTHENTICATING' ? '已扫码，正在完成身份认证' : '请在当前页面扫描二维码'}
              </p>
              <p className="mt-1">
                二维码只在当前登录的管理员页面短暂显示，不写入浏览器存储或业务日志。
              </p>
              {channel?.pairingExpiresAt && channel.status !== 'AUTHENTICATING' && (
                <p className="mt-1 text-[10px]">本次扫码截止：{formatTime(channel.pairingExpiresAt)}</p>
              )}
            </div>
          </div>
        )}

        {channelNotAuthorized && (
          <div
            className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs leading-5 text-slate-500"
            data-testid="wechat-channel-not-authorized"
          >
            无权限查看负责人微信。当前账号仍可使用已授权的 AI 业务助理能力；微信绑定信息仅负责人和通道管理员可见。
          </div>
        )}

        {!channelNotAuthorized && channel?.status === 'UNBOUND' && (
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs leading-5 text-slate-600">
            {permissions?.canManageChannel
              ? '管理员可直接在当前页面生成二维码并完成负责人微信绑定。'
              : '负责人微信尚未绑定。如需启用，请联系有通道管理权限的管理员。'}
          </div>
        )}

        {showBindingEntry && compact && companyId && (
          <div
            className="rounded-lg border border-emerald-200 bg-emerald-50 p-3"
            data-testid="wechat-binding-entry-compact"
          >
            {!pairing ? (
              <button
                type="button"
                onClick={() => void startPairing()}
                disabled={pairingLoading}
                className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {pairingLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <QrCode className="h-4 w-4" />}
                {pairingLoading ? '正在生成二维码…' : '生成负责人微信二维码'}
              </button>
            ) : pairing.status === 'WAITING_SCAN' && pairing.qrDataUrl ? (
              <div className="flex flex-col items-center">
                <img
                  src={pairing.qrDataUrl}
                  alt="负责人微信登录二维码"
                  className="h-44 w-44 rounded-lg border bg-white object-contain p-2"
                  data-testid="wechat-owner-qr-code-compact"
                />
                <p className="mt-2 text-center text-[10px] text-emerald-800">请用负责人微信扫码并在手机确认</p>
              </div>
            ) : (
              <p className="text-center text-xs font-semibold text-emerald-800">
                {pairing.status === 'AUTHENTICATING' ? '扫码成功，正在安全登记负责人身份…' : '负责人微信绑定完成，可以直接发送命令'}
              </p>
            )}
            <Link
              href="/settings#assistant-wechat-binding"
              className="mt-2 block text-center text-[10px] text-emerald-700 underline"
            >
              查看完整绑定状态
            </Link>
          </div>
        )}

        {pairingError && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-xs text-red-700" role="alert">
            {pairingError}
          </div>
        )}

        {showBindingEntry && !compact && companyId && (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50/70 p-4" data-testid="wechat-binding-entry">
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-600 text-white">
                <QrCode className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-emerald-950">负责人微信扫码绑定</p>
                <p className="mt-1 text-xs leading-5 text-emerald-800">
                  二维码只在当前登录的管理员页面显示，不写入浏览器存储，也不会出现在日志中。
                </p>
              </div>
            </div>
            {!pairing ? (
              <button
                type="button"
                onClick={() => void startPairing()}
                disabled={pairingLoading}
                className="mt-4 inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-600 px-4 py-2.5 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                aria-label="生成负责人微信二维码"
              >
                {pairingLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <QrCode className="h-4 w-4" />}
                {pairingLoading ? '正在连接微信…' : '生成微信扫码二维码'}
              </button>
            ) : pairing.status === 'WAITING_SCAN' && pairing.qrDataUrl ? (
              <div className="mt-4 flex flex-col items-center rounded-xl border bg-white p-4 sm:items-start">
                <img
                  src={pairing.qrDataUrl}
                  alt="负责人微信登录二维码"
                  className="h-56 w-56 rounded-lg border bg-white object-contain p-2"
                  data-testid="wechat-owner-qr-code"
                />
                <p className="mt-3 text-xs text-slate-600">请用负责人微信扫码并在手机上确认登录。</p>
                <p className="mt-1 text-[10px] text-slate-400">有效期至 {formatTime(pairing.expiresAt)}</p>
              </div>
            ) : (
              <div className="mt-4 rounded-lg border border-emerald-200 bg-white p-3 text-xs leading-5 text-emerald-800">
                <p className="font-semibold">
                  {pairing.status === 'AUTHENTICATING' ? '扫码登录成功，正在登记' : '负责人微信绑定完成'}
                </p>
                <p className="mt-1">
                  {pairing.status === 'AUTHENTICATING'
                    ? '系统正在写入脱敏身份锚点，请稍候。'
                    : '现在可以直接在负责人微信里向业务助理发送命令。'}
                </p>
              </div>
            )}
          </div>
        )}

        {showBindingEntry && !compact && !companyId && (
          <div
            className="rounded-xl border border-emerald-200 bg-emerald-50/70 p-4"
            data-testid="wechat-binding-entry"
          >
            <div className="flex items-start gap-3">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-emerald-600 text-white">
                <QrCode className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-emerald-950">负责人微信扫码绑定</p>
                <p className="mt-1 text-xs leading-5 text-emerald-800">
                  入口已经就绪。二维码由腾讯微信插件在受控 Linux 终端直接显示，CRM 只读取脱敏后的绑定状态。
                </p>
              </div>
            </div>
            <ol className="mt-3 grid gap-2 text-xs text-slate-700 sm:grid-cols-3">
              <li className="rounded-lg border bg-white p-2.5"><b>1.</b> SSH 登录后端 Linux</li>
              <li className="rounded-lg border bg-white p-2.5"><b>2.</b> 在发布目录运行安全扫码命令</li>
              <li className="rounded-lg border bg-white p-2.5"><b>3.</b> 手机确认后回本页刷新</li>
            </ol>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <code className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-slate-950 px-3 py-2.5 text-xs text-emerald-300">
                {WECHAT_LOGIN_COMMAND}
              </code>
              <button
                type="button"
                onClick={() => void copyLoginCommand()}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-emerald-300 bg-white px-3 py-2 text-xs font-semibold text-emerald-800 hover:bg-emerald-100"
              >
                <Copy className="h-3.5 w-3.5" />
                {copied ? '已复制' : '复制扫码命令'}
              </button>
              {onRefresh && (
                <button
                  type="button"
                  onClick={onRefresh}
                  disabled={loading}
                  className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
                >
                  {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                  我已扫码，刷新状态
                </button>
              )}
            </div>
            <p className="mt-2 text-[10px] leading-4 text-slate-500">
              不要截图或转发二维码。只有配置的负责人账号和一对一私聊可以调用 CRM 工具，群聊及其他微信会被拒绝。
            </p>
          </div>
        )}

        {!channelNotAuthorized && channel?.status === 'CONNECTED' && channel.binding && (
          <div className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-xs text-emerald-800">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p className="font-semibold">负责人身份已由后端确认</p>
              <p className="mt-1">绑定于 {formatTime(channel.binding.boundAt)} · 最近在线 {formatTime(channel.binding.lastSeenAt)}</p>
            </div>
          </div>
        )}

        <div className="rounded-lg border border-indigo-100 bg-indigo-50/50 p-3">
          <div className="flex items-center gap-2 text-xs font-semibold text-indigo-950">
            <ShieldCheck className="h-4 w-4" /> 当前权限边界
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {knownCapabilities.length ? knownCapabilities.map((item) => (
              <span
                key={item.id}
                className={cn(
                  'rounded-full border px-2 py-1 text-[10px]',
                  item.status === 'APPROVAL_REQUIRED'
                    ? 'border-amber-200 bg-amber-50 text-amber-700'
                    : item.status === 'DISABLED'
                      ? 'border-slate-200 bg-slate-100 text-slate-600'
                      : 'border-indigo-200 bg-white text-indigo-700',
                )}
              >
                {CAPABILITY_LABELS[item.id]}
                {item.status === 'APPROVAL_REQUIRED'
                  ? ' · 需确认'
                  : item.status === 'DISABLED'
                    ? ' · 已关闭'
                    : ''}
              </span>
            )) : (
              <span className="text-[10px] text-slate-500">后端尚未开放可执行能力</span>
            )}
          </div>
          <p className="mt-2 text-[10px] leading-4 text-slate-500">
            已启用主管执行模式：客户、订单、待办、报价、背调可直接执行；WhatsApp 与邮件外发由当前操作者单次确认后真实发送。部署、密钥及任意 Shell/SQL 不对业务助理开放。
          </p>
        </div>
      </div>
    </section>
  );
}
