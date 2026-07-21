'use client';

import Link from 'next/link';
import {
  Bell,
  Copy,
  Handshake,
  Inbox,
  ListChecks,
  Target,
  TrendingUp,
  Users,
} from 'lucide-react';

const modules = [
  {
    href: '/leads',
    title: '客户管理',
    description: '查看客户资料、联系人、标签、跟进记录和客户阶段。',
    icon: Target,
    tone: 'bg-blue-50 text-blue-700',
  },
  {
    href: '/prospects',
    title: '群邮开发池',
    description: '管理未开发、已发轮次、已打开、已点击、已回复客户。',
    icon: Inbox,
    tone: 'bg-green-50 text-green-700',
  },
  {
    href: '/opportunities',
    title: '商机管理',
    description: '按项目和报价推进商机，拖动卡片切换阶段。',
    icon: Handshake,
    tone: 'bg-purple-50 text-purple-700',
  },
  {
    href: '/follow-ups',
    title: '跟进提醒',
    description: '按时间、渠道和优先级查看待处理跟进。',
    icon: Bell,
    tone: 'bg-amber-50 text-amber-700',
  },
  {
    href: '/lead-scores',
    title: '客户评分',
    description: '查看 A/B/C/F 评分和客户匹配度。',
    icon: TrendingUp,
    tone: 'bg-cyan-50 text-cyan-700',
  },
  {
    href: '/duplicate-leads',
    title: '客户查重',
    description: '按邮箱、域名、公司名和联系人合并重复客户。',
    icon: Copy,
    tone: 'bg-red-50 text-red-700',
  },
  {
    href: '/tasks',
    title: '任务中心',
    description: '查看获客、背调、写信、发送任务的执行状态。',
    icon: ListChecks,
    tone: 'bg-gray-100 text-gray-700',
  },
  {
    href: '/users',
    title: '业务员与权限',
    description: '主账号管理业务员账号、角色、数据归属和客户分配。',
    icon: Users,
    tone: 'bg-indigo-50 text-indigo-700',
  },
];

const workflow = [
  '客户获取工作区获得候选客户',
  '主账号分配给业务员',
  '进入群邮开发池做多轮冷邮',
  '打开、点击、回复后进入客户管理',
  '有明确项目后进入商机管理',
  '系统生成提醒、评分和查重建议',
];

export default function CustomerWorkspacePage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">客户管理工作区</h1>
        <p className="mt-1 text-sm text-gray-500">
          将客户、开发池、商机、跟进、评分和查重集中到一个工作区，左侧导航保持简洁。
        </p>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-950">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">推荐业务流程</h2>
        <div className="mt-4 grid gap-3 md:grid-cols-3 xl:grid-cols-6">
          {workflow.map((item, index) => (
            <div key={item} className="rounded-lg border border-gray-100 p-3 text-sm dark:border-gray-800">
              <div className="mb-2 flex h-7 w-7 items-center justify-center rounded-full bg-gray-900 text-xs font-semibold text-white dark:bg-white dark:text-gray-900">
                {index + 1}
              </div>
              <div className="text-gray-700 dark:text-gray-300">{item}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {modules.map((item) => {
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className="rounded-xl border border-gray-200 bg-white p-5 transition hover:-translate-y-0.5 hover:shadow-md dark:border-gray-800 dark:bg-gray-950"
            >
              <div className={`mb-4 inline-flex rounded-lg p-2 ${item.tone}`}>
                <Icon className="h-5 w-5" />
              </div>
              <h3 className="font-semibold text-gray-900 dark:text-white">{item.title}</h3>
              <p className="mt-2 text-sm leading-6 text-gray-500">{item.description}</p>
            </Link>
          );
        })}
      </div>

      <div className="rounded-xl border border-blue-200 bg-blue-50 p-5 text-sm text-blue-800 dark:border-blue-900/50 dark:bg-blue-950/30 dark:text-blue-200">
        邮件相关操作仍统一在“邮件工作台”完成，包括发件箱、收件箱、草稿、群发任务、邮箱账号和邮件模板。
      </div>
    </div>
  );
}
