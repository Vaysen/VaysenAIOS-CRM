'use client';

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import Link from 'next/link';
import { Sidebar } from './sidebar';
import { Header } from './header';
import { useUIStore } from '@/store/uiStore';
import { useAuthStore } from '@/store/authStore';
import { cn } from '@/lib/utils';
import api from '@/lib/api';
import { ArrowLeft, Sparkles, X } from 'lucide-react';
import { BusinessAssistantOrb } from '@/components/assistant/business-assistant-orb';

const POPUP_DISMISSED_KEY_PREFIX = 'vaysen-crm_acquisition_popup_dismissed';

const workspacePages = new Set([
  '/leads', '/prospects', '/opportunities', '/follow-ups',
  '/lead-scores', '/duplicate-leads', '/tasks', '/users',
]);

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { sidebarOpen, setSidebarOpen } = useUIStore();
  const { user } = useAuthStore();
  const [showAutoPopup, setShowAutoPopup] = useState(false);
  const [assignmentNotice, setAssignmentNotice] = useState<{ total: number } | null>(null);
  const showBackToWorkspace = workspacePages.has(pathname);
  const popupKey = user ? `${POPUP_DISMISSED_KEY_PREFIX}_${user.id}_20260610` : POPUP_DISMISSED_KEY_PREFIX;
  const isSalesUser = user?.companies?.some((company) => company.role === 'sales_user') ?? false;

  useEffect(() => {
    const dismissed = localStorage.getItem(popupKey);
    if (!dismissed && user && isSalesUser) {
      const timer = setTimeout(() => setShowAutoPopup(true), 800);
      return () => clearTimeout(timer);
    }
  }, [isSalesUser, popupKey, user]);

  useEffect(() => {
    if (!user || !isSalesUser) return;
    let cancelled = false;
    api.get('/leads/assignment-notices')
      .then((res) => {
        const total = Number(res.data?.total || 0);
        if (!cancelled && total > 0) setAssignmentNotice({ total });
      })
      .catch((error) => { console.error('[Frontend] background operation failed:', error); });
    return () => {
      cancelled = true;
    };
  }, [isSalesUser, user]);

  const dismissAutoPopup = () => {
    setShowAutoPopup(false);
    localStorage.setItem(popupKey, 'true');
  };

  const dismissAssignmentPopup = async () => {
    setAssignmentNotice(null);
    try {
      await api.post('/leads/assignment-notices/read');
    } catch (error) { console.error('[Frontend] operation failed:', error); }
  };

  const isWhatsAppChatPage = pathname === '/whatsapp/chat';
  const isWhatsAppBroadcastPage = pathname === '/whatsapp/broadcast';

  useEffect(() => {
    if (typeof window !== 'undefined' && window.innerWidth < 1024) {
      setSidebarOpen(false);
    }
  }, [setSidebarOpen]);

  // 全局路由监听：离开 WhatsApp 聊天页时隐藏 WebContentsView
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const electronAPI = (window as any).electronAPI;
    if (!electronAPI?.whatsapp?.hideView) return;

    if (!isWhatsAppChatPage && !isWhatsAppBroadcastPage) {
      // 当前不在 WhatsApp 页面，确保视图隐藏
      electronAPI.whatsapp.hideView();
    }
  }, [pathname, isWhatsAppChatPage, isWhatsAppBroadcastPage]);

  return (
    <div className="min-h-screen bg-muted/30 text-foreground">
      <Sidebar />
      <div className={cn('flex min-h-screen min-w-0 flex-col transition-all duration-300', sidebarOpen ? 'ml-16 lg:ml-60' : 'ml-16')}>
        <Header />
        {showBackToWorkspace && (
          <div className="border-b border-border bg-background/90 px-6 py-2 backdrop-blur">
            <Link
              href="/customer-workspace"
              className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4" />
              返回客户管理工作区
            </Link>
          </div>
        )}
        <main className={cn(
          'mx-auto flex min-h-0 w-full max-w-[1800px] flex-1 flex-col',
          // WhatsApp 聊天页和群发页不需要 padding，让 WebContentsView 精确贴合
          (isWhatsAppChatPage || isWhatsAppBroadcastPage) ? 'overflow-hidden p-0' : 'p-5 lg:p-6'
        )}>{children}</main>
      </div>

      {showAutoPopup && (
        <ReminderModal
          title="系统已自动为你获客三轮"
          body="请前往客户获取工作区查看候选客户，转入群邮开发池后继续跑邮件开发任务。"
          primaryHref="/acquisition"
          primaryLabel="前往客户获取工作区"
          onDismiss={dismissAutoPopup}
        />
      )}

      {assignmentNotice && (
        <ReminderModal
          title="主账号已分配新客户"
          body={`已从主账号获取到 ${assignmentNotice.total} 个客户，请开始营销。`}
          primaryHref="/leads"
          primaryLabel="查看客户"
          onDismiss={dismissAssignmentPopup}
        />
      )}
      <BusinessAssistantOrb />
    </div>
  );
}

function ReminderModal({
  title,
  body,
  primaryHref,
  primaryLabel,
  onDismiss,
}: {
  title: string;
  body: string;
  primaryHref: string;
  primaryLabel: string;
  onDismiss: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="relative mx-4 w-full max-w-md rounded-lg border border-border bg-background p-6 shadow-2xl">
        <button
          onClick={onDismiss}
          className="absolute right-3 top-3 text-gray-400 hover:text-gray-600"
          aria-label="关闭提醒"
        >
          <X className="h-5 w-5" />
        </button>
        <div className="text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-lg bg-muted">
            <Sparkles className="h-6 w-6 text-foreground" />
          </div>
          <h2 className="text-lg font-semibold text-foreground">{title}</h2>
          <p className="mt-2 text-sm text-muted-foreground">{body}</p>
          <div className="mt-4 flex justify-center gap-3">
            <a
              href={primaryHref}
              onClick={onDismiss}
              className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
            >
              {primaryLabel}
            </a>
            <button
              onClick={onDismiss}
              className="rounded-lg border border-border px-4 py-2 text-sm text-foreground hover:bg-muted"
            >
              知道了
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
