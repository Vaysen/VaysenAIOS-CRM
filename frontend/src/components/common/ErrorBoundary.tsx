'use client';
import React from 'react';

interface Props { children: React.ReactNode; fallback?: React.ReactNode; }
interface State { hasError: boolean; error: Error | null; }

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('ErrorBoundary caught:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return this.props.fallback || (
        <div className="flex flex-col items-center justify-center min-h-[400px] gap-4">
          <h2 className="text-lg font-semibold text-gray-900">页面出错了</h2>
          <p className="text-sm text-gray-500">{this.state.error?.message || '未知错误'}</p>
          <button onClick={() => window.location.reload()} className="px-4 py-2 text-sm rounded bg-blue-600 text-white hover:bg-blue-700">刷新页面</button>
        </div>
      );
    }
    return this.props.children;
  }
}
