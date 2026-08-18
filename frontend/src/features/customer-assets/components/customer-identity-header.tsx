/**
 * TASK-102H: CustomerIdentityHeader
 *
 * 客户身份头部：展示公司名（含占位符）+ displayName。
 * 纯展示组件，只接收 typed props。
 */

'use client';

import { Building2 } from 'lucide-react';
import { buildDisplayName } from '../domain/customer-links';

export interface CustomerIdentityHeaderProps {
  companyName: string | null;
  displayName: string;
  countryIso2: string | null;
}

export function CustomerIdentityHeader({
  companyName,
  displayName,
  countryIso2,
}: CustomerIdentityHeaderProps) {
  const displayCompany = buildDisplayName(companyName);
  const isPlaceholder = companyName === null || companyName.trim() === '';

  return (
    <div className="p-3 border-b">
      <div className="flex items-center gap-1.5 mb-1.5">
        <Building2 className="w-3.5 h-3.5 text-gray-400" />
        <h3 className="text-xs font-semibold text-gray-700">客户资料</h3>
      </div>
      <p
        className={`text-sm font-bold ${
          isPlaceholder ? 'text-gray-400 italic' : 'text-gray-900'
        }`}
        data-testid="customer-company-name"
      >
        {displayCompany}
      </p>
      {displayName !== displayCompany && (
        <p className="text-[11px] text-gray-500 mt-0.5">{displayName}</p>
      )}
      {countryIso2 && (
        <p className="text-[10px] text-gray-400 mt-0.5">
          国家/地区: {countryIso2}
        </p>
      )}
    </div>
  );
}
