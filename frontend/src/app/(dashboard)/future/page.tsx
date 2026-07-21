import { Metadata } from 'next';
import { Rocket, RefreshCw, Palette, Puzzle } from 'lucide-react';
import { ModulePage } from '@/components/shared/module-page';

export const metadata: Metadata = { title: '后期能力 — 示例贸易' };

export default function FuturePage() {
  return (
    <ModulePage
      title="后期能力规划"
      description="示例贸易外贸系统后续版本的功能路线图。"
      isEmpty
      emptyState={
        <div>
          <div className="w-12 h-12 mx-auto mb-3 rounded-xl bg-gray-100 flex items-center justify-center"><Rocket className="w-6 h-6 text-gray-500"/></div>
          <p className="text-sm font-medium text-gray-700">路线图</p>
          <div className="mt-4 space-y-3 text-left max-w-md mx-auto">
            {[
              { icon: RefreshCw, title: 'ERP 双向同步', desc: '与工厂 ERP 实时同步库存、生产和发货数据。' },
              { icon: Palette, title: '3D 定制包装设计器', desc: '客户在线实时预览定制包装效果。' },
              { icon: Puzzle, title: '独立站组件库', desc: 'example.com 可复用的产品目录、询盘表单和客户门户组件。' },
            ].map((item) => (
              <div key={item.title} className="flex gap-3 p-3 bg-gray-50 rounded-lg">
                <item.icon className="w-5 h-5 text-gray-500 shrink-0"/>
                <div>
                  <p className="text-sm font-medium text-gray-800">{item.title}</p>
                  <p className="text-xs text-gray-500 mt-0.5">{item.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      }
      futureNote="以上功能均处于规划阶段，尚未开始实现。优先级和时间安排将根据业务需求确定。"
    />
  );
}
