'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import { ConversationSidebar } from './conversation-sidebar';
import { CustomerCard } from './customer-card';
import { AiAssistantPanel } from './ai-assistant-panel';
import { mockConversations, getMockConversationDetail } from './mock-data';
import type { ConversationDetail, ConversationSummary } from './types';
import api from '@/lib/api';
import { useAuthStore } from '@/store/authStore';
import { CheckCheck, Check, MoreHorizontal, Sparkles, FileText, ChevronDown, UserPlus, Archive, RotateCcw, Paperclip, X, MessageCircle } from 'lucide-react';
import { QuotePIForm } from './quote-pi-popup';
import { subscribeAssistantEmailDraft } from '@/lib/assistant-draft-events';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || '/api';
const BACKEND_URL = API_BASE.replace(/\/api$/, '');
function fileUrl(url: string): string {
  if (!url) return '';
  if (url.startsWith('http')) return url;
  return `${BACKEND_URL}${url}`;
}

export function CommunicationWorkbench() {
  const currentUser = useAuthStore((s) => s.user);
  const searchParams = useSearchParams();
  const channelFilter = searchParams.get('channel');
  const sessionIdFilter = searchParams.get('sessionId');
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const selectedIdRef = useRef<string | null>(null);

  const loadConversations = useCallback(async () => {
    try {
      const params: any = { limit: 50 };
      if (channelFilter) params.channel = channelFilter;
      const res = await api.get('/communications/conversations', { params });
      if (res.data?.data?.length > 0) setConversations(res.data.data);
      else setConversations([]);
    } catch (err) {
      console.error('[CommunicationWorkbench] loadConversations failed:', err);
    }
  }, [channelFilter]);

  const refreshConversationDetail = useCallback(async (id: string) => {
    try {
      const res = await api.get(`/communications/conversations/${id}`);
      if (res.data) setDetail(res.data);
    } catch (err) {
      console.error('[CommunicationWorkbench] refreshConversationDetail failed:', err);
    }
  }, []);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ConversationDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [draft, setDraftState] = useState('');
  const [customerAvatar, setCustomerAvatar] = useState<string | null>(null);
  const avatarCacheRef = useRef<Record<string, string | null>>({});

  const [statusMenuOpen, setStatusMenuOpen] = useState(false);
  const [assignMenuOpen, setAssignMenuOpen] = useState(false);
  const [teamUsers, setTeamUsers] = useState<any[]>([]);
  const [quoteFormType, setQuoteFormType] = useState<'quote' | 'pi' | 'sample' | null>(null);

  const translateTimerRef = useRef<any>(null);
  const translateCtrlRef = useRef<AbortController | null>(null);
  const statusMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => () => {
    if (translateTimerRef.current) clearTimeout(translateTimerRef.current);
    translateCtrlRef.current?.abort();
  }, [channelFilter]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (statusMenuRef.current && !statusMenuRef.current.contains(e.target as Node)) {
        setStatusMenuOpen(false);
        setAssignMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const setDraft = useCallback((text: string) => {
    setDraftState(text);
    if (translateTimerRef.current) clearTimeout(translateTimerRef.current);
    if (translateCtrlRef.current) translateCtrlRef.current.abort();
    if (!/[一-鿿]/.test(text)) return;
    translateTimerRef.current = setTimeout(async () => {
      const ctrl = new AbortController();
      translateCtrlRef.current = ctrl;
      try {
        const targetLang = detail?.lead?.language || 'en';
        const res = await api.post('/ai-communications/translate-draft', { text, targetLanguage: targetLang }, { signal: ctrl.signal });
        if (res.data?.draft) setDraftState(res.data.draft);
      } catch (err) {
        console.error('[CommunicationWorkbench] draft translate failed:', err);
      }
    }, 800);
  }, [detail?.lead?.language]);

  useEffect(
    () =>
      subscribeAssistantEmailDraft((text) => {
        if (!detail) return false;
        setDraftState(text);
      }),
    [detail],
  );

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true); setError(null);
      try {
        const params: any = { limit: 50 };
        if (channelFilter) params.channel = channelFilter;
        const res = await api.get('/communications/conversations', { params });
        if (!cancelled) {
          if (res.data?.data?.length > 0) setConversations(res.data.data);
          else setConversations([]);
        }
      } catch (err: any) {
        if (!cancelled) {
          if (err?.response?.status === 401) setError('请先登录');
          else if (process.env.NODE_ENV === 'development') setConversations(mockConversations);
          else setError('加载失败');
        }
      } finally { if (!cancelled) setLoading(false); }
    }
    load();
    return () => { cancelled = true; };
  }, [channelFilter, loadConversations]);

  // ═══════════════════════════════════════════════════════════
  // 实时消息监听 — 纯轮询方案（最可靠，不依赖 SSE/WebSocket）
  // 每 10 秒：刷新会话列表 + 刷新选中会话消息 + 新消息通知
  // 标签页隐藏或浏览器离线时暂停请求，避免重复请求与无意义失败
  // 新消息到达时：提示音 + 浏览器通知 + 页面 Toast + 标签标题
  // ═══════════════════════════════════════════════════════════
  const POLL_INTERVAL_MS = 10000;
  const [newMsgToast, setNewMsgToast] = useState<{ name: string; preview: string } | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const originalTitleRef = useRef<string>('');
  const [pollingActive, setPollingActive] = useState(false);
  const [isOffline, setIsOffline] = useState(false);

  useEffect(() => {
    let active = true;
    const prevLastMsgAt: Record<string, string> = {};
    let initialized = false;
    let pollCount = 0;

    const playBeep = () => {
      try {
        const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
        [880, 1100].forEach((freq, i) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.connect(gain); gain.connect(ctx.destination);
          osc.frequency.value = freq; osc.type = 'sine';
          const t = ctx.currentTime + i * 0.12;
          gain.gain.setValueAtTime(0.15, t);
          gain.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
          osc.start(t); osc.stop(t + 0.15);
        });
      } catch (error) { console.error('[Frontend] operation failed:', error); }
    };

    const poll = async () => {
      if (!active) return;
      // 标签页隐藏或离线时跳过请求，避免重复请求与无意义失败
      if (typeof document !== 'undefined' && document.hidden) return;
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        setIsOffline(true);
        return;
      }
      setIsOffline(false);
      pollCount++;
      try {
        const params: any = { limit: 50 };
        if (channelFilter) params.channel = channelFilter;
        const res = await api.get('/communications/conversations', { params });
        if (!active || !res.data?.data) return;
        const newConvs: ConversationSummary[] = res.data.data;

        // 检测新消息
        if (initialized) {
          for (const conv of newConvs) {
            const prev = prevLastMsgAt[conv.id];
            if (prev !== undefined && prev !== conv.lastMessageAt) {
              const name = conv.lead?.companyName || '未知客户';
              const preview = conv.lastMessagePreview || '新消息';
              console.log('[Poll #' + pollCount + '] 新消息: ' + name + ' — ' + preview);
              playBeep();
              setNewMsgToast({ name, preview });
              if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
              toastTimerRef.current = setTimeout(() => setNewMsgToast(null), 5000);
              if ('Notification' in window && Notification.permission === 'granted') {
                try { new Notification('💬 ' + name, { body: preview, tag: 'whatsapp-msg' }); } catch (error) { console.error('[Frontend] operation failed:', error); }
              }
              break;
            }
          }
        }
        for (const conv of newConvs) {
          if (conv.lastMessageAt) prevLastMsgAt[conv.id] = conv.lastMessageAt;
        }
        initialized = true;

        // 无条件更新会话列表
        setConversations(newConvs);

        // 更新标签标题
        const totalUnread = newConvs.reduce((s, c) => s + (c.unreadCount || 0), 0);
        document.title = totalUnread > 0 ? '(' + totalUnread + '条未读) 会话中心' : (originalTitleRef.current || '会话中心');

        // 刷新选中会话消息
        if (selectedIdRef.current) {
          try {
            const detailRes = await api.get('/communications/conversations/' + selectedIdRef.current);
            if (active && detailRes.data) {
              setDetail(prev => {
                if (!prev) return detailRes.data;
                const prevLen = prev.messages?.length || 0;
                const newLen = detailRes.data.messages?.length || 0;
                if (newLen > prevLen) {
                  console.log('[Poll #' + pollCount + '] 选中会话新消息: ' + prevLen + ' → ' + newLen);
                }
                if (newLen === prevLen && prev.lastMessageAt === detailRes.data.lastMessageAt) return prev;
                return detailRes.data;
              });
              const avatar = (detailRes.data as any)?.contactPoint?.avatarUrl;
              if (avatar) {
                avatarCacheRef.current[selectedIdRef.current] = avatar;
                setCustomerAvatar(avatar);
              }
            }
          } catch (err) {
            console.error('[Poll #' + pollCount + '] 选中会话刷新失败:', err);
          }
        }

        if (pollCount <= 3 || pollCount % 30 === 0) {
          console.log('[Poll #' + pollCount + '] OK — ' + newConvs.length + '个会话, ' + totalUnread + '条未读');
        }
      } catch (err) {
        console.error('[Poll #' + pollCount + '] Error:', err);
      }
    };

    setPollingActive(true);
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    poll();
    console.log('[Poll] 实时轮询已启动 — ' + POLL_INTERVAL_MS / 1000 + '秒间隔');

    return () => {
      active = false;
      setPollingActive(false);
      clearInterval(interval);
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      console.log('[Poll] 实时轮询已停止');
    };
  }, [channelFilter]);

  // 请求浏览器通知权限 + 恢复标签标题
  useEffect(() => {
    originalTitleRef.current = document.title;
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().then((perm) => {
        console.log('[Notification] Permission:', perm);
      });
    }
    return () => { document.title = originalTitleRef.current; };
  }, []);

  const handleSelect = useCallback(async (id: string) => {
    setSelectedId(id); setError(null);
    selectedIdRef.current = id;

    // 从缓存快速设置头像
    setCustomerAvatar(avatarCacheRef.current[id] ?? null);

    try {
      const res = await api.get(`/communications/conversations/${id}`);
      if (res.data) {
        setDetail(res.data);
        // 优先使用 ContactPoint 缓存的头像
        const cachedAvatar = (res.data as any)?.contactPoint?.avatarUrl;
        if (cachedAvatar) {
          avatarCacheRef.current[id] = cachedAvatar;
          setCustomerAvatar(cachedAvatar);
        }
      }
      api.patch(`/communications/conversations/${id}/read`).catch((error) => { console.error('[Frontend] background operation failed:', error); });
      setConversations(prev => prev.map(c => c.id === id ? { ...c, unreadCount: 0 } : c));

      // 异步获取客户头像（不阻塞会话加载）— 仅当没有缓存时
      if (!avatarCacheRef.current[id]) {
        api.get(`/whatsapp/conversations/${id}/avatar`).then(avatarRes => {
          const url = avatarRes.data?.avatarUrl || null;
          avatarCacheRef.current[id] = url;
          setCustomerAvatar(url);
        }).catch((error) => { console.error('[Frontend] background operation failed:', error); });
      }
    } catch {
      // Fallback: use mock detail only when API fails
      if (process.env.NODE_ENV === 'development') {
        const mock = getMockConversationDetail(id);
        if (mock) setDetail(mock);
      }
    }
  }, []);

  const handleSend = useCallback(async (content: string, attachment?: any) => {
    if (!detail || !selectedId || (!content.trim() && !attachment)) return;
    setSending(true);
    setError(null);
    try {
      const payload: any = {
        direction: 'outbound',
        content: content || '',
        contentType: attachment ? attachment.mediaType : 'text',
      };
      if (attachment) {
        payload.attachmentsMeta = {
          url: attachment.url,
          originalName: attachment.originalName,
          filename: attachment.url.split('/').pop(),
          mimeType: attachment.mimeType,
          size: attachment.size,
        };
      }
      await api.post(`/communications/conversations/${selectedId}/messages`, payload);
      const now = new Date().toISOString();
      // 媒体消息的预览文本
      const previewText = attachment
        ? (content ? content : (
            attachment.mediaType === 'image' ? '[图片]' :
            attachment.mediaType === 'video' ? '[视频]' :
            attachment.mediaType === 'audio' ? '[语音消息]' :
            `[文档] ${attachment.originalName}`
          ))
        : content;
      setDetail((prev: any) => prev ? {
        ...prev, messages: [...prev.messages, { id: `msg-${Date.now()}`, direction: 'outbound', content: content || '', contentType: attachment ? attachment.mediaType : 'text', attachmentsMeta: attachment ? payload.attachmentsMeta : null, fromAddress: 'whatsapp-session', sentAt: now, createdAt: now }],
        lastMessageAt: now, lastMessagePreview: previewText.substring(0, 200),
      } : prev);
      // 刷新会话列表以更新最后消息
      loadConversations();
    } catch (err: any) {
      const errMsg = err?.response?.data?.message || err?.message || '发送失败，请检查网络连接';
      setError(`发送失败: ${errMsg}`);
      alert(`消息发送失败：${errMsg}`);
    }
    finally { setSending(false); }
  }, [detail, selectedId, loadConversations]);

  const changeStatus = async (status: "active" | "archived" | "closed") => {
    if (!selectedId) return;
    try {
      await api.patch(`/communications/conversations/${selectedId}/status`, { status });
      setDetail((prev: any) => prev ? { ...prev, status } : prev);
      setConversations(prev => prev.map(c => c.id === selectedId ? { ...c, status } : c));
    } catch (error) { console.error('[Frontend] operation failed:', error); }
    setStatusMenuOpen(false);
  };

  const assignTo = async (userId: string | null) => {
    if (!selectedId) return;
    try {
      const res = await api.patch(`/communications/conversations/${selectedId}/assign`, { assignedUserId: userId });
      setDetail((prev: any) => prev ? {
        ...prev, assignedUser: res.data?.assignedUser || null,
      } : prev);
    } catch (error) { console.error('[Frontend] operation failed:', error); }
    setAssignMenuOpen(false);
  };

  useEffect(() => {
    api.get('/users').then(r => setTeamUsers(r.data?.data || [])).catch((error) => { console.error('[Frontend] background operation failed:', error); });
  }, []);

  const [slashOpen, setSlashOpen] = useState(false);
  const [pendingAttachment, setPendingAttachment] = useState<any>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const SLASH_OPTIONS = [
    { label:'首次回复', text:'感谢您的询盘！请问您需要什么材质和规格？' },
    { label:'询问数量', text:'请问您需要的数量是多少？' },
    { label:'询问材质', text:'请问您对材质有什么要求？' },
    { label:'交期说明', text:'交期需根据数量、材质和排产情况确认。' },
    { label:'样品说明', text:'我们可以提供样品供您确认，详情请联系业务员。' },
  ];

  const handleDraftKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === '/' && !draft) { e.preventDefault(); setSlashOpen(true); return; }
    if (e.key === 'Escape') { setSlashOpen(false); return; }
    if (e.key === 'Enter' && !e.shiftKey && (draft.trim() || pendingAttachment)) { e.preventDefault(); handleSend(draft, pendingAttachment||undefined); setDraftState(''); setPendingAttachment(null); }
  };

  const selectSlash = (text: string) => { setDraft(text); setSlashOpen(false); };

  // 自动滚动到最新消息
  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [detail?.messages, selectedId]);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      // 不手动设置 Content-Type，让 axios 自动为 FormData 添加 boundary
      const res = await api.post('/communications/upload', formData, {
        timeout: 30000,
      });
      const result = res.data;
      setPendingAttachment({
        url: result.url,
        originalName: result.originalName,
        mimeType: result.mimeType,
        mediaType: result.mediaType,
        size: result.size,
      });
    } catch {
      alert('文件上传失败，请重试');
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const getCountryTime = (country: string | null | undefined) => {
    if (!country) return '';
    const tzMap: Record<string, string> = {
      'China':'Asia/Shanghai','Canada':'America/Toronto','Germany':'Europe/Berlin',
      'Argentina':'America/Argentina/Buenos_Aires','UK':'Europe/London','United Kingdom':'Europe/London',
      'UAE':'Asia/Dubai','USA':'America/New_York','Brazil':'America/Sao_Paulo',
      'India':'Asia/Kolkata','Japan':'Asia/Tokyo','Korea':'Asia/Seoul',
      'Australia':'Australia/Sydney','France':'Europe/Paris','Italy':'Europe/Rome',
      'Spain':'Europe/Madrid','Mexico':'America/Mexico_City','Pakistan':'Asia/Karachi',
      'Croatia':'Europe/Zagreb','Sweden':'Europe/Stockholm','New Zealand':'Pacific/Auckland',
      'Malaysia':'Asia/Kuala_Lumpur','Russia':'Europe/Moscow','Turkey':'Europe/Istanbul',
      'Thailand':'Asia/Bangkok','Vietnam':'Asia/Ho_Chi_Minh','Indonesia':'Asia/Jakarta',
      'Singapore':'Asia/Singapore','Netherlands':'Europe/Amsterdam','Poland':'Europe/Warsaw',
      'South Africa':'Africa/Johannesburg','Nigeria':'Africa/Lagos',
    };
    const tz = tzMap[country] || 'UTC';
    try {
      const now = new Date();
      const parts = now.toLocaleTimeString('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: true }).split(' ');
      const time = parts[0]; const ampm = parts[1];
      const hour = parseInt(time.split(':')[0], 10);
      const isPM = ampm === 'PM';
      const h24 = isPM && hour !== 12 ? hour + 12 : !isPM && hour === 12 ? 0 : hour;
      let period = '凌晨';
      if (h24 >= 6 && h24 <= 8) period = '早晨';
      else if (h24 >= 9 && h24 <= 11) period = '上午';
      else if (h24 >= 12 && h24 <= 13) period = '中午';
      else if (h24 >= 14 && h24 <= 17) period = '下午';
      else if (h24 >= 18) period = '晚上';
      return period + ' ' + time;
    } catch { return ''; }
  };

  const statusLabel = (s: string) => s === 'active' ? '活跃' : s === 'archived' ? '已解决' : s === 'closed' ? '已关闭' : s;
  const statusColor = (s: string) => s === 'active' ? 'bg-green-100 text-green-700' : s === 'archived' ? 'bg-gray-100 text-gray-500' : 'bg-red-50 text-red-600';

  return (
    <div className="flex flex-col lg:flex-row h-full w-full overflow-hidden relative">
      {isOffline && (
        <div className="shrink-0 bg-amber-50 border-b border-amber-200 px-4 py-1.5 flex items-center gap-2 text-[11px] text-amber-700">
          <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
          网络已离线，自动刷新已暂停。恢复连接后将自动继续。
        </div>
      )}
      {/* 新消息 Toast 通知 — 右上角弹出，5秒后消失 */}
      {newMsgToast && (
        <div
          className="fixed top-4 right-4 z-[10000] bg-white border-l-4 border-green-500 rounded-lg shadow-xl px-4 py-3 flex items-center gap-3 min-w-[280px] max-w-[400px] animate-[slideIn_0.3s_ease-out]"
          onClick={() => setNewMsgToast(null)}
          style={{ cursor: 'pointer', animation: 'slideInRight 0.3s ease-out' }}
        >
          <div className="w-10 h-10 rounded-full bg-green-100 flex items-center justify-center shrink-0">
            <MessageCircle className="w-5 h-5 text-green-600" />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-gray-900 truncate">{newMsgToast.name}</p>
            <p className="text-xs text-gray-500 truncate">{newMsgToast.preview}</p>
          </div>
          <button
            className="text-gray-400 hover:text-gray-600 shrink-0"
            onClick={(e) => { e.stopPropagation(); setNewMsgToast(null); }}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}
      <style>{`
        @keyframes slideInRight {
          from { transform: translateX(120%); opacity: 0; }
          to { transform: translateX(0); opacity: 1; }
        }
        @keyframes pulse-green {
          0%, 100% { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.4); }
          50% { box-shadow: 0 0 0 6px rgba(34, 197, 94, 0); }
        }
      `}</style>
      <div className="w-full lg:w-[260px] shrink-0 h-[40vh] lg:h-full border-b lg:border-b-0 lg:border-r overflow-hidden">
        <ConversationSidebar conversations={conversations} selectedId={selectedId} onSelect={handleSelect} />
      </div>

      <div className="flex-1 min-w-0 flex flex-col min-h-0 overflow-hidden relative">
        {loading ? (
          <div className="flex-1 flex items-center justify-center"><p className="text-sm text-gray-400">加载中...</p></div>
        ) : error && !detail ? (
          <div className="flex-1 flex items-center justify-center"><p className="text-sm text-red-500">{error}</p></div>
        ) : detail ? (
          <>
            {/* 错误提示条 */}
            {error && (
              <div className="shrink-0 bg-red-50 border-b border-red-200 px-4 py-2 flex items-center justify-between text-sm text-red-700">
                <span>{error}</span>
                <button onClick={() => setError(null)} className="text-red-500 hover:text-red-700">
                  <X className="w-4 h-4" />
                </button>
              </div>
            )}
            <div className="shrink-0 border-b bg-white px-4 py-2 flex items-center gap-3 text-[11px] text-gray-600" ref={statusMenuRef}>
              {/* 客户头像 — 在头部显示 */}
              <div className="w-9 h-9 rounded-full overflow-hidden shrink-0 bg-blue-100 flex items-center justify-center">
                {customerAvatar ? (
                  <img src={customerAvatar} alt="客户头像" className="w-full h-full object-cover"
                       onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                ) : (
                  <span className="text-sm font-bold text-blue-700">
                    {(detail.lead?.companyName?.charAt(0) || detail.lead?.contactName?.charAt(0) || '客').toUpperCase()}
                  </span>
                )}
              </div>
              {detail.lead ? (
                <>
                  <span className="font-semibold text-gray-900 truncate max-w-[160px]">
                    {detail.lead.companyName || detail.lead.contactName || '未知客户'}
                  </span>
                  {detail.lead.country && (
                    <span className="flex items-center gap-1 text-gray-500">
                      <svg className="w-3 h-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>
                      {detail.lead.country} <span className="text-gray-400 ml-1">{getCountryTime(detail.lead.country)}</span>
                    </span>
                  )}
                  <span className="text-gray-300">|</span>
                  <span className="text-gray-500 text-[10px]">
                    {detail.channel === 'whatsapp' ? 'WhatsApp' :
                     detail.channel === 'website_inquiry' ? '网站询盘' :
                     detail.channel === 'website_livechat' ? '实时客服' : detail.channel || '—'}
                  </span>
                  {(() => {
                    const leadWhatsapp = (detail as any).lead?.whatsapp;
                    const cpOriginal = (detail as any).contactPoint?.originalValue;
                    const cpNormalized = (detail as any).contactPoint?.normalizedValue;
                    // 优先显示真实手机号，隐藏 LID/群组 JID 格式
                    const displayPhone =
                      (leadWhatsapp && !leadWhatsapp.includes('@')) ? leadWhatsapp :
                      (cpNormalized && !cpNormalized.includes('@')) ? cpNormalized :
                      (cpOriginal && !cpOriginal.includes('@')) ? cpOriginal :
                      null;
                    if (!displayPhone) return null;
                    return (
                      <>
                        <span className="text-gray-300">|</span>
                        <span className="text-green-600 font-mono text-[10px]">{displayPhone}</span>
                      </>
                    );
                  })()}
                </>
              ) : (
                <span className="font-semibold text-gray-900">{(detail as any).subject || '会话'}</span>
              )}
              <div className="flex-1" />

              {/* 实时监听状态指示器 */}
              {pollingActive && !isOffline && (
                <span className="flex items-center gap-1 text-[9px] text-green-600 font-medium" title="每10秒自动刷新消息">
                  <span className="relative flex h-2 w-2">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                    <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
                  </span>
                  实时监听中
                </span>
              )}
              {isOffline && (
                <span className="flex items-center gap-1 text-[9px] text-amber-600 font-medium" title="网络已离线，已暂停自动刷新">
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500"></span>
                  离线（已暂停刷新）
                </span>
              )}

              <span className={`text-[9px] px-1.5 py-0.5 rounded-full font-medium ${statusColor(detail.status || 'active')}`}>
                {statusLabel(detail.status || 'active')}
              </span>

              <div className="relative">
                <button onClick={() => { setAssignMenuOpen(!assignMenuOpen); setStatusMenuOpen(false); }}
                  className="text-[9px] text-gray-400 hover:text-blue-600 flex items-center gap-0.5" title="分配">
                  <UserPlus className="w-3 h-3" />
                  {detail.assignedUser ? (detail.assignedUser as any).firstName || '已分配' : ''}
                </button>
                {assignMenuOpen && (
                  <div className="absolute right-0 top-5 z-30 w-36 bg-white border rounded-lg shadow-lg py-1 text-[10px]">
                    <button onClick={() => assignTo(null)} className="w-full text-left px-3 py-1.5 hover:bg-gray-50 text-gray-500">取消分配</button>
                    <button onClick={() => assignTo(currentUser?.id ?? null)} className="w-full text-left px-3 py-1.5 hover:bg-gray-50">分配给我</button>
                    <div className="border-t my-0.5" />
                    {teamUsers.slice(0, 5).map((u: any) => (
                      <button key={u.id} onClick={() => assignTo(u.id)} className="w-full text-left px-3 py-1.5 hover:bg-gray-50 truncate">
                        {u.firstName || u.email?.split('@')[0]}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="relative">
                <button onClick={() => { setStatusMenuOpen(!statusMenuOpen); setAssignMenuOpen(false); }}
                  className="text-gray-400 hover:text-gray-600 p-0.5">
                  <MoreHorizontal className="w-3.5 h-3.5" />
                </button>
                {statusMenuOpen && (
                  <div className="absolute right-0 top-5 z-30 w-32 bg-white border rounded-lg shadow-lg py-1 text-[10px]">
                    <button onClick={() => changeStatus('archived')} className="w-full text-left px-3 py-1.5 hover:bg-gray-50 flex items-center gap-1.5">
                      <Archive className="w-3 h-3" />标记已解决
                    </button>
                    <button onClick={() => changeStatus('closed')} className="w-full text-left px-3 py-1.5 hover:bg-gray-50 flex items-center gap-1.5 text-red-600">
                      <Archive className="w-3 h-3" />关闭会话
                    </button>
                    {(detail.status !== 'active') && (
                      <button onClick={() => changeStatus('active')} className="w-full text-left px-3 py-1.5 hover:bg-gray-50 flex items-center gap-1.5">
                        <RotateCcw className="w-3 h-3" />重开会话
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>

            <div ref={messagesContainerRef} className="flex-1 min-h-0 overflow-y-auto bg-gray-50 px-4 py-3 space-y-3">
              {detail.messages.map((msg) => {
                const att = msg.attachmentsMeta as any;
                const hasAtt = att && (att.url || att.originalName);
                const isInbound = msg.direction === 'inbound';
                const isImage = hasAtt && (att.mimeType?.startsWith('image/') || msg.contentType === 'image' || msg.contentType === 'sticker');
                const isVideo = hasAtt && (att.mimeType?.startsWith('video/') || msg.contentType === 'video');
                const isAudio = hasAtt && (att.mimeType?.startsWith('audio/') || msg.contentType === 'audio');
                const isDocument = hasAtt && (att.mimeType?.startsWith('application/') || msg.contentType === 'document' || (!isImage && !isVideo && !isAudio && hasAtt));
                // 入站消息头像首字母 — 优先使用客户名，避免显示 LID 前缀
                const customerInitial = (() => {
                  const name = (detail as any)?.lead?.companyName || (detail as any)?.lead?.contactName;
                  if (name) return name.charAt(0).toUpperCase();
                  const realPhone = (detail as any)?.lead?.whatsapp || (detail as any)?.contactPoint?.normalizedValue;
                  if (realPhone && !realPhone.includes('@')) return realPhone.charAt(0);
                  return '客';
                })();
                return (
                <div key={msg.id} className={`flex gap-2 ${msg.direction==='outbound'?'justify-end':'justify-start'}`}>
                  {/* 入站消息 — 客户头像 */}
                  {isInbound && (
                    <div className="w-8 h-8 rounded-full overflow-hidden shrink-0 mt-1 bg-blue-100 flex items-center justify-center">
                      {customerAvatar ? (
                        <img src={customerAvatar} alt="客户头像" className="w-full h-full object-cover"
                             onError={(e) => { const t = e.target as HTMLImageElement; t.style.display = 'none'; t.parentElement!.innerHTML = `<span class="text-xs font-bold text-blue-700">${customerInitial}</span>`; }} />
                      ) : (
                        <span className="text-xs font-bold text-blue-700">
                          {customerInitial}
                        </span>
                      )}
                    </div>
                  )}
                  <div className={`max-w-[75%] rounded-lg px-3.5 py-2.5 text-sm ${msg.direction==='inbound'?'bg-white border text-gray-800':'bg-blue-600 text-white'}`}>
                    {/* 图片 — 内联显示 */}
                    {isImage && att.url && (
                      <div className="mb-2 rounded-lg overflow-hidden">
                        <a href={fileUrl(att.url)} target="_blank" rel="noopener noreferrer" className="block">
                          <img src={fileUrl(att.url)} alt={att.originalName||'图片'} className="max-w-full max-h-64 object-contain rounded-lg" />
                        </a>
                      </div>
                    )}
                    {/* 视频 — 内联播放器 */}
                    {isVideo && att.url && (
                      <div className="mb-2 rounded-lg overflow-hidden">
                        <video src={fileUrl(att.url)} controls className="max-w-full max-h-64 rounded-lg" preload="metadata" />
                      </div>
                    )}
                    {/* 语音/音频 — 内联播放器 */}
                    {isAudio && att.url && (
                      <div className="mb-2 flex items-center gap-2">
                        <div className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${msg.direction==='outbound'?'bg-blue-400/30':'bg-blue-100'}`}>
                          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/>
                          </svg>
                        </div>
                        <audio src={fileUrl(att.url)} controls className="flex-1 h-8" preload="metadata" />
                      </div>
                    )}
                    {/* 文档 — 下载链接 */}
                    {isDocument && att.url && (
                      <div className={`mb-2 rounded-lg border ${msg.direction==='outbound'?'border-blue-400/30':'border-gray-200'}`}>
                        <a href={fileUrl(att.url)} target="_blank" rel="noopener noreferrer" download={att.originalName || att.filename}
                           className={`flex items-center gap-2 p-2.5 ${msg.direction==='outbound'?'hover:bg-blue-500/20':'hover:bg-gray-50'}`}>
                          <div className={`w-8 h-8 rounded flex items-center justify-center shrink-0 ${msg.direction==='outbound'?'bg-blue-400/30 text-blue-100':'bg-blue-100 text-blue-600'}`}>
                            <FileText className="w-3.5 h-3.5" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className={`text-xs font-medium truncate ${msg.direction==='outbound'?'text-white':'text-gray-700'}`}>{att.originalName||att.filename||'附件'}</p>
                            {att.size && <p className={`text-[10px] ${msg.direction==='outbound'?'text-blue-200':'text-gray-400'}`}>{att.size<1024?`${att.size}B`:att.size<1048576?`${(att.size/1024).toFixed(1)}KB`:`${(att.size/1048576).toFixed(1)}MB`}</p>}
                          </div>
                        </a>
                      </div>
                    )}
                    {/* 文本内容 — 有附件时仅在有 caption 时显示 */}
                    {msg.content && (!hasAtt || (msg.content && msg.content !== '[图片]' && msg.content !== '[视频]' && msg.content !== '[语音消息]' && msg.content !== '[音频]' && !msg.content.startsWith('[文档]'))) && (
                      <p className="whitespace-pre-wrap break-words">
                        {msg.contentType === 'location' && '📍 '}
                        {msg.contentType === 'contact' && '👤 '}
                        {msg.content}
                      </p>
                    )}
                    <span className={`text-[10px] mt-1 flex items-center gap-1 ${msg.direction==='inbound'?'text-gray-400':'text-blue-200'}`}>
                      {(msg as any).readAt && msg.direction === 'outbound' && <CheckCheck className="w-3 h-3" />}
                      {!(msg as any).readAt && msg.direction === 'outbound' && <Check className="w-3 h-3" />}
                      {msg.receivedAt?new Date(msg.receivedAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}):msg.sentAt?new Date(msg.sentAt).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'}):''}
                    </span>
                  </div>
                  {/* 出站消息 — 接待账号头像 */}
                  {!isInbound && (
                    <div className="w-8 h-8 rounded-full bg-blue-600 text-white flex items-center justify-center text-xs font-bold shrink-0 mt-1">
                      嘉
                    </div>
                  )}
                </div>
                );
              })}
              <div ref={messagesEndRef} />
            </div>

            <AiAssistantPanel conversationId={detail.id} lastMessage={detail.messages?.filter((m:any)=>m.direction==='inbound').slice(-1)[0]||null} leadLanguage={detail.lead?.language} onUseDraft={(t)=>setDraft(t)} />
            <div className="border-t bg-white px-4 py-2 relative">
              {slashOpen && (
                <div className="absolute bottom-full left-4 mb-1 w-72 bg-white border rounded-lg shadow-lg z-20 max-h-60 overflow-y-auto">
                  <div className="px-3 py-1.5 border-b text-[10px] font-semibold text-gray-500">快捷回复 · 按 Esc 关闭</div>
                  {SLASH_OPTIONS.map((o, i) => (
                    <button key={i} onClick={() => selectSlash(o.text)} className="w-full text-left px-3 py-2 text-xs hover:bg-blue-50 border-b last:border-0">
                      <span className="font-medium text-blue-600">/{o.label}</span>
                      <p className="text-gray-400 mt-0.5 truncate">{o.text.slice(0, 50)}</p>
                    </button>
                  ))}
                </div>
              )}
              {/* 待发送附件预览 — 独立行，不挤压输入区 */}
              {pendingAttachment && (
                <div className="mb-2 flex items-center gap-2 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
                  <div className="w-7 h-7 rounded bg-blue-100 text-blue-600 flex items-center justify-center shrink-0">
                    <FileText className="w-3.5 h-3.5" />
                  </div>
                  <div className="flex-1 min-w-0 overflow-hidden">
                    <p className="text-xs font-medium text-gray-700 truncate">{pendingAttachment.originalName}</p>
                    <p className="text-[10px] text-gray-400">{pendingAttachment.size<1024?`${pendingAttachment.size}B`:pendingAttachment.size<1048576?`${(pendingAttachment.size/1024).toFixed(1)}KB`:`${(pendingAttachment.size/1048576).toFixed(1)}MB`} · {pendingAttachment.mediaType}</p>
                  </div>
                  <button onClick={() => setPendingAttachment(null)} className="text-gray-400 hover:text-red-500 p-1 shrink-0">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                onChange={handleFileSelect}
                accept="image/*,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.zip,.rar"
              />
              <div className="flex items-end gap-2">
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  className="p-2 text-gray-400 hover:text-blue-600 rounded disabled:opacity-40 shrink-0"
                  title="发送文件/图片"
                >
                  {uploading ? <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" /> : <Paperclip className="w-4 h-4" />}
                </button>
                <div className="flex-1 min-w-0">
                  <input value={draft} onChange={(e)=>setDraft(e.target.value)} onKeyDown={handleDraftKeyDown}
                    placeholder={pendingAttachment ? "添加说明文字（可选）..." : "输入回复... (Enter 发送, / 快捷回复, 中文自动翻译英文)"}
                    className="w-full border rounded px-3 py-2 text-sm outline-none focus:border-blue-300" />
                </div>
                <button onClick={()=>{handleSend(draft, pendingAttachment||undefined); setDraftState(''); setPendingAttachment(null);}} disabled={(!draft.trim()&&!pendingAttachment)||sending}
                  className="px-5 py-2 bg-blue-600 text-white rounded-md text-sm font-medium hover:bg-blue-700 disabled:opacity-40 shrink-0">
                  {sending?'...':'发送'}
                </button>
              </div>
              <p className="text-[9px] text-gray-400 mt-1">中文自动翻译英文 · Enter 发送 · / 快捷回复 · 📎 发送文件</p>
            </div>
          </>
        ) : conversations.length===0 ? (
          <div className="flex-1 flex items-center justify-center"><p className="text-sm text-gray-400">暂无会话</p></div>
        ) : (
          <div className="flex-1 flex items-center justify-center"><p className="text-sm text-gray-400">选择会话开始沟通</p></div>
        )}

        {/* AI Quote/PI/Sample Popup */}
        {quoteFormType && detail && (
          <QuotePIForm
            conversationId={detail.id}
            leadId={detail.lead?.id || selectedId || ''}
            type={quoteFormType}
            onClose={() => setQuoteFormType(null)}
          />
        )}
      </div>

      <div className="hidden lg:block w-[360px] shrink-0 border-l bg-white overflow-y-auto overflow-x-hidden">
        {detail ? <CustomerCard conversation={detail} onOpenQuoteForm={setQuoteFormType} /> : null}
      </div>
    </div>
  );
}
