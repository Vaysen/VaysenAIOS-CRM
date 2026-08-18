'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { getRuntimeApiBaseUrl } from '@/lib/runtime-config';

/**
 * AI 建议与实时翻译 Hooks
 *
 * 同时兼容两种运行环境：
 * 1. Electron 桌面端 —— 通过 `window.electronAPI.apiRequest` 发起请求
 *    （主进程会自动附加 JWT token、Company-Id 并拼接 baseURL）。
 * 2. 普通浏览器端 —— 退化使用 `fetch`，并自行从 localStorage 读取认证信息。
 *
 * 后端 API 基础地址由 `NEXT_PUBLIC_API_URL` 环境变量提供。
 */

/** Electron apiRequest 返回的统一结构 */
interface ApiResult {
  success: boolean;
  data?: unknown;
  status?: number;
  message?: string;
}

/** 统一请求配置 */
interface RequestConfig {
  method?: string;
  url: string;
  data?: unknown;
  params?: Record<string, unknown>;
  headers?: Record<string, string>;
}

/** 从未知类型的异常中提取错误信息 */
function toErrorMessage(e: unknown, fallback: string): string {
  if (e instanceof Error) return e.message || fallback;
  if (typeof e === 'string' && e.length > 0) return e;
  return fallback;
}

/**
 * 统一 API 请求方法。
 *
 * - 检测到 `window.electronAPI` 时走 Electron 通道；
 * - 否则使用浏览器 `fetch`，并手动注入 Authorization / X-Company-Id。
 *
 * 返回后端响应体（即 axios response.data / fetch json）。
 * 请求失败时抛出 Error，错误信息取自后端 message。
 */
async function apiRequest<T = unknown>(config: RequestConfig): Promise<T> {
  const { method = 'GET', url, data, params, headers } = config;

  // === Electron 环境 ===
  const electronAPI =
    typeof window !== 'undefined' ? window.electronAPI : undefined;

  if (electronAPI) {
    const res = (await electronAPI.apiRequest({
      method,
      url,
      data,
      params,
      headers,
    })) as ApiResult;
    if (!res.success) {
      throw new Error(res.message || `请求失败 (${res.status || 'unknown'})`);
    }
    return res.data as T;
  }

  // === 浏览器环境（fetch 降级）===
  const queryString = params
    ? `?${new URLSearchParams(
        Object.entries(params)
          .filter(([, v]) => v != null)
          .map(([k, v]) => [k, String(v)]),
      ).toString()}`
    : '';
  const fullUrl = url.startsWith('http')
    ? `${url}${queryString}`
    : `${getRuntimeApiBaseUrl()}${url}${queryString}`;

  const reqHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(headers || {}),
  };
  if (typeof window !== 'undefined') {
    const token = localStorage.getItem('access_token');
    if (token) reqHeaders['Authorization'] = `Bearer ${token}`;
    const activeCompanyId = localStorage.getItem('active_company_id');
    if (activeCompanyId) reqHeaders['X-Company-Id'] = activeCompanyId;
  }

  const res = await fetch(fullUrl, {
    method,
    headers: reqHeaders,
    body: data != null ? JSON.stringify(data) : undefined,
  });

  if (!res.ok) {
    let message = `请求失败 (${res.status})`;
    try {
      const errBody = await res.json();
      message = (errBody as { message?: string })?.message || message;
    } catch (error) {
      console.error('[useAiSuggestions] non-JSON error response:', error);
    }
    throw new Error(message);
  }

  return (await res.json()) as T;
}

// ============================================================================
// useAISuggestions —— 获取 AI 回复建议
// ============================================================================

/** 后端 suggest-replies 返回结构的宽松类型 */
interface SuggestRepliesResponse {
  replies?: string[];
  content?: string;
  message?: string;
}

export interface UseAISuggestionsResult {
  /** AI 建议回复列表（英文） */
  suggestions: string[];
  /** 是否正在加载 */
  loading: boolean;
  /** 错误信息（无错误时为 null） */
  error: string | null;
  /** 主动拉取建议；targetLanguage 默认 'en' */
  fetchSuggestions: (targetLanguage?: string) => Promise<void>;
  /** 清空已有建议 */
  clearSuggestions: () => void;
}

