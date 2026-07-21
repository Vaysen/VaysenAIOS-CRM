'use client';

import { useCallback, useRef, useState } from 'react';
import {
  AlertCircle,
  Check,
  Copy,
  Languages,
  Loader2,
  MessageSquare,
  Send,
  Sparkles,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAISuggestions } from '@/hooks/use-ai-suggestions';
import {
  TranslateInput,
  type TranslateInputHandle,
} from './translate-input';

/**
 * AI 面板 —— Electron 桌面应用右侧栏。
 *
 * - 固定宽度 360px，深色主题（在根节点挂 `dark` 类，复用语义化 CSS 变量）
 * - 两个 Tab：「AI 建议」与「实时翻译」
 *   - AI 建议：展示最近一条客户消息，调用后端生成 3 条英文回复建议，
 *     每条带「使用」按钮，点击后填入翻译 Tab 输入框并切换 Tab。
 *   - 实时翻译：中文输入 -> 英文翻译（防抖 500ms），可发送到 WhatsApp。
 * - 底部 AI 状态指示器（加载中 / 就绪 / 错误）
 */

type TabKey = 'suggestions' | 'translate';

export interface AiPanelProps {
  /** 最近一条客户消息 ID（用于获取 AI 建议） */
  messageId?: string | null;
  /** 最近一条客户消息内容（用于展示） */
  lastMessageContent?: string | null;
  /** 最近一条客户消息发送方名称 */
  lastMessageFrom?: string | null;
  /** WhatsApp 聊天 ID（传递给翻译组件用于发送） */
  chatId?: string | null;
  /** 目标语言，默认英文 'en' */
  targetLanguage?: string;
  /** 附加在根节点的 className */
  className?: string;
}

export function AiPanel({
  messageId,
  lastMessageContent,
  lastMessageFrom,
  chatId,
  targetLanguage = 'en',
  className,
}: AiPanelProps) {
  const [activeTab, setActiveTab] = useState<TabKey>('suggestions');
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  const translateRef = useRef<TranslateInputHandle>(null);
  const { suggestions, loading, error, fetchSuggestions } =
    useAISuggestions(messageId);

  const handleGenerate = useCallback(() => {
    void fetchSuggestions(targetLanguage);
  }, [fetchSuggestions, targetLanguage]);

  /** 点击建议的「使用」：填入翻译输入框并切换到翻译 Tab */
  const handleUseSuggestion = useCallback((text: string) => {
    translateRef.current?.setText(text);
    setActiveTab('translate');
  }, []);

  const handleCopySuggestion = useCallback(async (text: string, index: number) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedIndex(index);
      window.setTimeout(() => setCopiedIndex(null), 2000);
    } catch (error) {
      console.error('[AiPanel] clipboard write failed:', error);
    }
  }, []);

  // 底部状态：错误 > 加载中 > 就绪
  const status: 'error' | 'loading' | 'ready' = error
    ? 'error'
    : loading
      ? 'loading'
      : 'ready';

  return (
    <div
      className={cn(
        'dark flex h-full w-[360px] shrink-0 flex-col border-l border-border bg-card text-card-foreground',
        className,
      )}
    >
      {/* 顶部标题 */}
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <Sparkles className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-semibold text-foreground">AI 助手</h2>
        <span className="ml-auto text-[10px] text-muted-foreground">
          {targetLanguage.toUpperCase()}
        </span>
      </div>

      {/* Tab 切换 */}
      <div className="flex border-b border-border">
        <TabButton
          active={activeTab === 'suggestions'}
          onClick={() => setActiveTab('suggestions')}
          icon={<Sparkles className="h-3.5 w-3.5" />}
          label="AI 建议"
        />
        <TabButton
          active={activeTab === 'translate'}
          onClick={() => setActiveTab('translate')}
          icon={<Languages className="h-3.5 w-3.5" />}
          label="实时翻译"
        />
      </div>

      {/* 内容区 */}
      <div className="flex-1 overflow-y-auto p-4">
        {activeTab === 'suggestions' ? (
          <SuggestionsTab
            lastMessageContent={lastMessageContent}
            lastMessageFrom={lastMessageFrom}
            loading={loading}
            error={error}
            suggestions={suggestions}
            copiedIndex={copiedIndex}
            onGenerate={handleGenerate}
            onUse={handleUseSuggestion}
            onCopy={handleCopySuggestion}
            canGenerate={!!messageId}
          />
        ) : (
          <TranslateInput
            ref={translateRef}
            chatId={chatId}
            targetLanguage={targetLanguage}
            isElectron={typeof window !== 'undefined' && !!window.electronAPI}
          />
        )}
      </div>

      {/* 底部 AI 状态指示器 */}
      <StatusIndicator status={status} message={error} />
    </div>
  );
}

// ============================================================================
// Tab 按钮
// ============================================================================

interface TabButtonProps {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}

function TabButton({ active, onClick, icon, label }: TabButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex flex-1 items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-medium transition-colors',
        active
          ? 'border-b-2 border-primary text-foreground'
          : 'border-b-2 border-transparent text-muted-foreground hover:text-foreground',
      )}
    >
      {icon}
      {label}
    </button>
  );
}

