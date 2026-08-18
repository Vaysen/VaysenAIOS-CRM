'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useAuthStore } from '@/store/authStore';
import { useT } from '@/i18n/use-translation';
import { LanguageSwitcher } from '@/i18n/language-switcher';
import { Button } from '@/components/ui/button';
import api from '@/lib/api';
import { ArrowLeft, Bell, Building2, CheckCircle2, LogOut, User, X } from 'lucide-react';

interface Notice {
  id: string;
  title: string;
  body: string;
  time: Date;
  read: boolean;
}

const QUEUE_LABELS: Record<string, string> = {
  'email-compose': 'AI 写开发信',
  'email-send': '群邮发送',
  'prospect-search': 'AI 获客',
  'deep-research': 'AI 深度背调',
};

export function Header() {
  const router = useRouter();
  const pathname = usePathname();
  const { user, activeCompanyId, setActiveCompany, logout } = useAuthStore();
  const { t } = useT();

  const showBack = pathname !== '/' && pathname !== '/login' && pathname !== '/register';
  const appName = process.env.NEXT_PUBLIC_APP_NAME || 'Vaysen Trade OS';
  const [open, setOpen] = useState(false);
  const [notices, setNotices] = useState<Notice[]>([]);
  const previousRef = useRef<Record<string, any> | null>(null);

  const pushNotice = (title: string, body: string) => {
    setNotices((items) => [
      { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, title, body, time: new Date(), read: false },
      ...items,
    ].slice(0, 20));
  };

  useEffect(() => {
    if (!user) return;

    const poll = async () => {
      try {
        const [queueRes, searchRes] = await Promise.allSettled([
          api.get('/queues/status'),
          api.get('/search/tasks'),
        ]);
        const queues = queueRes.status === 'fulfilled' ? queueRes.value.data?.data?.queues || [] : [];
        const emailWorkflow = queueRes.status === 'fulfilled' ? queueRes.value.data?.data?.emailWorkflow || {} : {};
        const tasks = searchRes.status === 'fulfilled' ? searchRes.value.data || [] : [];
        const snapshot: Record<string, any> = {
          active: Object.fromEntries(queues.map((queue: any) => [queue.name, queue.active])),
          waiting: Object.fromEntries(queues.map((queue: any) => [queue.name, queue.waiting + queue.delayed])),
          emailWorkflow,
          completedTasks: tasks.filter((task: any) => task.status === 'completed').slice(0, 5).map((task: any) => ({
            id: task.id,
            totalFound: task.totalFound,
            maxResults: task.maxResults,
            completedAt: task.completedAt,
          })),
        };

        const previous = previousRef.current;
        if (previous) {
          for (const queue of queues) {
            const label = QUEUE_LABELS[queue.name] || queue.name;
            const prevActive = previous.active?.[queue.name] || 0;
            const prevWaiting = previous.waiting?.[queue.name] || 0;
            if (prevActive === 0 && queue.active > 0) {
              pushNotice(`${label}开始了`, `当前有 ${queue.active} 个任务正在执行。`);
            }
            if (prevWaiting === 0 && queue.waiting + queue.delayed > 0) {
              pushNotice(`${label}已进入队列`, `等待/延迟任务 ${queue.waiting + queue.delayed} 个。`);
            }
          }

          const sentNow = emailWorkflow.sent || 0;
          const failedNow = emailWorkflow.failed || 0;
          const sentPrev = previous.emailWorkflow?.sent || 0;
          const failedPrev = previous.emailWorkflow?.failed || 0;
          if (sentNow > sentPrev || failedNow > failedPrev) {
            pushNotice('群邮任务有新进展', `成功发信 ${Math.max(0, sentNow - sentPrev)} 封，失败 ${Math.max(0, failedNow - failedPrev)} 封。`);
          }

          for (const task of snapshot.completedTasks) {
            const old = previous.completedTasks?.find((item: any) => item.id === task.id);
            if (!old && task.completedAt) {
              pushNotice('AI 获客任务结束了', `本次获取到 ${task.totalFound || 0}/${task.maxResults || 0} 个客户。`);
            }
          }
        }

        previousRef.current = snapshot;
      } catch (error) {
        console.error('[Header] notification polling failed:', error);
      }
    };

    poll();
    const timer = window.setInterval(poll, 10000);
    return () => window.clearInterval(timer);
  }, [user]);

  const unreadCount = notices.filter((item) => !item.read).length;
  const openNotices = () => {
    setOpen((value) => !value);
    setNotices((items) => items.map((item) => ({ ...item, read: true })));
  };

  const displayName = [user?.firstName, user?.lastName].filter(Boolean).join(' ');

  return (
    <header className="sticky top-0 z-30 flex h-16 min-w-0 items-center justify-between border-b border-border bg-background/95 px-3 backdrop-blur sm:px-6">
      <div className="flex min-w-0 items-center gap-2 sm:gap-3">
        {showBack && (
          <button
            onClick={() => router.back()}
            className="flex items-center justify-center h-9 w-9 rounded-lg border border-gray-200 text-gray-500 hover:bg-gray-100 hover:text-gray-700 transition-colors"
            aria-label="返回上一页"
            title="返回上一页"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
        )}
        <img src="/logo.png" alt="Logo" className="h-9 w-9 shrink-0 rounded-lg object-cover" />
        <div className="hidden min-w-0 lg:block">
          <h1 className="max-w-[220px] truncate whitespace-nowrap text-lg font-semibold text-foreground">{appName}</h1>
          <p className="max-w-[220px] truncate whitespace-nowrap text-xs text-muted-foreground">
            {displayName || user?.email || ''}
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 sm:gap-4">
        {user?.companies && user.companies.length > 1 && (
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <Building2 className="h-4 w-4" />
            <select
              value={activeCompanyId || ''}
              onChange={(event) => setActiveCompany(event.target.value)}
              className="h-9 rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none hover:bg-muted focus:border-ring"
              title="项目空间"
            >
              {!activeCompanyId && (
                <option value="" disabled>
                  Select company
                </option>
              )}
              {user.companies.map((company) => (
                <option key={company.id} value={company.id}>
                  {company.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <LanguageSwitcher />
        <div className="relative">
          <button
            type="button"
            onClick={openNotices}
            className="relative inline-flex h-9 w-9 items-center justify-center rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-gray-800 dark:text-gray-300 dark:hover:bg-gray-900"
            aria-label="消息提醒"
            title="消息提醒"
          >
            <Bell className="h-4 w-4" />
            {unreadCount > 0 && (
              <span className="absolute -right-1 -top-1 min-w-5 rounded-full bg-red-600 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                {unreadCount > 9 ? '9+' : unreadCount}
              </span>
            )}
          </button>
          {open && (
            <div className="absolute right-0 top-11 z-50 w-80 rounded-xl border border-gray-200 bg-white shadow-lg dark:border-gray-800 dark:bg-gray-950">
              <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3 dark:border-gray-800">
                <div className="font-medium text-gray-900 dark:text-white">消息提醒</div>
                <button type="button" aria-label="关闭消息提醒" onClick={() => setOpen(false)} className="text-gray-400 hover:text-gray-600">
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="max-h-96 overflow-y-auto p-3">
                {notices.length === 0 ? (
                  <div className="flex items-center gap-2 rounded-lg bg-gray-50 p-3 text-sm text-gray-500 dark:bg-gray-900">
                    <CheckCircle2 className="h-4 w-4 text-green-600" />
                    暂无新消息
                  </div>
                ) : (
                  notices.map((notice) => (
                    <div key={notice.id} className="mb-2 rounded-lg border border-gray-100 p-3 text-sm dark:border-gray-800">
                      <div className="font-medium text-gray-900 dark:text-white">{notice.title}</div>
                      <div className="mt-1 text-gray-600 dark:text-gray-300">{notice.body}</div>
                      <div className="mt-2 text-xs text-gray-400">{notice.time.toLocaleString()}</div>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </div>
        <div className="hidden items-center gap-2 text-sm text-gray-600 dark:text-gray-300 lg:flex">
          <User className="h-4 w-4" />
          {user?.email || '未登录'}
        </div>
        <Button variant="outline" size="sm" onClick={logout} aria-label="退出登录" className="px-2 sm:px-3">
          <LogOut className="h-4 w-4 sm:mr-2" />
          <span className="hidden sm:inline">{t('common.logout')}</span>
        </Button>
      </div>
    </header>
  );
}
