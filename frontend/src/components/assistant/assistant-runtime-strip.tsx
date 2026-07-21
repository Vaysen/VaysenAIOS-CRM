'use client';

import { Bot, Cpu, Loader2, MessageCircle, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AssistantRuntimeSnapshot } from '@/types/assistant-runtime';

type Tone = 'ready' | 'waiting' | 'down' | 'muted';

const toneClasses: Record<'light' | 'dark', Record<Tone, string>> = {
  light: {
    ready: 'border-emerald-200 bg-emerald-50 text-emerald-700',
    waiting: 'border-amber-200 bg-amber-50 text-amber-700',
    down: 'border-red-200 bg-red-50 text-red-700',
    muted: 'border-slate-200 bg-slate-50 text-slate-500',
  },
  dark: {
    ready: 'border-emerald-300/20 bg-emerald-400/10 text-emerald-200',
    waiting: 'border-amber-300/20 bg-amber-400/10 text-amber-100',
    down: 'border-red-300/20 bg-red-400/10 text-red-100',
    muted: 'border-white/10 bg-white/5 text-slate-300',
  },
};

function runtimeLabel(snapshot: AssistantRuntimeSnapshot | null): { label: string; tone: Tone } {
  if (!snapshot) return { label: 'OpenClaw 状态未知', tone: 'muted' };
  const labels = {
    DISABLED: ['OpenClaw 未启用', 'muted'],
    STARTING: ['OpenClaw 启动中', 'waiting'],
    READY: ['OpenClaw 执行在线', 'ready'],
    DEGRADED: ['OpenClaw 部分可用', 'waiting'],
    OFFLINE: ['OpenClaw 执行离线', 'down'],
  } as const;
  const [label, tone] = labels[snapshot.runtime.status];
  return { label, tone };
}

function wechatLabel(snapshot: AssistantRuntimeSnapshot | null): { label: string; tone: Tone } {
  if (!snapshot) return { label: '负责人微信状态未知', tone: 'muted' };
  if (snapshot.wechatOwnerChannel.errorCode === 'CHANNEL_NOT_AUTHORIZED') {
    return { label: '无权限查看负责人微信', tone: 'muted' };
  }
  const labels = {
    NOT_INSTALLED: ['微信插件未安装', 'muted'],
    UNBOUND: ['负责人微信未绑定', 'muted'],
    PAIRING: ['微信绑定准备中', 'waiting'],
    WAITING_SCAN: ['等待终端扫码', 'waiting'],
    AUTHENTICATING: ['微信认证中', 'waiting'],
    CONNECTED: ['负责人微信已连接', 'ready'],
    DISCONNECTED: ['负责人微信已断线', 'down'],
    EXPIRED: ['微信二维码已过期', 'waiting'],
    ERROR: ['负责人微信异常', 'down'],
  } as const;
  const [label, tone] = labels[snapshot.wechatOwnerChannel.status];
  return { label, tone };
}

function StatusPill({
  icon: Icon,
  label,
  tone,
  theme,
  testId,
}: {
  icon: typeof Bot;
  label: string;
  tone: Tone;
  theme: 'light' | 'dark';
  testId: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex min-w-0 items-center gap-1 rounded-full border px-2 py-1 text-[10px] font-medium leading-none',
        toneClasses[theme][tone],
      )}
      data-testid={testId}
      title={label}
    >
      <Icon className="h-3 w-3 shrink-0" />
      <span className="truncate">{label}</span>
    </span>
  );
}

export function AssistantRuntimeStrip({
  snapshot,
  loading,
  error,
  theme = 'light',
  className,
}: {
  snapshot: AssistantRuntimeSnapshot | null;
  loading: boolean;
  error: string | null;
  theme?: 'light' | 'dark';
  className?: string;
}) {
  const runtime = runtimeLabel(snapshot);
  const wechat = wechatLabel(snapshot);
  const modelReady = snapshot?.runtime.gatewayReady === true
    && snapshot.runtime.adapterReady === true
    && snapshot.runtime.modelReady === true;
  return (
    <div
      className={cn('flex min-w-0 flex-wrap items-center gap-1.5', className)}
      aria-label="AI 业务助理运行状态"
      role="status"
    >
      <StatusPill
        icon={Bot}
        label={modelReady ? 'OpenClaw 智谱链路可用' : 'OpenClaw 智谱链路未就绪'}
        tone={modelReady ? 'ready' : snapshot ? 'waiting' : 'muted'}
        theme={theme}
        testId="assistant-model-status"
      />
      <StatusPill
        icon={Cpu}
        label={runtime.label}
        tone={runtime.tone}
        theme={theme}
        testId="assistant-runtime-status"
      />
      <StatusPill
        icon={MessageCircle}
        label={wechat.label}
        tone={wechat.tone}
        theme={theme}
        testId="assistant-wechat-status"
      />
      {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-current opacity-60" />}
      {error && (
        <span
          className={cn(
            'inline-flex items-center gap-1 text-[10px]',
            theme === 'dark' ? 'text-amber-100' : 'text-amber-700',
          )}
          title={error}
        >
          <TriangleAlert className="h-3 w-3" />
          状态刷新失败
        </span>
      )}
    </div>
  );
}

export { runtimeLabel, wechatLabel };
