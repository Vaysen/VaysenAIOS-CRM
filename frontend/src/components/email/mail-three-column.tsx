'use client';

import { useCallback, useState, useEffect, useRef } from 'react';
import api from '@/lib/api';
import {
  Mail, Search, Sparkles, Bot, Languages, FileText, Send, Clock, ChevronDown,
  Star, Paperclip, Reply, Forward, MoreHorizontal, Building2, Globe, Tag,
  TrendingUp, Lightbulb, MessageCircle, Target, Link2, Users, Briefcase,
  DollarSign, Activity, Search as SearchIcon, RefreshCw, ArrowRight, Loader2, Info
} from 'lucide-react';
import toast from 'react-hot-toast';
import { LanguageBadge } from '@/components/common/LanguageBadge';
import { getLanguageDisplay, getLanguageName } from '@/lib/language-constants';
import { sanitizeRichHtml } from '@/lib/sanitize-rich-html';
import { subscribeAssistantEmailDraft } from '@/lib/assistant-draft-events';
import {
  deliveryFailureFrom,
  listBusinessEmailAccounts,
  replySubject,
  sendBusinessEmail,
  type BusinessEmailAccount,
  type EmailDeliveryReceipt,
  type MessagingDeliveryFailure,
} from '@/lib/messaging-control-api';

