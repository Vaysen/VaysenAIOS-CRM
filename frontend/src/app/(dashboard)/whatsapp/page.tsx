'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/**
 * WhatsApp 模块入口 —— 重定向到聊天页面。
 *
 * 原先的单页管理已拆分为三个子页面：
 *  - /whatsapp/accounts  账号管理
 *  - /whatsapp/chat      聊天接待
 *  - /whatsapp/broadcast 群发营销
 */
export default function WhatsAppRedirect() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/whatsapp/chat');
  }, [router]);

  return null;
}
