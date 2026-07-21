'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuthStore } from '@/store/authStore';

const publicPaths = ['/login', '/register', '/register-demo'];
const publicPrefixes = ['/unsubscribe'];

function isPublicPath(pathname: string): boolean {
  if (publicPaths.includes(pathname)) return true;
  return publicPrefixes.some((prefix) => pathname.startsWith(prefix));
}

function clearStoredAuth() {
  localStorage.removeItem('access_token');
  localStorage.removeItem('refresh_token');
}

export function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { isAuthenticated, fetchProfile } = useAuthStore();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;

    const storedToken = localStorage.getItem('access_token');

    if (!storedToken && !isPublicPath(pathname)) {
      router.push('/login');
      return;
    }

    if (storedToken && !isAuthenticated) {
      fetchProfile();
    }

    if (storedToken && isPublicPath(pathname)) {
      router.push('/');
    }
  }, [pathname, isAuthenticated, fetchProfile, router, mounted]);

  useEffect(() => {
    if (!mounted || isAuthenticated || isPublicPath(pathname)) return;

    const storedToken = localStorage.getItem('access_token');
    if (!storedToken) return;

    const timer = window.setTimeout(() => {
      if (!useAuthStore.getState().isAuthenticated) {
        clearStoredAuth();
        router.push('/login');
      }
    }, 8000);

    return () => window.clearTimeout(timer);
  }, [mounted, isAuthenticated, pathname, router]);

  if (!isAuthenticated && !isPublicPath(pathname)) {
    const storedToken = mounted ? localStorage.getItem('access_token') : null;

    if (mounted && !storedToken) {
      return (
        <div className="flex min-h-screen items-center justify-center bg-gray-50 dark:bg-gray-900">
          <p className="text-gray-500">正在跳转到登录页...</p>
        </div>
      );
    }

    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-gray-50 dark:bg-gray-900">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-blue-600 border-t-transparent" />
        <p className="text-gray-500">正在连接服务器...</p>
        <button
          onClick={() => {
            clearStoredAuth();
            router.push('/login');
          }}
          className="mt-2 text-sm text-blue-600 hover:underline"
        >
          重新登录
        </button>
      </div>
    );
  }

  return <>{children}</>;
}
