'use client';

import { MailThreeColumn } from '@/components/email/mail-three-column';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  FileText,
  Mail,
  Send,
  Settings,
  Sparkles,
  ArrowRight,
} from 'lucide-react';
import api from '@/lib/api';
import { OwnerNotificationStatusPill } from '@/components/assistant/owner-notification-status';

export default function EmailsPage() {
  const [mailSummary, setMailSummary] = useState<any>({});

  useEffect(() => {
    api.get('/mail-workbench/summary').then(r => setMailSummary(r.data || {})).catch((error) => { console.error('[Frontend] background operation failed:', error); });
  }, []);

  return (
    <div className="h-[calc(100vh-65px)] -m-5 lg:-m-6 flex flex-col">
      {/* Header bar */}
      <div className="flex items-center justify-between px-4 h-12 border-b bg-white shrink-0">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-bold text-gray-900">邮件工作台</h2>
          <span className="text-[10px] bg-purple-50 text-purple-700 px-1.5 py-0.5 rounded-full font-medium">商务邮件 +AI</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-slate-500">收件 {Number(mailSummary.inbox || 0)}</span>
          <OwnerNotificationStatusPill compact />
          <Link href="/email-accounts" className="text-[11px] text-gray-400 hover:text-gray-600 flex items-center gap-1">
            <Settings className="w-3 h-3" /> 邮箱账号
          </Link>
          <Link href="/email-templates" className="text-[11px] text-gray-400 hover:text-gray-600 flex items-center gap-1">
            <FileText className="w-3 h-3" /> 邮件模板
          </Link>
          <Link href="/emails/send" className="text-[11px] text-gray-400 hover:text-gray-600 flex items-center gap-1">
            <Send className="w-3 h-3" /> 写信/群发
          </Link>
          <Link href="/communication" className="text-[11px] text-purple-600 hover:text-purple-800 flex items-center gap-1 font-medium">
            <Sparkles className="w-3 h-3" /> 沟通中心
          </Link>
          <Link
            href="/acquisition"
            className="text-[10px] text-blue-500 hover:underline ml-2 flex items-center gap-1"
            title="营销群发监控已迁移至获客开发"
          >
            <ArrowRight className="w-3 h-3" /> 群邮监控
          </Link>
        </div>
      </div>

      {/* Migration note banner */}
      <div className="px-4 py-1.5 bg-blue-50 border-b border-blue-100 text-[10px] text-blue-600 flex items-center gap-1.5 shrink-0">
        <ArrowRight className="w-3 h-3" />
        营销群发监控已迁移至 <Link href="/acquisition" className="font-medium underline">获客开发</Link>。当前页面为商务邮件一对一沟通工作台。
      </div>

      {/* Mail three-column workbench */}
      <div className="flex-1 overflow-hidden">
        <MailThreeColumn />
      </div>
    </div>
  );
}
