'use client';

import { useState, useRef } from 'react';
import { Send, Paperclip, X, FileText, Image as ImageIcon, File, Loader2 } from 'lucide-react';
import type { CommunicationMessage } from './types';
import { cn } from '@/lib/utils';
import { getRuntimeApiBaseUrl } from '@/lib/runtime-config';

function fileUrl(url: string): string {
  if (!url) return '';
  if (url.startsWith('http')) return url;
  return `${getRuntimeApiBaseUrl().replace(/\/api$/, '')}${url}`;
}

const channelLabels: Record<string, string> = {
  business_email: '商务邮件',
  marketing_email: '营销邮件',
  whatsapp: 'WhatsApp',
  website_inquiry: '网站询盘',
};

interface PendingAttachment {
  url: string;
  originalName: string;
  mimeType: string;
  mediaType: 'image' | 'document' | 'video' | 'audio';
  size: number;
}

interface Props {
  messages: CommunicationMessage[];
  channel: string;
  subject: string | null;
  onSend: (content: string, attachment?: PendingAttachment) => void;
  sending?: boolean;
  draft?: string;
  onDraftChange?: (text: string) => void;
}

const SLASH_QUICK_REPLIES = [
  { label:'/首次回复', text:'感谢您的询盘！请问您需要什么材质和规格的包装？我们可提供免费咨询。' },
  { label:'/询问规格', text:'请提供您需要的产品规格要求（尺寸、厚度、颜色等），以便我们精准报价。' },
  { label:'/询问数量', text:'请问您需要的数量是多少？不同数量对应的价格和交期会有所差异。' },
  { label:'/询问材质', text:'请问您对材质有什么要求？我们有牛皮纸、PE、无纺布等选择。' },
  { label:'/询问印刷', text:'请问需要印刷Logo吗？可以提供设计稿，我们评估方案。' },
];

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function getAttachmentIcon(mimeType: string) {
  if (mimeType.startsWith('image/')) return <ImageIcon className="w-3 h-3" />;
  if (mimeType.startsWith('video/')) return <File className="w-3 h-3" />;
  return <FileText className="w-3 h-3" />;
}

