/**
 * TASK-102H: CompanyInfoPanel
 *
 * 公司信息面板：展示国家、更新时间等元数据。
 */

'use client';

import { MapPin, Clock } from 'lucide-react';

export interface CompanyInfoPanelProps {
  countryIso2: string | null;
  updatedAt: string;
}

export function CompanyInfoPanel({
  countryIso2,
  updatedAt,
}: CompanyInfoPanelProps) {
  return (
    <div
      className="px-3 py-2 border-b space-y-0.5"
      data-testid="company-info-panel"
    >
      {countryIso2 && (
        <div className="flex items-center gap-1 text-[10px] text-gray-500">
          <MapPin className="w-3 h-3" />
          {countryIso2}
        </div>
      )}
      {updatedAt && (
        <div className="flex items-center gap-1 text-[10px] text-gray-400">
          <Clock className="w-3 h-3" />
          更新于 {new Date(updatedAt).toLocaleDateString('zh-CN')}
        </div>
      )}
    </div>
  );
}
