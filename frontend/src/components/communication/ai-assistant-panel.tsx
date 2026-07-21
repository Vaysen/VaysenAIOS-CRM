'use client';

import { useState } from 'react';
import { Sparkles, Loader2, Bot, Copy, Check, Send, Languages, ChevronDown, ChevronUp, AlertCircle, RefreshCw } from 'lucide-react';
import api from '@/lib/api';
import type { CommunicationMessage } from './types';

interface Props {
  conversationId: string | null;
  lastMessage?: CommunicationMessage | null;
  leadLanguage?: string | null;
  onUseDraft: (text: string) => void;
}

export function AiAssistantPanel({ conversationId, lastMessage, leadLanguage, onUseDraft }: Props) {
  const [loading, setLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const targetLang = leadLanguage || 'en';

  const diagnose = (err: unknown): string => {
    const anyErr = err as { response?: { status?: number }; code?: string; message?: string };
    if (anyErr?.response?.status === 401) return 'AI 服务暂不可用：登录已失效，请重新登录后重试。';
    if (anyErr?.response?.status === 403) return 'AI 服务暂不可用：无权限（403），请联系管理员。';
    if (anyErr?.response?.status && anyErr.response.status >= 500)
      return `AI 服务暂不可用：服务端异常（${anyErr.response.status}），请稍后重试。`;
    if (anyErr?.code === 'ECONNABORTED' || anyErr?.code === 'ERR_NETWORK')
      return 'AI 服务暂不可用：网络超时或后端离线，请检查网络后重试。';
    return `AI 服务暂不可用：${anyErr?.message || '未知错误'}`;
  };

  const suggestReplies = async () => {
    if (!lastMessage?.id) return;
    setLoading(true);
    setSuggestions([]);
    setError(null);
    setExpanded(false);
    try {
      const res = await api.post(`/ai-communications/suggest-replies/${lastMessage.id}`, {
        targetLanguage: targetLang,
      });
      const replies = Array.isArray(res.data?.replies) ? res.data.replies : [];
      setSuggestions(replies.length > 0 ? replies : [res.data?.content || '无建议']);
      if (replies.length > 0) setExpanded(true);
    } catch (err) {
      console.error('[AiAssistantPanel] suggest-replies failed:', err);
      setError(diagnose(err));
      setSuggestions([]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="border-t bg-gray-50 shrink-0">
      {/* 紧凑横条 */}
      <div className="flex items-center gap-1.5 px-3 py-1.5">
        <Sparkles className="w-3 h-3 text-purple-500 shrink-0" />
        <button
          onClick={suggestReplies}
          disabled={loading || !lastMessage}
          className="flex items-center gap-1 rounded border border-blue-300 bg-blue-600 px-2 py-1 text-[10px] font-medium text-white transition-colors hover:bg-blue-700 disabled:pointer-events-none disabled:opacity-40"
        >
          {loading ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <Bot className="w-2.5 h-2.5" />}
          AI回复建议({targetLang.toUpperCase()})
        </button>
        {suggestions.length > 0 && (
          <button onClick={() => setExpanded(!expanded)} className="text-[9px] text-gray-400 hover:text-gray-600 ml-auto flex items-center gap-0.5">
            {suggestions.length}条 {expanded ? <ChevronDown className="w-2.5 h-2.5" /> : <ChevronUp className="w-2.5 h-2.5" />}
          </button>
        )}
      </div>
      {/* 展开的建议列表 */}
      {expanded && suggestions.length > 0 && (
        <div className="px-3 pb-1.5 space-y-1 max-h-32 overflow-y-auto">
          {suggestions.map((s, i) => (
            <div key={i} className="flex items-start gap-1.5 bg-white border rounded px-2 py-1">
              <p className="text-[10px] text-gray-700 flex-1 leading-relaxed whitespace-pre-wrap">{s}</p>
              <div className="flex gap-0.5 shrink-0">
                <button
                  onClick={() => { navigator.clipboard.writeText(s); setCopied(true); setTimeout(() => setCopied(false), 2000); }}
                  className="text-gray-400 hover:text-gray-600"
                >
                  {copied ? <Check className="w-2.5 h-2.5 text-green-500" /> : <Copy className="w-2.5 h-2.5" />}
                </button>
                <button
                  onClick={() => { onUseDraft(s); setExpanded(false); }}
                  className="text-blue-500 hover:text-blue-700"
                >
                  <Send className="w-2.5 h-2.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {/* 错误诊断 + 重试 */}
      {error && (
        <div className="px-3 pb-1.5">
          <div className="flex items-start gap-1.5 bg-red-50 border border-red-200 rounded px-2 py-1">
            <AlertCircle className="w-3 h-3 text-red-500 mt-0.5 shrink-0" />
            <p className="text-[10px] text-red-600 flex-1 leading-relaxed whitespace-pre-wrap">{error}</p>
          </div>
          <button
            onClick={suggestReplies}
            disabled={loading}
            className="mt-1 w-full flex items-center justify-center gap-1 rounded border border-red-300 bg-white px-2 py-1 text-[10px] font-medium text-red-600 transition-colors hover:bg-red-50 disabled:opacity-40"
          >
            {loading ? <Loader2 className="w-2.5 h-2.5 animate-spin" /> : <RefreshCw className="w-2.5 h-2.5" />}
            {loading ? '重试中…' : '重试'}
          </button>
        </div>
      )}
    </div>
  );
}