export function MailThreeColumn() {
  const [tree, setTree] = useState<any[]>([]);
  const [messages, setMessages] = useState<any[]>([]);
  const [selected, setSelected] = useState<any>(null);
  const [preview, setPreview] = useState<any>(null);
  const [summary, setSummary] = useState('');
  const [translated, setTranslated] = useState('');
  const [drafts, setDrafts] = useState<string[]>([]);
  const [folder, setFolder] = useState('inbox');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [lastRefreshAt, setLastRefreshAt] = useState<Date | null>(null);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission>(
    typeof Notification === 'undefined' ? 'denied' : Notification.permission,
  );
  const [replyText, setReplyText] = useState('');
  const [emailAccounts, setEmailAccounts] = useState<BusinessEmailAccount[]>([]);
  const [emailAccountId, setEmailAccountId] = useState('');
  const [deliveryState, setDeliveryState] = useState<
    | { status: 'IDLE' }
    | { status: 'SENDING' }
    | EmailDeliveryReceipt
    | MessagingDeliveryFailure
  >({ status: 'IDLE' });
  const [aiSidebarTab, setAiSidebarTab] = useState<'ai' | 'activity' | 'profile'>('ai');

  // AI reply generation
  const [aiReplyLoading, setAiReplyLoading] = useState(false);
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const seenMessageIdsRef = useRef<Set<string>>(new Set());
  const seenBaselineReadyRef = useRef(false);

  useEffect(
    () =>
      subscribeAssistantEmailDraft((text) => {
        if (!selected) return false;
        setReplyText(text);
        queueMicrotask(() => replyRef.current?.focus());
      }),
    [selected],
  );

  const loadTree = useCallback(async () => {
    try {
      const response = await api.get('/mail-workbench/tree');
      const data = Array.isArray(response.data) ? response.data : [];
      setTree(data.length > 0 ? data : [
        { id: 'inbox', count: 0 },
        { id: 'sent', count: 0 },
        { id: 'drafts', count: 0 },
        { id: 'starred', count: 0 },
      ]);
    } catch (cause) {
      setTree([
        { id: 'inbox', count: 0 },
        { id: 'sent', count: 0 },
        { id: 'drafts', count: 0 },
        { id: 'starred', count: 0 },
      ]);
      throw cause;
    }
  }, []);

  const loadMessages = useCallback(async (notifyOnNew = false) => {
    setLoading(true);
    try {
      const response = await api.get('/mail-workbench/messages', {
        params: { folder, search, limit: 30 },
      });
      const data = Array.isArray(response.data?.data) ? response.data.data : [];
      if (folder === 'inbox') {
        const newMessages = seenBaselineReadyRef.current
          ? data.filter((item: any) => !seenMessageIdsRef.current.has(String(item.id)))
          : [];
        data.forEach((item: any) => seenMessageIdsRef.current.add(String(item.id)));
        seenBaselineReadyRef.current = true;
        if (notifyOnNew && newMessages.length > 0) {
          const latest = newMessages[0];
          toast.success(`收到 ${newMessages.length} 封新邮件：${latest.subject || '(无主题)'}`);
          if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
            new Notification('Vaysen AI CRM 收到新邮件', {
              body: `${latest.fromEmail || '未知发件人'} · ${latest.subject || '(无主题)'}`,
              tag: `mail-${String(latest.id)}`,
            });
          }
        }
      }
      setMessages(data);
      setLoadError(null);
      setLastRefreshAt(new Date());
    } catch (cause) {
      const failure = deliveryFailureFrom(cause);
      setMessages([]);
      setLoadError(`${failure.code}：${failure.message}`);
    } finally {
      setLoading(false);
    }
  }, [folder, search]);

  useEffect(() => {
    void Promise.allSettled([loadTree(), loadMessages(false)]);
  }, [folder, loadMessages, loadTree]);

  useEffect(() => {
    void listBusinessEmailAccounts()
      .then((accounts) => {
        setEmailAccounts(accounts);
        setEmailAccountId((current) => current || accounts[0]?.id || '');
      })
      .catch((cause) => setLoadError(deliveryFailureFrom(cause).message));
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && navigator.onLine) {
        void Promise.allSettled([loadTree(), loadMessages(true)]);
      }
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [loadMessages, loadTree]);

  const selectMessage = async (msg: any) => {
    setSelected(msg);
    setReplyText('');
    setDrafts([]);
    setPreview(null);
    setSummary('');
    setTranslated('');
    setDeliveryState({ status: 'IDLE' });

    try {
      const [detail, sum, trans] = await Promise.allSettled([
        api.get(`/mail-workbench/messages/${encodeURIComponent(msg.id)}`),
        api.post(`/mail-workbench/messages/${encodeURIComponent(msg.id)}/summarize`),
        api.post(`/mail-workbench/messages/${encodeURIComponent(msg.id)}/translate`, {
          targetLanguage: 'zh',
          sourceLanguage: msg.lead?.language || undefined,
        }),
      ]);
      if (detail.status === 'fulfilled') setPreview(detail.value.data);
      if (sum.status === 'fulfilled') setSummary(sum.value.data?.summary || '');
      if (trans.status === 'fulfilled') setTranslated(trans.value.data?.translated || '');
      if (detail.status === 'rejected') throw detail.reason;
      const draftRes = await api.post(`/mail-workbench/messages/${encodeURIComponent(msg.id)}/reply-drafts`, {
        targetLanguage: msg.lead?.language || 'en',
      });
      setDrafts(draftRes.data?.drafts || []);
    } catch (err) {
      console.error('Failed to load AI data for message:', err);
      setLoadError(deliveryFailureFrom(err).message);
    }
  };

  const generateAiReply = async () => {
    if (!selected) return;
    setAiReplyLoading(true);
    try {
      const targetLang = lead?.language || 'en';
      const r = await api.post(`/mail-workbench/messages/${encodeURIComponent(selected.id)}/reply-drafts`, {
        targetLanguage: targetLang,
      });
      const draft = Array.isArray(r.data?.drafts) ? r.data.drafts[0] || '' : '';
      if (!draft) throw new Error('AI 未返回可核验的回复草稿');
      setReplyText(draft);
    } catch (cause) {
      toast.error(deliveryFailureFrom(cause).message);
    } finally {
      setAiReplyLoading(false);
    }
  };

  const quickReply = () => {
    setReplyText('感谢您的来信。\n\n我们会尽快处理您的需求，如有任何问题请随时联系我们。\n\nBest regards');
  };

  const sendReply = async () => {
    const to = String(preview?.fromEmail || preview?.fromAddress || '').trim();
    const text = replyText.trim();
    if (!preview || !to || !text || !emailAccountId || deliveryState.status === 'SENDING') return;
    setDeliveryState({ status: 'SENDING' });
    try {
      const receipt = await sendBusinessEmail({
        emailAccountId,
        to,
        subject: replySubject(preview.subject),
        text,
        leadId: preview.lead?.id || selected?.lead?.id,
      });
      setDeliveryState(receipt);
      setReplyText('');
      toast.success(`邮件已由 SMTP 接受，回执 ${receipt.messageId}`);
      await Promise.allSettled([loadTree(), loadMessages(false)]);
    } catch (cause) {
      const failure = deliveryFailureFrom(cause);
      setDeliveryState(failure);
      toast.error(`${failure.code}：${failure.message}`);
    }
  };

  const enableDesktopNotifications = async () => {
    if (typeof Notification === 'undefined') {
      toast.error('当前客户端不支持桌面通知');
      return;
    }
    const permission = await Notification.requestPermission();
    setNotificationPermission(permission);
    if (permission === 'granted') toast.success('邮件桌面通知已启用');
    else toast.error('未获得桌面通知权限；微信通知状态请查看顶部状态条');
  };

  const groupByDate = (msgs: any[]) => {
    const now = new Date();
    const groups: Record<string, any[]> = { '今天': [], '昨天': [], '更早': [] };
    msgs.forEach(m => {
      const d = new Date(m.createdAt);
      const diff = now.getTime() - d.getTime();
      if (diff < 86400000 && d.getDate() === now.getDate()) groups['今天'].push(m);
      else if (diff < 172800000) groups['昨天'].push(m);
      else groups['更早'].push(m);
    });
    return Object.fromEntries(Object.entries(groups).filter(([, v]) => v.length > 0));
  };

  const grouped = groupByDate(messages);
  const lead = preview?.lead || selected?.lead;

  return (
    <div className="flex h-full">
      {/* ======== LEFT: Folder tree + email list ======== */}
      <div className="w-[300px] border-r bg-white flex flex-col shrink-0">
        {/* Folder tree */}
        <div className="p-2 border-b space-y-0.5">
          {[
            { id: 'inbox', l: '收件箱', icon: Mail },
            { id: 'sent', l: '已发送', icon: Send },
            { id: 'drafts', l: '草稿箱', icon: FileText },
            { id: 'starred', l: '星标邮件', icon: Star },
          ].map(f => (
            <button
              key={f.id}
              onClick={() => setFolder(f.id)}
              className={`w-full text-left text-[12px] px-2 py-1.5 rounded flex items-center justify-between transition-colors ${
                folder === f.id ? 'bg-blue-50 text-blue-700 font-medium' : 'text-gray-600 hover:bg-gray-50'
              }`}
            >
              <span className="flex items-center gap-2">
                <f.icon className="w-3.5 h-3.5" />
                {f.l}
              </span>
              <span className="text-[10px] text-gray-400 bg-gray-100 px-1.5 py-0.5 rounded-full">
                {tree.find((t: any) => t.id === f.id)?.count || 0}
              </span>
            </button>
          ))}
        </div>

        {/* Search */}
        <div className="px-2 py-1.5 border-b">
          <div className="flex items-center gap-1.5">
            <div className="relative flex-1">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-gray-300" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && loadMessages()}
              placeholder="搜索邮件..."
              className="w-full h-7 pl-7 pr-2 rounded border text-[11px] outline-none focus:border-blue-400 transition-colors"
            />
            </div>
            <button
              onClick={() => void loadMessages(false)}
              disabled={loading}
              className="h-7 w-7 inline-flex items-center justify-center rounded border text-gray-400 hover:text-blue-600 hover:border-blue-300 disabled:opacity-50"
              title="刷新真实邮件"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
          <div className="mt-1.5 flex items-center justify-between gap-2 text-[9px] text-gray-400">
            <span>
              {loadError
                ? `刷新失败：${loadError}`
                : lastRefreshAt
                  ? `已核验 ${lastRefreshAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
                  : '尚未完成首次核验'}
            </span>
            {notificationPermission !== 'granted' ? (
              <button
                type="button"
                onClick={() => void enableDesktopNotifications()}
                className="shrink-0 text-blue-600 hover:underline"
              >
                启用桌面提醒
              </button>
            ) : (
              <span className="shrink-0 text-emerald-600">桌面提醒已开启</span>
            )}
          </div>
        </div>

        {/* Email list */}
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="flex justify-center py-12">
              <Loader2 className="w-5 h-5 animate-spin text-gray-300" />
            </div>
          ) : messages.length === 0 ? (
            <div className="px-4 py-12 text-center">
              <Mail className="w-8 h-8 mx-auto text-gray-200 mb-2" />
              <p className="text-[12px] text-gray-400">暂无真实邮件</p>
              <p className="text-[10px] text-gray-300 mt-1">配置 Brevo 收信地址后，客户回复会自动显示在这里</p>
            </div>
          ) : Object.entries(grouped).map(([grp, items]) => (
            <div key={grp}>
              <div className="px-3 py-1 text-[10px] font-semibold text-gray-400 bg-gray-50/80 sticky top-0">
                {grp}
              </div>
              {items.map((m: any) => (
                <button
                  key={m.id}
                  onClick={() => selectMessage(m)}
                  className={`w-full text-left px-3 py-2.5 transition-colors ${
                    selected?.id === m.id
                      ? 'bg-blue-50 border-l-[3px] border-l-blue-500'
                      : 'border-l-[3px] border-l-transparent hover:bg-gray-50'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[12px] font-semibold text-gray-800 truncate max-w-[180px]">
                      {m.lead?.companyName || m.fromEmail?.split('@')[0] || '未知'}
                    </span>
                    <span className="text-[9px] text-gray-400 shrink-0">
                      {new Date(m.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>
                  <p className="text-[11px] font-medium text-gray-700 truncate mt-0.5">
                    {m.subject || '(无主题)'}
                  </p>
                  <p className="text-[10px] text-gray-400 truncate mt-0.5">
                    {m.bodyPreview || m.bodyText?.slice(0, 60) || '(无内容)'}
                  </p>
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* ======== CENTER: Email content + Reply toolbar ======== */}
      <div className="flex-1 bg-gray-50 flex flex-col overflow-hidden">
        {preview ? (
          <div className="flex-1 overflow-y-auto">
            <div className="max-w-3xl mx-auto p-4">
              {/* Email header */}
              <div className="bg-white rounded-lg border p-4 mb-3">
                <h2 className="text-lg font-bold text-gray-900 mb-3">{preview.subject || '(无主题)'}</h2>
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-1.5 text-[13px]">
                      <span className="font-semibold text-gray-800">
                        {preview.fromEmail || preview.fromAddress || '未知'}
                      </span>
                      <span className="text-gray-400 text-[11px]">发给</span>
                      <span className="font-semibold text-gray-800">
                        {preview.toEmail || preview.toAddress || '我'}
                      </span>
                    </div>
                    <div className="text-[11px] text-gray-400 mt-0.5">
                      {new Date(preview.createdAt).toLocaleString('zh-CN', {
                        year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
                      })}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 text-gray-400">
                    <button
                      type="button"
                      onClick={() => replyRef.current?.focus()}
                      className="p-1 hover:text-blue-500 hover:bg-blue-50 rounded"
                      title="回复"
                    >
                      <Reply className="w-4 h-4" />
                    </button>
                    <button className="p-1 hover:text-blue-500 hover:bg-blue-50 rounded" title="转发"><Forward className="w-4 h-4" /></button>
                    <button className="p-1 hover:text-amber-500 hover:bg-amber-50 rounded" title="星标"><Star className="w-4 h-4" /></button>
                    <button className="p-1 hover:text-gray-600 hover:bg-gray-100 rounded" title="更多"><MoreHorizontal className="w-4 h-4" /></button>
                  </div>
                </div>

                {/* Language detection + translate toggle */}
                <div className="mt-3 pt-3 border-t border-dashed flex items-center gap-2 text-[11px] flex-wrap">
                  <span className="text-gray-400">客户语言：</span>
                  {lead?.language ? (
                    <LanguageBadge language={lead.language} size="sm" showNative />
                  ) : (
                    <span className="text-gray-500">自动识别</span>
                  )}
                  <span className="text-gray-300">→</span>
                  <span className="bg-gray-100 px-1.5 py-0.5 rounded text-gray-600">中文（操作语言）</span>
                  <button
                    onClick={() => {
                      if (selected) api.post(`/mail-workbench/messages/${selected.id}/translate`, {
                        targetLanguage: 'zh',
                        sourceLanguage: lead?.language || undefined,
                      })
                        .then(r => setTranslated(r.data?.translated || '')).catch((error) => { console.error('[Frontend] background operation failed:', error); });
                    }}
                    className="text-blue-600 hover:underline ml-2"
                  >
                    翻译邮件
                  </button>
                </div>
              </div>

              {/* AI Translation Summary */}
              {summary && (
                <div className="bg-purple-50 border border-purple-200 rounded-lg p-3 mb-3 flex gap-2">
                  <Sparkles className="w-3.5 h-3.5 text-purple-500 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-[11px] font-semibold text-purple-700 mb-1">AI 翻译摘要</p>
                    <p className="text-[12px] text-purple-600 leading-relaxed">{summary}</p>
                  </div>
                </div>
              )}

              {/* Bilingual Translation */}
              {translated && (
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 mb-3 flex gap-2">
                  <Languages className="w-3.5 h-3.5 text-blue-500 shrink-0 mt-0.5" />
                  <div>
                    <p className="text-[11px] font-semibold text-blue-700 mb-1">双语翻译</p>
                    <p className="text-[12px] text-blue-600 leading-relaxed whitespace-pre-wrap">{translated}</p>
                  </div>
                </div>
              )}

              {/* Email body */}
              <div className="bg-white border rounded-lg p-4 text-[13px] leading-relaxed text-gray-800">
                {preview.bodyHtml ? (
                  <div dangerouslySetInnerHTML={{ __html: sanitizeRichHtml(preview.bodyHtml) }} />
                ) : preview.bodyText ? (
                  <div className="whitespace-pre-wrap">{preview.bodyText}</div>
                ) : (
                  <p className="text-gray-400">(无邮件正文)</p>
                )}
              </div>

              {/* Signature */}
              <div className="mt-3 p-3 bg-white border rounded-lg">
                <div className="flex items-start gap-2">
                  <div className="w-6 h-6 bg-red-500 text-white rounded text-[10px] font-bold flex items-center justify-center shrink-0">
                    J
                  </div>
                  <div>
                    <p className="text-[12px] font-semibold text-gray-800">Example Trading Company</p>
                    <p className="text-[10px] text-gray-400">Example Trading Company</p>
                    <p className="text-[10px] text-gray-400">Add: Haicang, Xiamen, China</p>
                  </div>
                </div>
              </div>

              {/* AI Reply Drafts */}
              {drafts.length > 0 && (
                <div className="mt-3 space-y-1.5">
                  <p className="text-[10px] font-semibold text-gray-500 flex items-center gap-1">
                    <Bot className="w-3 h-3" />AI 回复草稿
                    {lead?.language && (
                      <span className="text-purple-500">
                        ({getLanguageName(lead.language)})
                      </span>
                    )}
                    <span className="text-gray-400 font-normal">· 点击填入文本框，不自动发送</span>
                  </p>
                  {drafts.map((d: string, i: number) => (
                    <button
                      key={i}
                      onClick={() => setReplyText(d)}
                      className="w-full text-left p-2 bg-white border rounded text-[11px] text-gray-600 hover:bg-blue-50 hover:border-blue-200 transition-colors line-clamp-2"
                    >
                      {d.slice(0, 150)}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : selected ? (
          <div className="flex-1 flex justify-center items-center">
            <Loader2 className="w-6 h-6 animate-spin text-blue-400" />
          </div>
        ) : (
          <div className="flex-1 flex justify-center items-center">
            <div className="text-center">
              <Mail className="w-10 h-10 mx-auto text-gray-300 mb-2" />
              <p className="text-sm text-gray-400">选择左侧邮件查看内容</p>
            </div>
          </div>
        )}

        {/* Bottom Reply Toolbar */}
        {preview && (
          <div className="border-t bg-white px-4 py-3 shrink-0">
            <div className="max-w-3xl mx-auto">
              <div className="relative">
                <textarea
                  ref={replyRef}
                  value={replyText}
                  onChange={e => setReplyText(e.target.value)}
                  placeholder="输入回复内容，或点击下方 AI 快捷按钮..."
                  className="w-full h-16 px-3 py-2 border rounded-md text-[12px] outline-none focus:border-blue-400 transition-colors resize-none"
                />
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <label className="flex min-w-0 flex-1 items-center gap-1.5 text-[10px] text-gray-500">
                  <span className="shrink-0">发件账号</span>
                  <select
                    value={emailAccountId}
                    onChange={(event) => {
                      setEmailAccountId(event.target.value);
                      setDeliveryState({ status: 'IDLE' });
                    }}
                    className="min-w-0 flex-1 rounded border bg-white px-2 py-1 text-[10px] text-gray-700 outline-none focus:border-blue-400"
                  >
                    {emailAccounts.length === 0 && <option value="">没有可用 SMTP 账号</option>}
                    {emailAccounts.map((account) => (
                      <option key={account.id} value={account.id}>
                        {account.senderName} &lt;{account.senderEmail}&gt;
                      </option>
                    ))}
                  </select>
                </label>
                <span className="shrink-0 text-[10px] text-gray-400">
                  收件人：{preview.fromEmail || preview.fromAddress || '无有效回信地址'}
                </span>
              </div>

              {deliveryState.status !== 'IDLE' && (
                <div
                  className={`mt-2 rounded border px-2.5 py-1.5 text-[10px] ${
                    deliveryState.status === 'SUCCEEDED'
                      ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                      : deliveryState.status === 'SENDING'
                        ? 'border-blue-200 bg-blue-50 text-blue-700'
                        : deliveryState.status === 'BLOCKED'
                          ? 'border-amber-200 bg-amber-50 text-amber-800'
                          : 'border-red-200 bg-red-50 text-red-700'
                  }`}
                  role="status"
                  data-testid="email-delivery-receipt"
                >
                  {deliveryState.status === 'SENDING' && '正在等待 SMTP 服务端回执，尚未宣称发送成功……'}
                  {deliveryState.status === 'SUCCEEDED' && (
                    <span title={deliveryState.messageId}>
                      SMTP 已接受 · messageId：{deliveryState.messageId} · 接收方：{deliveryState.accepted.join(', ')}
                    </span>
                  )}
                  {(deliveryState.status === 'BLOCKED' || deliveryState.status === 'FAILED') && (
                    <span>{deliveryState.status} · {deliveryState.code}：{deliveryState.message}</span>
                  )}
                </div>
              )}

              <div className="flex justify-end gap-1.5 mt-2">
                <button
                  onClick={quickReply}
                  className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] rounded border bg-white text-gray-600 hover:bg-gray-50 transition-colors"
                >
                  <FileText className="w-3 h-3" /> 快速回复
                </button>
                <button
                  onClick={generateAiReply}
                  disabled={aiReplyLoading}
                  className="flex items-center gap-1 px-2.5 py-1.5 text-[11px] rounded border border-blue-300 bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-colors"
                >
                  {aiReplyLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                  {aiReplyLoading ? '生成中...' : 'AI 回复'}
                </button>
                <button
                  type="button"
                  onClick={() => void sendReply()}
                  disabled={
                    !replyText.trim()
                    || !emailAccountId
                    || !(preview.fromEmail || preview.fromAddress)
                    || deliveryState.status === 'SENDING'
                  }
                  className="flex items-center gap-1 rounded bg-emerald-600 px-3 py-1.5 text-[11px] font-medium text-white hover:bg-emerald-700 disabled:opacity-40"
                >
                  {deliveryState.status === 'SENDING' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
                  {deliveryState.status === 'SENDING' ? '发送中' : '真实发送回复'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ======== RIGHT: AI Sidebar (ENHANCED) ======== */}
      <div className="w-[340px] border-l bg-white shrink-0 overflow-y-auto flex flex-col">
        {/* Client Context Card */}
        {lead ? (
          <div className="p-3 border-b bg-gray-50/30">
            <div className="flex items-start justify-between mb-1.5">
              <div>
                <div className="flex items-center gap-1.5">
                  <span className="text-[13px] font-bold text-gray-900 truncate max-w-[160px]">
                    {lead.companyName || lead.contactName || '未知'}
                  </span>
                  {lead.leadGrade && (
                    <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-medium ${
                      lead.leadGrade === 'A' ? 'bg-green-100 text-green-700' :
                      lead.leadGrade === 'B' ? 'bg-blue-100 text-blue-700' :
                      'bg-gray-100 text-gray-600'
                    }`}>
                      {lead.leadGrade}级
                    </span>
                  )}
                  {lead.language && (
                    <LanguageBadge language={lead.language} size="sm" />
                  )}
                </div>
                <div className="text-[10px] text-gray-400 mt-0.5">
                  跟进人: <span className="text-blue-600">chris</span>
                </div>
                <div className="flex flex-wrap gap-1.5 mt-1 text-[9px] text-gray-400">
                  <span>客户编号: {String(lead.id).slice(0, 8)}</span>
                  <span>| 客户阶段: <span className="text-blue-600">主动营销中</span></span>
                  <span>| 标签: +</span>
                </div>
              </div>
            </div>

            {/* Sub tabs */}
            <div className="flex border-b mt-2 text-[11px]">
              {(['ai', 'activity', 'profile'] as const).map(t => (
                <button
                  key={t}
                  onClick={() => setAiSidebarTab(t)}
                  className={`px-2.5 py-1.5 border-b-2 transition-colors ${
                    aiSidebarTab === t ? 'border-blue-500 text-blue-700 font-medium' : 'border-transparent text-gray-400 hover:text-gray-600'
                  }`}
                >
                  {t === 'ai' ? 'AI 分析' : t === 'activity' ? '动态' : '资料'}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="p-3 border-b">
            <p className="text-[11px] text-gray-400">未关联客户</p>
          </div>
        )}

        {/* AI Panel Content */}
        <div className="flex-1 overflow-y-auto p-3">
          {lead && aiSidebarTab === 'ai' && (
            <div className="space-y-3">
              <p className="text-[10px] text-gray-400">{'>'} 基于沟通记录、联系人及公司信息得出</p>

              {/* Business Analysis Card */}
              <div className="bg-white border rounded-lg p-3">
                <div className="flex items-center gap-1.5 mb-2">
                  <Search className="w-3.5 h-3.5 text-blue-500" />
                  <span className="text-[12px] font-semibold text-gray-800">商机分析</span>
                </div>

                {/* Enterprise Tags */}
                <div className="flex flex-wrap gap-1 mb-2">
                  {['包装制品采购商', '北美市场', '高潜力客户'].map(tag => (
                    <span key={tag} className="text-[9px] px-1.5 py-0.5 rounded-full bg-blue-50 text-blue-600 border border-blue-100">
                      {tag}
                    </span>
                  ))}
                </div>

                {/* Background Overview */}
                <div className="mb-2">
                  <p className="text-[10px] font-semibold text-gray-700 mb-0.5">背景概览</p>
                  <p className="text-[10px] text-gray-600 leading-relaxed">
                    {lead.companyName || '该客户'} 是一家位于{lead.country || '海外'}的包装制品采购企业。
                    从邮件沟通内容来看，客户对产品质量和交期有较高要求，建议提供完整的样品和认证资料以建立信任。
                  </p>
                </div>

                {/* Main Products */}
                <div className="bg-gray-50 rounded p-2 mb-2">
                  <p className="text-[10px] font-semibold text-gray-700 mb-1">主营产品</p>
                  <p className="text-[10px] text-gray-500">包装制品采购与分销</p>
                </div>

                {/* Social Media */}
                <div className="bg-gray-50 rounded p-2 mb-2">
                  <p className="text-[10px] font-semibold text-gray-700 mb-1">社媒</p>
                  <span className="text-[10px] text-blue-600 flex items-center gap-1">
                    <Link2 className="w-3 h-3" /> 暂无社媒数据
                  </span>
                </div>

                {/* Website */}
                <div className="flex items-center gap-1 text-[10px]">
                  <span className="text-gray-400">官网</span>
                  {lead.website ? (
                    <a href={lead.website} target="_blank" className="text-blue-600 hover:underline flex items-center gap-0.5">
                      <Globe className="w-3 h-3" />{lead.website}
                    </a>
                  ) : (
                    <span className="text-gray-400">—</span>
                  )}
                </div>

                <button className="w-full mt-3 py-1.5 text-[10px] rounded border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 transition-colors flex items-center justify-center gap-1">
                  查看商机详情 <ArrowRight className="w-3 h-3" />
                </button>
              </div>

              {/* Customer Portrait Summary */}
              <div>
                <p className="text-[10px] text-gray-400 mb-1.5">{'>'} 基于沟通记录、联系人及公司信息得出</p>
                <div className="bg-white border rounded-lg p-3">
                  <div className="flex items-center gap-1.5 mb-2">
                    <Target className="w-3.5 h-3.5 text-purple-500" />
                    <span className="text-[12px] font-semibold text-gray-800">客户画像摘要</span>
                  </div>
                  <p className="text-[10px] text-gray-600 leading-relaxed">
                    {lead.companyName || '该客户'} 是{(lead as any)?.country ? `来自${(lead as any).country}的` : ''}
                    潜在包装制品采购商。从沟通记录来看，客户关注产品质量、价格竞争力和交期可靠性。
                    建议以“专业包装解决方案”为切入点，提供样品支持和定制化服务方案。
                  </p>
                </div>
              </div>
            </div>
          )}

          {lead && aiSidebarTab === 'activity' && (
            <div className="text-center py-8">
              <Activity className="w-8 h-8 mx-auto text-gray-300 mb-2" />
              <p className="text-[11px] text-gray-400">暂无近期动态</p>
            </div>
          )}

          {lead && aiSidebarTab === 'profile' && (
            <div className="text-center py-8">
              <Users className="w-8 h-8 mx-auto text-gray-300 mb-2" />
              <p className="text-[11px] text-gray-400">客户资料概要</p>
              <div className="text-[10px] text-gray-500 mt-2 space-y-1">
                {lead.country && <p>国家: {lead.country}</p>}
                {lead.contactEmail && <p>邮箱: {lead.contactEmail}</p>}
                {lead.contactPhone && <p>电话: {lead.contactPhone}</p>}
              </div>
            </div>
          )}
        </div>

        {/* Bottom Quick Tool Bar */}
        <div className="border-t bg-gray-50/50 px-3 py-2.5 flex justify-around text-[10px] text-gray-500 shrink-0">
          {[
            { label: '商机分析', icon: TrendingUp },
            { label: '行动建议', icon: Target },
            { label: '话术指南', icon: MessageCircle },
            { label: '发起背调', icon: Search },
            { label: '写跟进', icon: FileText },
          ].map(item => (
            <button
              key={item.label}
              className="flex flex-col items-center gap-0.5 hover:text-blue-600 transition-colors"
              title={item.label}
            >
              <item.icon className="w-3.5 h-3.5" />
              <span className="text-[9px]">{item.label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
