'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  ChevronLeft,
  LayoutDashboard,
  Users,
  Mail,
  MessageCircle,
  Package,
  FileText,
  ShoppingCart,
  SearchCheck,
  Sparkles,
  BarChart3,
  Settings,
  Rocket,
  Gauge,
  Megaphone,
  PhoneCall,
  Handshake,
} from 'lucide-react';
import { useUIStore } from '@/store/uiStore';
import { cn } from '@/lib/utils';
import { RELEASE_FEATURES } from '@/config/release-features';
import { useAuthStore } from '@/store/authStore';

interface NavGroup {
  label: string;
  items: NavItem[];
}

interface NavItem {
  href: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  badge?: string;
}

type SalesAutomationFeatures = {
  salesAutomation: boolean;
  salesSequencesManagement: boolean;
  customerFactsReview: boolean;
};

export function buildSalesAutomationItems(
  role: string | undefined,
  features: SalesAutomationFeatures = RELEASE_FEATURES,
): NavItem[] {
  const canManage = !!role
    && ['sales_manager', 'company_admin', 'super_admin'].includes(role);
  if (!features.salesAutomation || !canManage) return [];
  // 销售序列 / Customer Facts 为后端能力，不在前端导航展示（R110 收敛）
  return [];
}

const baseNavGroups: NavGroup[] = [
  {
    label: '工作台',
    items: [
      { href: '/', label: '首页', icon: LayoutDashboard },
      { href: '/executive', label: '驾驶舱', icon: Gauge, badge: 'new' },
      { href: '/customers', label: '客户资产', icon: Users },
    ],
  },
  {
    label: 'WhatsApp',
    items: [
      { href: '/whatsapp/chat', label: '聊天', icon: MessageCircle },
      ...(RELEASE_FEATURES.aiVoiceCustomerService
        ? [{ href: '/voice-service', label: 'AI 语音客服', icon: PhoneCall, badge: '新' }]
        : []),
    ],
  },
  {
    label: '邮件',
    items: [
      { href: '/emails', label: '邮件中心', icon: Mail },
      { href: '/email-accounts', label: '邮箱账号', icon: Mail },
    ],
  },
  {
    label: '交易与产品',
    items: [
      { href: '/products', label: '产品资料', icon: Package },
      { href: '/quotes', label: '报价/PI', icon: FileText },
      { href: '/orders', label: '订单中心', icon: ShoppingCart },
      { href: '/opportunities', label: '正式商机', icon: Handshake },
    ],
  },
  {
    label: '销售自动化',
    items: [],
  },
  {
    label: '增长与智能',
    items: [
      { href: '/acquisition', label: '获客开发', icon: SearchCheck },
      { href: '/ai-workbench', label: 'AI 业务助理', icon: Sparkles },
      { href: '/analytics', label: '数据分析', icon: BarChart3 },
      { href: '/audience-segments', label: '客群管理', icon: Users, badge: 'new' },
      { href: '/marketing-campaigns', label: '营销活动', icon: Megaphone, badge: 'new' },
    ],
  },
  {
    label: '系统',
    items: [
      { href: '/settings', label: '系统设置', icon: Settings },
      { href: '/future', label: '后期能力', icon: Rocket, badge: '即将' },
    ],
  },
];

export function Sidebar() {
  const pathname = usePathname();
  const { sidebarOpen, toggleSidebar } = useUIStore();
  const { user, activeCompanyId } = useAuthStore();
  const activeMembership = user?.companies?.find((company) => company.id === activeCompanyId) || user?.companies?.[0];
  const navGroups = baseNavGroups.map((group) => group.label === '销售自动化'
    ? { ...group, items: buildSalesAutomationItems(activeMembership?.role) }
    : group).filter((group) => group.items.length > 0);

  return (
    <aside
      className={cn(
        'fixed left-0 top-0 z-40 flex h-screen flex-col border-r border-border bg-background transition-all duration-300',
        sidebarOpen ? 'w-60' : 'w-16',
      )}
    >
      {/* Brand */}
      <div className="flex h-16 items-center justify-between border-b border-border px-4 shrink-0">
        {sidebarOpen && (
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-[10px] font-bold text-primary-foreground">
              JY
            </div>
            <span className="text-sm font-bold text-foreground">Vaysen</span>
          </div>
        )}
        <button
          onClick={toggleSidebar}
          className={cn(
            'rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground',
            !sidebarOpen && 'mx-auto',
          )}
          aria-label="切换侧边栏"
        >
          <ChevronLeft className={cn('h-4 w-4 transition-transform', !sidebarOpen && 'rotate-180')} />
        </button>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-2 px-2 space-y-4">
        {navGroups.map((group) => (
          <div key={group.label}>
            {sidebarOpen && (
              <p className="mb-1 px-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
                {group.label}
              </p>
            )}
            <div className="flex flex-col gap-0.5">
              {group.items.map((item) => {
                const isActive = pathname === item.href || (item.href !== '/' && pathname.startsWith(item.href));
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    prefetch={false}
                    className={cn(
                      'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm font-medium transition-colors',
                      isActive
                        ? 'bg-muted text-foreground'
                        : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                      !sidebarOpen && 'justify-center px-2',
                    )}
                    title={sidebarOpen ? undefined : item.label}
                  >
                    <item.icon className="h-4 w-4 shrink-0" />
                    {sidebarOpen && (
                      <>
                        <span className="flex-1 truncate">{item.label}</span>
                        {item.badge && (
                          <span className="ml-auto rounded bg-muted-foreground/15 px-1.5 py-0.5 text-[9px] font-semibold text-muted-foreground">
                            {item.badge}
                          </span>
                        )}
                      </>
                    )}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* Footer */}
      {sidebarOpen && (
        <div className="border-t border-border px-4 py-3 shrink-0">
          <p className="text-[10px] text-muted-foreground/50">Vaysen Trade OS v2.0</p>
        </div>
      )}
    </aside>
  );
}
