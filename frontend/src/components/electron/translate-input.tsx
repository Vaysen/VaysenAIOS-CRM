'use client';

import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useMemo,
  useState,
} from 'react';
import {
  Check,
  Copy,
  Languages,
  Loader2,
  AlertCircle,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useRealtimeTranslate } from '@/hooks/use-ai-suggestions';

/**
 * 翻译输入组件：中文输入 -> 实时英文翻译（防抖 500ms）。
 *
 * - 上方：中文输入 textarea + 字数统计
 * - 下方：英文翻译结果（实时，防抖 500ms）
 * - 「复制翻译」按钮
 * - 「复制草稿」按钮；最终发送由操作员在 WhatsApp 内人工确认
 *
 * 通过 ref 暴露 `setText`，供父组件（AI 面板）在点击"使用"建议时注入文本。
 */

export interface TranslateInputHandle {
  /** 将指定文本填入中文输入框（会触发自动翻译） */
  setText: (text: string) => void;
  /** 清空输入与翻译结果 */
  clear: () => void;
}

export interface TranslateInputProps {
  /** 兼容旧调用；自动发送已停用，不再作为执行目标 */
  chatId?: string | null;
  /** 目标语言，默认英文 'en' */
  targetLanguage?: string;
  /** 兼容旧调用；复制草稿在普通浏览器和 Electron 均可用 */
  isElectron?: boolean;
  /** 发送结果回调 */
  onSendResult?: (success: boolean, message?: string) => void;
  className?: string;
}

const TranslateInput = forwardRef<TranslateInputHandle, TranslateInputProps>(
  function TranslateInput(
    {
      targetLanguage = 'en',
      onSendResult,
      className,
    },
    ref,
  ) {
    const {
      sourceText,
      setSourceText,
      translatedText,
      translating,
      error,
      translate,
      reset,
    } = useRealtimeTranslate(targetLanguage);

    const [copied, setCopied] = useState(false);
    const [sending, setSending] = useState(false);
    const [sendError, setSendError] = useState<string | null>(null);

    // 暴露给父组件的命令式接口
    useImperativeHandle(
      ref,
      () => ({
        setText: (text: string) => setSourceText(text),
        clear: () => reset(),
      }),
      [setSourceText, reset],
    );

    const charCount = sourceText.length;
    const maxChars = 2000;

    const handleCopy = useCallback(async () => {
      if (!translatedText) return;
      try {
        await navigator.clipboard.writeText(translatedText);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      } catch (error) {
        console.error('[TranslateInput] clipboard write failed:', error);
      }
    }, [translatedText]);

    const handlePrepareForWhatsApp = useCallback(async () => {
      setSendError(null);

      if (!translatedText.trim()) {
        setSendError('没有可发送的翻译内容');
        onSendResult?.(false, '没有可发送的翻译内容');
        return;
      }
      setSending(true);
      try {
        await navigator.clipboard.writeText(translatedText);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
        onSendResult?.(true, '草稿已复制，请在当前 WhatsApp 聊天中核对后手动发送');
      } catch (e) {
        const msg = e instanceof Error ? e.message : '复制草稿失败';
        setSendError(msg);
        onSendResult?.(false, msg);
      } finally {
        setSending(false);
      }
    }, [translatedText, onSendResult]);

    const canSend = useMemo(
      () => !!translatedText.trim() && !sending,
      [translatedText, sending],
    );

    return (
      <div className={cn('flex h-full flex-col gap-3', className)}>
        {/* 中文输入区 */}
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <label
              htmlFor="translate-source"
              className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground"
            >
              <Languages className="h-3.5 w-3.5" />
              中文输入
            </label>
            <span
              className={cn(
                'text-[10px]',
                charCount > maxChars
                  ? 'text-destructive'
                  : 'text-muted-foreground',
              )}
            >
              {charCount}/{maxChars}
            </span>
          </div>
          <textarea
            id="translate-source"
            value={sourceText}
            onChange={(e) => setSourceText(e.target.value.slice(0, maxChars))}
            placeholder="在此输入中文，自动翻译为英文…"
            rows={5}
            className="w-full resize-none rounded-lg border border-input bg-background px-3 py-2 text-sm leading-relaxed text-foreground shadow-xs transition-colors placeholder:text-muted-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          />
          <div className="flex items-center justify-end">
            <button
              type="button"
              onClick={() => void translate()}
              disabled={translating || !sourceText.trim()}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
            >
              {translating ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <Languages className="h-3 w-3" />
              )}
              立即翻译
            </button>
          </div>
        </div>

        {/* 英文翻译结果区 */}
        <div className="flex flex-1 flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Languages className="h-3.5 w-3.5 rotate-180" />
              英文翻译
              {translating && (
                <Loader2 className="h-3 w-3 animate-spin text-primary" />
              )}
            </span>
            <button
              type="button"
              onClick={handleCopy}
              disabled={!translatedText}
              title="复制翻译"
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
            >
              {copied ? (
                <Check className="h-3 w-3 text-green-500" />
              ) : (
                <Copy className="h-3 w-3" />
              )}
              {copied ? '已复制' : '复制翻译'}
            </button>
          </div>
          <div className="min-h-[96px] flex-1 rounded-lg border border-input bg-muted/30 px-3 py-2 text-sm leading-relaxed text-foreground whitespace-pre-wrap break-words">
            {error ? (
              <span className="flex items-start gap-1.5 text-destructive">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>{error}</span>
              </span>
            ) : translatedText ? (
              translatedText
            ) : (
              <span className="text-muted-foreground">
                翻译结果将显示在此处…
              </span>
            )}
          </div>
        </div>

        {/* 复制后由操作员在 WhatsApp 中人工发送 */}
        <div className="flex flex-col gap-1.5">
          {sendError && (
            <span className="flex items-start gap-1.5 text-xs text-destructive">
              <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
              <span>{sendError}</span>
            </span>
          )}
          <button
            type="button"
            onClick={handlePrepareForWhatsApp}
            disabled={!canSend}
            className={cn(
              'inline-flex w-full items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50',
              canSend
                ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                : 'bg-muted text-muted-foreground',
            )}
          >
            {sending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Copy className="h-4 w-4" />
            )}
            复制草稿，人工发送
          </button>
          <p className="text-center text-[10px] text-muted-foreground">
            系统不会自动点击发送；请核对当前联系人和草稿内容
          </p>
        </div>
      </div>
    );
  },
);

export { TranslateInput };