export function MessageThread({ messages, channel, subject, onSend, sending, draft, onDraftChange }: Props) {
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [pendingAttachment, setPendingAttachment] = useState<PendingAttachment | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const displayText = draft ?? '';
  const setText = onDraftChange || (() => {});

  const handleSend = () => {
    if (!displayText.trim() && !pendingAttachment) return;
    onSend(displayText, pendingAttachment || undefined);
    setText('');
    setPendingAttachment(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === '/' && !displayText) { e.preventDefault(); setShowSlashMenu(true); return; }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
  };

  const handleSlashSelect = (text: string) => { setShowSlashMenu(false); onDraftChange?.(text); };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
       const apiUrl = getRuntimeApiBaseUrl();
      const token = typeof window !== 'undefined' ? localStorage.getItem('access_token') || '' : '';
      const response = await fetch(`${apiUrl}/communications/upload`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: formData,
      });

      if (!response.ok) throw new Error('Upload failed');
      const result = await response.json();

      setPendingAttachment({
        url: result.url,
        originalName: result.originalName,
        mimeType: result.mimeType,
        mediaType: result.mediaType,
        size: result.size,
      });
    } catch (err) {
      alert('文件上传失败，请重试');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  return (
    <div className="flex flex-col h-full bg-gray-50">
      <div className="px-4 py-3 border-b bg-white flex items-center gap-2">
        <span className="text-xs text-gray-400 px-2 py-0.5 bg-gray-100 rounded">
          {channelLabels[channel] || channel}
        </span>
        <span className="text-sm font-medium truncate">{subject || '无主题'}</span>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {messages.map((msg) => {
          const attachment = msg.attachmentsMeta as any;
          const hasAttachment = attachment && (attachment.url || attachment.originalName);

          return (
            <div
              key={msg.id}
              className={cn(
                'flex gap-3',
                msg.direction === 'outbound' ? 'justify-end' : 'justify-start'
              )}
            >
              {msg.direction === 'inbound' && (
                <div className="w-7 h-7 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center text-xs font-bold shrink-0 mt-1">
                  {msg.fromAddress?.charAt(0).toUpperCase() || '客'}
                </div>
              )}
              <div
                className={cn(
                  'max-w-[75%] rounded-lg px-3.5 py-2.5 text-sm leading-relaxed',
                  msg.direction === 'outbound'
                    ? 'bg-blue-600 text-white'
                    : 'bg-white border text-gray-800'
                )}
              >
                {/* 附件渲染 */}
                {hasAttachment && (
                  <div className={cn(
                    'mb-2 rounded-lg overflow-hidden border',
                    msg.direction === 'outbound' ? 'border-blue-400/30 bg-blue-500/20' : 'border-gray-200 bg-gray-50'
                  )}>
                    {attachment.mimeType?.startsWith('image/') && attachment.url ? (
                      <a href={fileUrl(attachment.url)} target="_blank" rel="noopener noreferrer" className="block">
                        <img src={fileUrl(attachment.url)} alt={attachment.originalName || 'image'} className="max-w-full max-h-48 object-contain" />
                      </a>
                    ) : (
                      <a href={fileUrl(attachment.url)} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 p-2.5 hover:bg-opacity-80 transition-colors">
                        <div className={cn(
                          'w-8 h-8 rounded flex items-center justify-center shrink-0',
                          msg.direction === 'outbound' ? 'bg-blue-400/30 text-blue-100' : 'bg-blue-100 text-blue-600'
                        )}>
                          {getAttachmentIcon(attachment.mimeType || '')}
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className={cn('text-xs font-medium truncate', msg.direction === 'outbound' ? 'text-white' : 'text-gray-700')}>
                            {attachment.originalName || attachment.filename || '附件'}
                          </p>
                          {attachment.size && (
                            <p className={cn('text-[10px]', msg.direction === 'outbound' ? 'text-blue-200' : 'text-gray-400')}>
                              {formatFileSize(attachment.size)}
                            </p>
                          )}
                        </div>
                      </a>
                    )}
                  </div>
                )}

                {/* 文本内容 */}
                {msg.content && <p className="whitespace-pre-wrap break-words">{msg.content}</p>}

                {msg.direction === 'inbound' && channel === 'whatsapp' && msg.toAddress && (
                  <span className="text-[10px] text-blue-500 bg-blue-50 px-1.5 py-0.5 rounded mt-1 inline-block">
                    接待: {msg.toAddress}
                  </span>
                )}
                <span
                  className={cn(
                    'text-[10px] mt-1 block',
                    msg.direction === 'outbound' ? 'text-blue-200' : 'text-gray-400'
                  )}
                >
                  {msg.receivedAt
                    ? new Date(msg.receivedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
                    : msg.sentAt
                    ? new Date(msg.sentAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
                    : ''}
                </span>
              </div>
              {msg.direction === 'outbound' && (
                <div className="w-7 h-7 rounded-full bg-blue-600 text-white flex items-center justify-center text-xs font-bold shrink-0 mt-1">
                  嘉
                </div>
              )}
            </div>
          );
        })}
        {messages.length === 0 && (
          <p className="text-sm text-gray-400 text-center py-16">暂无消息</p>
        )}
      </div>

      <div className="px-4 py-3 border-t bg-white relative">
        {showSlashMenu && (
          <div className="absolute bottom-full left-4 mb-1 w-64 bg-white border rounded-lg shadow-lg z-10 max-h-48 overflow-y-auto">
            {SLASH_QUICK_REPLIES.map((qr) => (
              <button key={qr.label} onClick={() => handleSlashSelect(qr.text)} className="w-full text-left px-3 py-1.5 text-xs hover:bg-blue-50 border-b last:border-0">
                <span className="font-medium text-blue-600">{qr.label}</span><span className="text-gray-400 ml-2">{qr.text.slice(0,25)}...</span>
              </button>
            ))}
          </div>
        )}

        {/* 待发送附件预览 */}
        {pendingAttachment && (
          <div className="mb-2 flex items-center gap-2 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
            <div className="w-8 h-8 rounded bg-blue-100 text-blue-600 flex items-center justify-center shrink-0">
              {getAttachmentIcon(pendingAttachment.mimeType)}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium text-gray-700 truncate">{pendingAttachment.originalName}</p>
              <p className="text-[10px] text-gray-400">{formatFileSize(pendingAttachment.size)} · {pendingAttachment.mediaType}</p>
            </div>
            <button onClick={() => setPendingAttachment(null)} className="text-gray-400 hover:text-red-500 p-1">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        <div className="flex items-end gap-2">
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={handleFileSelect}
            accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip,.rar"
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="p-1.5 text-gray-400 hover:text-blue-600 rounded disabled:opacity-40"
            title="发送文件/图片"
          >
            {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Paperclip className="w-4 h-4" />}
          </button>
          <textarea
            value={displayText}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={pendingAttachment ? "添加说明文字（可选）..." : "输入回复...（Enter 发送，Shift+Enter 换行）"}
            rows={2}
            className="flex-1 resize-none rounded-md border text-sm px-3 py-2 outline-none focus:border-blue-300"
          />
          <button
            onClick={handleSend}
            disabled={(!displayText.trim() && !pendingAttachment) || sending}
            className="p-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {sending ? (
              <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
            ) : (
              <Send className="w-4 h-4" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