/**
 * 根据客户消息 ID 获取 AI 回复建议。
 *
 * 调用 `POST /api/ai-communications/suggest-replies/:messageId`，
 * 返回英文建议列表。当 messageId 变化时不会自动请求，需调用 fetchSuggestions。
 *
 * @param messageId 最近一条客户消息的 ID（可为 null/undefined）
 */
export function useAISuggestions(
  messageId: string | null | undefined,
): UseAISuggestionsResult {
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchSuggestions = useCallback(
    async (targetLanguage: string = 'en') => {
      if (!messageId) {
        setError('缺少客户消息，无法生成建议');
        setSuggestions([]);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const data = await apiRequest<SuggestRepliesResponse>({
          method: 'POST',
          url: `/ai-communications/suggest-replies/${messageId}`,
          data: { targetLanguage },
        });
        const replies = Array.isArray(data?.replies) ? data.replies : [];
        setSuggestions(
          replies.length > 0
            ? replies
            : data?.content
              ? [data.content]
              : [],
        );
      } catch (e) {
        setError(toErrorMessage(e, '获取 AI 建议失败'));
        setSuggestions([]);
      } finally {
        setLoading(false);
      }
    },
    [messageId],
  );

  const clearSuggestions = useCallback(() => {
    setSuggestions([]);
    setError(null);
  }, []);

  return { suggestions, loading, error, fetchSuggestions, clearSuggestions };
}

// ============================================================================
// useRealtimeTranslate —— 实时翻译（防抖 500ms）
// ============================================================================

/** 后端 translate-draft 返回结构的宽松类型 */
interface TranslateDraftResponse {
  translatedText?: string;
  translation?: string;
  text?: string;
  content?: string;
}

export interface UseRealtimeTranslateResult {
  /** 源文本（中文） */
  sourceText: string;
  /** 设置源文本，设置后自动触发防抖翻译 */
  setSourceText: (text: string) => void;
  /** 翻译结果（英文） */
  translatedText: string;
  /** 是否正在翻译 */
  translating: boolean;
  /** 错误信息（无错误时为 null） */
  error: string | null;
  /** 手动触发一次翻译（立即执行，跳过防抖） */
  translate: () => Promise<void>;
  /** 清空源文本与翻译结果 */
  reset: () => void;
}

/**
 * 实时翻译 Hook：源文本变化后防抖 500ms 自动翻译为英文。
 *
 * 调用 `POST /api/ai-communications/translate-draft`，
 * body: `{ text, targetLanguage }`。
 *
 * @param targetLanguage 目标语言，默认 'en'
 * @param debounceMs     防抖时长，默认 500ms
 */
export function useRealtimeTranslate(
  targetLanguage: string = 'en',
  debounceMs: number = 500,
): UseRealtimeTranslateResult {
  const [sourceText, setSourceText] = useState('');
  const [translatedText, setTranslatedText] = useState('');
  const [translating, setTranslating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runTranslate = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) {
        setTranslatedText('');
        setTranslating(false);
        setError(null);
        return;
      }
      setTranslating(true);
      setError(null);
      try {
        const data = await apiRequest<TranslateDraftResponse>({
          method: 'POST',
          url: '/ai-communications/translate-draft',
          data: { text: trimmed, targetLanguage },
        });
        setTranslatedText(
          data?.translatedText ||
            data?.translation ||
            data?.text ||
            data?.content ||
            '',
        );
      } catch (e) {
        setError(toErrorMessage(e, '翻译失败'));
        setTranslatedText('');
      } finally {
        setTranslating(false);
      }
    },
    [targetLanguage],
  );

  // 源文本变化时自动防抖翻译
  useEffect(() => {
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
    }
    if (!sourceText.trim()) {
      setTranslatedText('');
      setError(null);
      return;
    }
    debounceTimer.current = setTimeout(() => {
      void runTranslate(sourceText);
    }, debounceMs);

    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }
    };
  }, [sourceText, debounceMs, runTranslate]);

  const translate = useCallback(async () => {
    await runTranslate(sourceText);
  }, [runTranslate, sourceText]);

  const reset = useCallback(() => {
    setSourceText('');
    setTranslatedText('');
    setError(null);
    setTranslating(false);
  }, []);

  return {
    sourceText,
    setSourceText,
    translatedText,
    translating,
    error,
    translate,
    reset,
  };
}
