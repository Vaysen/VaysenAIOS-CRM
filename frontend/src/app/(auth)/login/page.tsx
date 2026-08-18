'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/store/authStore';

export default function LoginPage() {
  const router = useRouter();
  const { login, isLoading, error, clearError } = useAuthStore();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setHydrated(true);
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await login(username, password);
      router.push('/');
    } catch (error) {
      // auth store owns the visible error message; retain diagnostics for support.
      console.error('[LoginPage] login failed:', error);
    }
  };

  return (
    <div className="w-full max-w-md rounded-xl border border-gray-200 bg-white p-8 shadow-sm dark:border-gray-800 dark:bg-gray-950">
      <div className="mb-6 text-center">
        <img src="/logo.png" alt="Vaysen" className="mx-auto mb-3 h-16 w-16 rounded-xl object-cover" />
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">Vaysen外贸系统</h1>
        <p className="mt-2 text-gray-500 dark:text-gray-400">Vaysen Trade OS</p>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
          {error}
        </div>
      )}

      <form
        className="space-y-4"
        data-testid="login-form"
        data-hydrated={hydrated ? 'true' : 'false'}
        onSubmit={handleSubmit}
      >
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">邮箱</label>
          <input
            type="email"
            required
            readOnly={!hydrated}
            autoComplete="email"
            value={username}
            onChange={(e) => {
              setUsername(e.target.value);
              clearError();
            }}
            className="w-full rounded-lg border border-gray-300 bg-white px-4 py-2 text-gray-900 outline-none focus:border-transparent focus:ring-2 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-800 dark:text-white"
            placeholder="例如 chris@company.com / maria@mail.com"
          />
        </div>

        <div>
          <label className="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300">密码</label>
          <input
            type="password"
            required
            readOnly={!hydrated}
            autoComplete="current-password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              clearError();
            }}
            className="w-full rounded-lg border border-gray-300 bg-white px-4 py-2 text-gray-900 outline-none focus:border-transparent focus:ring-2 focus:ring-blue-500 dark:border-gray-700 dark:bg-gray-800 dark:text-white"
            placeholder="请输入密码"
          />
        </div>

        <button
          type="submit"
          disabled={!hydrated || isLoading}
          className="w-full rounded-lg bg-blue-600 px-4 py-2 font-medium text-white transition-colors hover:bg-blue-700 focus:ring-2 focus:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isLoading ? '登录中...' : '登录'}
        </button>
      </form>
    </div>
  );
}