// ============================================================================
// AI 建议 Tab 内容
// ============================================================================

interface SuggestionsTabProps {
  lastMessageContent?: string | null;
  lastMessageFrom?: string | null;
  loading: boolean;
  error: string | null;
  suggestions: string[];
  copiedIndex: number | null;
  canGenerate: boolean;
  onGenerate: () => void;
  onUse: (text: string) => void;
  onCopy: (text: string, index: number) => void;
}

function SuggestionsTab({
  lastMessageContent,
  lastMessageFrom,
  loading,
  error,
  suggestions,
  copiedIndex,
  canGenerate,
  onGenerate,
  onUse,
  onCopy,
}: SuggestionsTabProps) {
  return (
    <div className="flex flex-col gap-4">
      {/* 最近客户消息 */}
      <section className="flex flex-col gap-2">
        <h3 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <MessageSquare className="h-3.5 w-3.5" />
          最近客户消息
        </h3>
        <div className="rounded-lg border border-border bg-muted/30 p-3">
          {lastMessageContent ? (
            <>
              {lastMessageFrom && (
                <p className="mb-1 text-[11px] font-medium text-muted-foreground">
                  {lastMessageFrom}
                </p>
              )}
              <p className="text-sm leading-relaxed text-foreground whitespace-pre-wrap break-words">
                {lastMessageContent}
              </p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">暂无客户消息</p>
          )}
        </div>
      </section>

      {/* 生成按钮 */}
      <button
        type="button"
        onClick={onGenerate}
        disabled={loading || !canGenerate}
        className={cn(
          'inline-flex w-full items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50',
          'bg-primary text-primary-foreground hover:bg-primary/90',
        )}
      >
        {loading ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Sparkles className="h-4 w-4" />
        )}
        {loading ? '生成中…' : '生成回复建议'}
      </button>
      {!canGenerate && (
        <p className="text-center text-[10px] text-muted-foreground">
          需要客户消息才能生成建议
        </p>
      )}

      {/* 错误提示 */}
      {error && (
        <div className="flex items-start gap-1.5 rounded-lg border border-destructive/30 bg-destructive/10 p-2.5 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* 建议列表 */}
      {suggestions.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Sparkles className="h-3.5 w-3.5" />
            建议回复（{suggestions.length}）
          </h3>
          <ul className="flex flex-col gap-2">
            {suggestions.slice(0, 3).map((suggestion, index) => (
              <li
                key={index}
                className="flex flex-col gap-2 rounded-lg border border-border bg-background p-3"
              >
                <p className="text-sm leading-relaxed text-foreground whitespace-pre-wrap break-words">
                  {suggestion}
                </p>
                <div className="flex items-center justify-end gap-1">
                  <button
                    type="button"
                    onClick={() => onCopy(suggestion, index)}
                    title="复制"
                    className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    {copiedIndex === index ? (
                      <Check className="h-3 w-3 text-green-500" />
                    ) : (
                      <Copy className="h-3 w-3" />
                    )}
                    {copiedIndex === index ? '已复制' : '复制'}
                  </button>
                  <button
                    type="button"
                    onClick={() => onUse(suggestion)}
                    title="填入翻译输入框"
                    className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-2 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/20"
                  >
                    <Send className="h-3 w-3" />
                    使用
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* 空态 */}
      {!loading && !error && suggestions.length === 0 && (
        <div className="flex flex-col items-center gap-2 py-8 text-center">
          <Sparkles className="h-8 w-8 text-muted-foreground/50" />
          <p className="text-sm text-muted-foreground">
            点击上方按钮，AI 将根据客户消息生成英文回复建议
          </p>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// 底部状态指示器
// ============================================================================

interface StatusIndicatorProps {
  status: 'loading' | 'ready' | 'error';
  message?: string | null;
}

function StatusIndicator({ status, message }: StatusIndicatorProps) {
  const config = {
    loading: {
      dot: 'bg-yellow-500',
      text: 'AI 处理中…',
      icon: <Loader2 className="h-3 w-3 animate-spin text-yellow-500" />,
    },
    ready: {
      dot: 'bg-green-500',
      text: 'AI 就绪',
      icon: null,
    },
    error: {
      dot: 'bg-red-500',
      text: message || 'AI 异常',
      icon: <AlertCircle className="h-3 w-3 text-red-500" />,
    },
  }[status];

  return (
    <div className="flex items-center gap-2 border-t border-border px-4 py-2">
      <span className="relative flex h-2 w-2">
        {status === 'loading' && (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-yellow-500 opacity-75" />
        )}
        <span className={cn('relative inline-flex h-2 w-2 rounded-full', config.dot)} />
      </span>
      {config.icon}
      <span
        className={cn(
          'truncate text-xs',
          status === 'ready' && 'text-muted-foreground',
          status === 'loading' && 'text-yellow-600 dark:text-yellow-400',
          status === 'error' && 'text-red-600 dark:text-red-400',
        )}
        title={typeof config.text === 'string' ? config.text : undefined}
      >
        {config.text}
      </span>
    </div>
  );
}
