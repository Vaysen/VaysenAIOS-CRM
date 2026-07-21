'use client';

import { useState, useCallback } from 'react';
import { RegistrationForm } from '@/features/auth/registration';
import type { RegistrationValues } from '@/features/auth/registration';

/**
 * 注册 Demo 页（E2E 测试用）
 *
 * 使用纯 RegistrationForm 组件 + 模拟 API 调用。
 */
export default function RegisterDemoPage() {
  const [successUser, setSuccessUser] = useState<string | null>(null);

  const handleSubmit = useCallback(
    async (values: RegistrationValues, _signal: AbortSignal) => {
      // 模拟 API 延迟，用于 E2E disabled-button 测试
      await new Promise((resolve) => setTimeout(resolve, 500));
      setSuccessUser(values.username);
    },
    [],
  );

  return (
    <div className="mx-auto max-w-md p-8">
      <h1 className="mb-6 text-2xl font-bold text-gray-900">注册 (Demo)</h1>

      {successUser ? (
        <div
          data-testid="success-message"
          className="rounded-md bg-green-50 p-4 text-green-800"
        >
          注册成功：{successUser}
        </div>
      ) : (
        <RegistrationForm onSubmit={handleSubmit} className="space-y-0" />
      )}
    </div>
  );
}
