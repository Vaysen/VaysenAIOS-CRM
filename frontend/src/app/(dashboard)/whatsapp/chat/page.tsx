'use client';

import { useCallback, useEffect, useState } from 'react';
import api from '@/lib/api';
import { CustomerCard } from '@/components/communication/customer-card';
import { QuotePIForm } from '@/components/communication/quote-pi-popup';
import type { ConversationDetail } from '@/components/communication/types';
import { useElectron } from '@/hooks/use-electron';
import { useAssistantContextStore } from '@/store/assistant-context-store';
import {
  findUniqueExactMatch,
  findLeadByTrustedWhatsAppIdentity,
  normalizeWhatsAppName,
  normalizeWhatsAppPhone,
  sanitizeWhatsAppDisplayName,
} from '@/lib/whatsapp-identity';
import { getQuotePanelWidth, QUOTE_PANEL_MAX_WIDTH } from '@/lib/whatsapp-layout';
import {
  Loader2,
  MonitorOff,
  User,
  Phone,
  UserPlus,
  RefreshCw,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------

interface BackendConversation {
  id: string;
  channel: string;
  subject: string | null;
  status: string;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  unreadCount: number;
  lead: {
    id: string;
    companyName: string;
    contactName: string | null;
    contactPhone?: string | null;
    country?: string | null;
  } | null;
  contactPoint?: {
    id: string;
    type: string;
    originalValue: string;
    normalizedValue: string;
  } | null;
}

// ---------------------------------------------------------------------------
// 布局常量
// ---------------------------------------------------------------------------

const RIGHT_PANEL_WIDTH = 412;
// AI 悬浮球已注入 WhatsApp DOM 内部，无需预留底部空间
const BOTTOM_OFFSET = 0;

// ---------------------------------------------------------------------------
// 主页面
// ---------------------------------------------------------------------------

export default function WhatsAppChatPage() {
  const { api: electronAPI, isElectron } = useElectron();
  const [wa, setWa] = useState<any>(null);
  const [conversationDetail, setConversationDetail] = useState<ConversationDetail | null>(null);
  const [selectedConvId, setSelectedConvId] = useState<string | null>(null);
  const [lastMessage, setLastMessage] = useState<string | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [currentChatInfo, setCurrentChatInfo] = useState<{
    accountId: string;
    name: string;
    phone: string;
    isGroup?: boolean;
    selectionProof: string;
  } | null>(null);
  const [matchError, setMatchError] = useState<string | null>(null);
  const [quoteFormType, setQuoteFormType] = useState<'quote' | 'pi' | 'sample' | null>(null);
  const [quotePanelWidth, setQuotePanelWidth] = useState(QUOTE_PANEL_MAX_WIDTH);
  const [pendingLeadId, setPendingLeadId] = useState<string | null>(null);
  const setWhatsAppContext = useAssistantContextStore((state) => state.setWhatsAppContext);

  useEffect(() => {
    if (!currentChatInfo) {
      setWhatsAppContext(null);
      return;
    }
    setWhatsAppContext({
      name: currentChatInfo.name,
      phone: currentChatInfo.phone,
      accountId: currentChatInfo.accountId,
      selectionProof: currentChatInfo.selectionProof,
      conversationId: conversationDetail?.id,
      leadId: conversationDetail?.lead?.id,
      isGroup: currentChatInfo.isGroup === true,
      lastMessage: lastMessage || undefined,
    });
    return () => setWhatsAppContext(null);
  }, [conversationDetail, currentChatInfo, lastMessage, setWhatsAppContext]);

  useEffect(() => {
    if (electronAPI) { setWa(electronAPI); return; }
    let attempts = 0;
    const interval = setInterval(() => {
      attempts++;
      const a = (window as any).electronAPI;
      if (a) { setWa(a); clearInterval(interval); }
      else if (attempts >= 20) { clearInterval(interval); }
    }, 500);
    return () => clearInterval(interval);
  }, [electronAPI]);

  // 从 URL 参数加载指定 leadId 的会话（从客户资产跳转过来）
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const urlParams = new URLSearchParams(window.location.search);
    const leadId = urlParams.get('leadId');
    const phone = urlParams.get('phone');
    if (!leadId) return;

    console.log(`[WhatsApp Chat] 🔗 从URL参数加载: leadId=${leadId}, phone=${phone}`);
    setPendingLeadId(leadId);
    (async () => {
      try {
        const res = await api.get('/communications/conversations', {
          params: { leadId, limit: 1 },
        });
        const conversations = res.data?.data || res.data || [];
        if (Array.isArray(conversations) && conversations.length > 0) {
          const conv = conversations[0];
          setSelectedConvId(conv.id);
          const detailRes = await api.get(`/communications/conversations/${conv.id}`);
          const detail = detailRes.data?.data || detailRes.data;
          if (detail) {
            setConversationDetail(detail);
            console.log(`[WhatsApp Chat] ✅ 从URL参数加载会话成功: ${conv.id}`);
          }
        } else {
          console.log(`[WhatsApp Chat] 🆕 无会话，为 leadId=${leadId} 创建`);
          const convRes = await api.post('/communications/conversations', {
            channel: 'whatsapp',
            leadId: leadId,
            contactPhone: phone || '',
            subject: 'WhatsApp Conversation',
            status: 'active',
          });
          const newConv = convRes.data?.data || convRes.data;
          if (newConv?.id) {
            setSelectedConvId(newConv.id);
            const detailRes = await api.get(`/communications/conversations/${newConv.id}`);
            const detail = detailRes.data?.data || detailRes.data;
            if (detail) {
              setConversationDetail(detail);
            }
          }
        }
      } catch (e: any) {
        console.error('[WhatsApp Chat] ❌ URL参数加载失败:', e.message);
        setMatchError(`加载客户会话失败: ${e.message}`);
      }
    })();
  }, []);

  // 挂载：显示 WhatsApp 视图
  useEffect(() => {
    if (!wa) return;
    let cancelled = false;

    const showWhatsAppView = async () => {
      try {
        let list = await wa.whatsapp.listAccounts();
        let accounts = Array.isArray(list) ? list : [];
        if (accounts.length === 0) {
          await wa.whatsapp.createAccount('default', '主账号');
          list = await wa.whatsapp.listAccounts();
          accounts = Array.isArray(list) ? list : [];
        }
        const active = accounts.find((a: any) => a.isActive) || accounts[0] || null;
        if (active && !cancelled) await wa.whatsapp.switchAccount(active.id);

        if (!cancelled) {
          wa.whatsapp.showView({
            leftNavWidth: 240,
            chatListWidth: 0,
            rightPanelWidth: RIGHT_PANEL_WIDTH,
            topOffset: 64,
            bottomOffset: BOTTOM_OFFSET,
          });
        }
      } catch (err) {
        console.error('[WhatsApp Chat] 显示视图失败:', err);
      }
    };

    requestAnimationFrame(() => setTimeout(showWhatsAppView, 100));

    const handleResize = () => {
      if (!wa || cancelled) return;
      wa.whatsapp.setLayout({
        leftNavWidth: 240, chatListWidth: 0,
        rightPanelWidth: RIGHT_PANEL_WIDTH, topOffset: 64, bottomOffset: BOTTOM_OFFSET,
      });
    };
    window.addEventListener('resize', handleResize);

    return () => {
      cancelled = true;
      window.removeEventListener('resize', handleResize);
      if (wa) wa.whatsapp.hideView();
    };
  }, [wa]);

  useEffect(() => {
    if (!wa?.whatsapp?.setOverlayWidth) return;

    const syncQuotePanelWidth = () => {
      const nextWidth = getQuotePanelWidth(window.innerWidth);
      setQuotePanelWidth(nextWidth);
      wa.whatsapp.setOverlayWidth(quoteFormType ? nextWidth : 0);
    };

    syncQuotePanelWidth();
    window.addEventListener('resize', syncQuotePanelWidth);
    return () => {
      window.removeEventListener('resize', syncQuotePanelWidth);
      wa.whatsapp.setOverlayWidth(0);
    };
  }, [wa, quoteFormType]);

  // 监听当前聊天变化 — 智能匹配或自动建档
  useEffect(() => {
    if (!wa) return;

    let receivedCurrentChat = false;
    let lastHandledChatKey = '';

    const handleCurrentChat = (chat: any) => {
      const phone = normalizeWhatsAppPhone(chat?.phone);
      const name = sanitizeWhatsAppDisplayName(chat?.name) || '';
      const accountId = typeof chat?.accountId === 'string' ? chat.accountId.trim() : '';
      const selectionProof = typeof chat?.selectionProof === 'string' ? chat.selectionProof.trim() : '';
      const chatKey = `${accountId}|${phone}|${normalizeWhatsAppName(name)}|${chat?.isGroup === true}`;

      if ((!phone && !name) || !accountId || !selectionProof) {
        setCurrentChatInfo(null);
        setConversationDetail(null);
        setSelectedConvId(null);
        setMatchError('已连接 WhatsApp，但未取得可信客户号码或姓名，请重新选择聊天');
        return;
      }

      receivedCurrentChat = true;
      if (chatKey === lastHandledChatKey) return;
      lastHandledChatKey = chatKey;
      setCurrentChatInfo({ accountId, name, phone, isGroup: chat?.isGroup, selectionProof });
      setMatchError(null);
      setConversationDetail(null);
      setSelectedConvId(null);
      void matchOrCreateConversation(phone, name);
    };

    const unsubChat = wa.whatsapp.onCurrentChat((chat: any) => {
      console.log('[WhatsApp Chat] 🔔 onCurrentChat 收到:', JSON.stringify(chat));
      handleCurrentChat(chat);
    });

    const unsubMsg = wa.whatsapp.onNewMessage((msg: any) => {
      if (!msg.isOutgoing) setLastMessage(msg.text || `[${msg.type}]`);
    });

    // 订阅建立后主动索取一次当前聊天。WhatsApp 视图通常早于 React 页面加载，
    // 单靠“聊天切换”广播会丢掉 preload 已经发出的首次事件。
    const currentChatTimeout = window.setTimeout(() => {
      if (!receivedCurrentChat) {
        setMatchError('WhatsApp 已打开，但当前联系人识别结果未返回，请重新选择聊天');
      }
    }, 3000);

    void wa.whatsapp.requestCurrentChat().then((result: { requested: boolean; chat?: any }) => {
      if (!result?.requested) {
        setMatchError('WhatsApp 视图尚未就绪，请稍后点击刷新');
      } else if (result.chat) {
        handleCurrentChat(result.chat);
      }
    }).catch((error: unknown) => {
      console.error('[WhatsApp Chat] 请求当前聊天失败:', error);
      setMatchError('无法读取当前 WhatsApp 联系人，请重新进入聊天页');
    });

    return () => { window.clearTimeout(currentChatTimeout); unsubChat(); unsubMsg(); };
  }, [wa]);

  // 智能匹配或自动创建会话
  const matchOrCreateConversation = useCallback(async (phone: string, name: string) => {
    const phoneDigits = normalizeWhatsAppPhone(phone);
    const e164Phone = phoneDigits ? `+${phoneDigits}` : '';
    const trustedName = sanitizeWhatsAppDisplayName(name) || '';
    const normalizedName = normalizeWhatsAppName(trustedName);
    if (!phoneDigits && !trustedName) {
      console.log('[WhatsApp Chat] ⚠️ 无有效号码和名称，跳过匹配');
      setMatchError('未取得可信客户号码或姓名，已停止自动识别');
      return;
    }

    setLoadingDetail(true);
    setMatchError(null);
    console.log(`[WhatsApp Chat] 🔍 开始精确匹配: phone="${phoneDigits}", name="${trustedName}"`);

    try {
      // 1. 查后端所有 whatsapp 会话
      const res = await api.get('/communications/conversations', {
        params: { channel: 'whatsapp', limit: 500 },
      });
      const conversations: BackendConversation[] = res.data?.data || res.data || [];
      console.log(`[WhatsApp Chat] 查到 ${conversations.length} 个 WhatsApp 会话`);

      // 2. 仅允许完整号码或唯一精确姓名命中。禁止尾号/包含关系自动合并客户。
      let matched: BackendConversation | undefined;

      if (phoneDigits) {
        matched = findUniqueExactMatch(conversations, phoneDigits, (c) => {
          const cp = c.contactPoint?.normalizedValue || c.contactPoint?.originalValue || c.lead?.contactPhone || '';
          return normalizeWhatsAppPhone(cp);
        });
      }

      if (!matched && normalizedName) {
        const nameCandidates = conversations.filter((c) => {
          const existingPhone = normalizeWhatsAppPhone(
            c.contactPoint?.normalizedValue || c.contactPoint?.originalValue || c.lead?.contactPhone,
          );
          return !phoneDigits || !existingPhone;
        });
        matched = findUniqueExactMatch(nameCandidates, normalizedName, (c) => {
          return normalizeWhatsAppName(c.lead?.contactName || c.lead?.companyName || c.subject || '');
        });
      }

      // 历史版本可能已按姓名创建了无号码、无 ContactPoint 的 WhatsApp 空壳。
      // 当本次从 WhatsApp 主世界取得完整 E.164 后，必须修复原档案，而不是
      // 因“姓名已匹配”提前返回。communications create 是幂等的：已有同渠道
      // 会话时会补建/绑定 verified WhatsApp ContactPoint，不会重复建客户。
      if (matched && phoneDigits) {
        const matchedPhone = normalizeWhatsAppPhone(
          matched.contactPoint?.normalizedValue ||
          matched.contactPoint?.originalValue ||
          matched.lead?.contactPhone,
        );
        const matchedLeadId = matched.lead?.id;
        if (!matchedPhone && matchedLeadId) {
          console.log(`[WhatsApp Chat] 🔧 修复历史空壳身份: leadId=${matchedLeadId}, phone=${phoneDigits}`);
          await api.patch(`/leads/${matchedLeadId}`, {
            contactPhone: e164Phone,
            whatsapp: e164Phone,
          });
          const repaired = await api.post('/communications/conversations', {
            channel: 'whatsapp',
            leadId: matchedLeadId,
            contactPhone: e164Phone,
            subject: trustedName || matched.subject || `WhatsApp +${phoneDigits}`,
            status: 'active',
          });
          matched = repaired.data?.data || repaired.data || matched;
          console.log(`[WhatsApp Chat] ✅ 历史空壳已补齐可信 ContactPoint: ${matched?.id}`);
        }
      }

      // 3. 没找到 → 自动建档
      if (!matched) {
        if (!phoneDigits) {
          setMatchError('仅有姓名但未取得可信电话号码，已停止自动建档；请手动关联客户');
          return;
        }

        console.log(`[WhatsApp Chat] 🆕 未找到精确匹配，按可信号码建档: name="${trustedName}", phone="${phoneDigits}"`);
        try {
          let leadId: string | null = null;

          // 先检查是否已存在相同号码的 lead（搜索所有 leads，不限 whatsapp 会话）
          if (phoneDigits) {
            const leadsRes = await api.get('/leads', {
              params: { search: phoneDigits, limit: 50 },
            });
            const existingLeads = leadsRes.data?.data || leadsRes.data || [];
            const existingLead = Array.isArray(existingLeads)
              ? findLeadByTrustedWhatsAppIdentity(existingLeads, phoneDigits)
              : undefined;
            if (existingLead) {
              console.log(`[WhatsApp Chat] 找到已有 lead(按号码): ${existingLead.id}`);
              leadId = existingLead.id;
              // 如果 lead 没有 phone，回填
              if (!existingLead.contactPhone) {
                await api.patch(`/leads/${leadId}`, { contactPhone: e164Phone, whatsapp: e164Phone });
                console.log(`[WhatsApp Chat] 回填 phone 到已有 lead`);
              }
            }
          }

          // 姓名只允许唯一精确命中，重名时不自动关联。
          if (!leadId && normalizedName) {
            const leadsRes = await api.get('/leads', {
              params: { search: trustedName, limit: 50 },
            });
            const existingLeads = leadsRes.data?.data || leadsRes.data || [];
            const nameCandidates = Array.isArray(existingLeads)
              ? existingLeads.filter((l: any) => !normalizeWhatsAppPhone(l.contactPhone || l.whatsapp))
              : [];
            const existingLead = findUniqueExactMatch(
              nameCandidates,
              normalizedName,
              (l: any) => normalizeWhatsAppName(l.contactName || l.companyName || ''),
            );
            if (existingLead) {
              console.log(`[WhatsApp Chat] 按唯一精确姓名找到已有 lead: ${existingLead.id}`);
              leadId = existingLead.id;
              // 回填 phone
              if (!existingLead.contactPhone) {
                await api.patch(`/leads/${leadId}`, { contactPhone: e164Phone, whatsapp: e164Phone });
              }
            }
          }

          // 创建新 lead：到达这里一定已有可信完整号码。
          if (!leadId) {
            const leadRes = await api.post('/leads', {
              companyName: trustedName || `WhatsApp +${phoneDigits}`,
              contactName: trustedName,
              contactPhone: e164Phone,
              whatsapp: e164Phone,
              sourceType: 'whatsapp',
              status: 'new',
            });
            const lead = leadRes.data?.data || leadRes.data;
            leadId = lead.id;
            console.log(`[WhatsApp Chat] ✅ 新 lead 已创建: ${leadId}`);
          }

          // 创建会话
          const convRes = await api.post('/communications/conversations', {
            channel: 'whatsapp',
            leadId: leadId,
            contactPhone: e164Phone,
            subject: trustedName || `WhatsApp +${phoneDigits}`,
            status: 'active',
          });
          matched = convRes.data?.data || convRes.data;
          console.log(`[WhatsApp Chat] ✅ 新会话已创建: ${matched?.id}`);
        } catch (e: any) {
          console.error('[WhatsApp Chat] ❌ 自动建档失败:', e.response?.data || e.message);
          setMatchError(`自动建档失败: ${e.response?.data?.message || e.message}`);
        }
      }

      // 4. 加载详情
      if (matched && matched.id) {
        console.log(`[WhatsApp Chat] 📋 加载会话详情: ${matched.id}`);
        setSelectedConvId(matched.id);
        const detailRes = await api.get(`/communications/conversations/${matched.id}`);
        const detail = detailRes.data?.data || detailRes.data;
        if (detail) {
          setConversationDetail(detail);
          console.log(`[WhatsApp Chat] ✅ 客户资料已加载: ${detail.lead?.companyName || '未知'}`);
        }
      } else if (!phoneDigits && !trustedName) {
        // 无号码无名称（不应到达这里）
        setMatchError('此聊天无有效信息，无法自动建档');
      }
    } catch (err: any) {
      console.error('[WhatsApp Chat] ❌ 匹配失败:', err.response?.data || err.message);
      setMatchError(`匹配失败: ${err.response?.data?.message || err.message}`);
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  // 手动刷新客户资料
  const handleRefresh = () => {
    if (currentChatInfo) {
      setConversationDetail(null);
      setSelectedConvId(null);
      matchOrCreateConversation(currentChatInfo.phone, currentChatInfo.name);
    }
  };

  if (!wa && !isElectron) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-8rem)]">
        <div className="text-center">
          <MonitorOff className="w-12 h-12 mx-auto text-gray-300 mb-3" />
          <p className="text-sm text-gray-500">WhatsApp 聊天功能仅在桌面应用中可用</p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex w-full min-w-0 overflow-hidden"
      style={{ height: 'calc(100vh - 64px)' }}
      data-quote-panel-width={quoteFormType ? quotePanelWidth : 0}
    >
      {/* 中栏 — WhatsApp 视图区域（由 Electron 原生填充） */}
      <div className="min-w-0 flex-1 flex flex-col relative">
        <div className="flex-1 relative bg-[#efeae2]" />
      </div>

      {/* 右栏：客户工作区 */}
      <div className="w-[412px] shrink-0 border-l bg-white flex flex-col overflow-hidden">
        {/* 当前聊天信息栏 */}
        <div className="px-3 py-2.5 border-b bg-gradient-to-r from-green-50 to-emerald-50 shrink-0">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-8 h-8 rounded-full bg-green-500 flex items-center justify-center shrink-0">
                <Phone className="w-4 h-4 text-white" />
              </div>
              <div className="min-w-0">
                <p className="text-[10px] text-green-600 font-medium">当前 WhatsApp 聊天</p>
                <p className="text-sm font-semibold text-gray-800 truncate">
                  {currentChatInfo?.name || '等待选择联系人...'}
                </p>
                {currentChatInfo?.phone && (
                  <p className="text-[11px] text-gray-500 font-mono">{currentChatInfo.phone}</p>
                )}
                {currentChatInfo?.isGroup && (
                  <span className="text-[9px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-700">群聊</span>
                )}
              </div>
            </div>
            <button
              onClick={handleRefresh}
              disabled={loadingDetail || !currentChatInfo}
              className="p-1.5 rounded-lg hover:bg-white/60 text-gray-400 hover:text-gray-600 disabled:opacity-30 shrink-0"
              title="刷新客户资料"
            >
              <RefreshCw className={`w-4 h-4 ${loadingDetail ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {/* 加载状态 */}
        {loadingDetail && (
          <div className="flex items-center justify-center py-4 border-b bg-blue-50/50">
            <Loader2 className="w-4 h-4 text-blue-500 animate-spin" />
            <span className="text-xs text-blue-600 ml-2">正在识别客户 / 自动建档中...</span>
          </div>
        )}

        {/* 错误提示 */}
        {matchError && !loadingDetail && (
          <div className="px-3 py-2 bg-red-50 border-b text-xs text-red-600">
            {matchError}
          </div>
        )}

        {/* 客户资料卡片 */}
        <div className="flex-1 overflow-y-auto">
          {conversationDetail ? (
            <CustomerCard conversation={conversationDetail} onOpenQuoteForm={setQuoteFormType} />
          ) : currentChatInfo ? (
            <div className="text-center py-8 px-4">
              {!loadingDetail && !matchError && (
                <>
                  <UserPlus className="w-10 h-10 mx-auto text-gray-300 mb-2" />
                  <p className="text-sm text-gray-500">正在匹配客户档案...</p>
                </>
              )}
            </div>
          ) : (
            <div className="text-center py-12 px-4">
              <User className="w-10 h-10 mx-auto text-gray-300 mb-3" />
              <p className="text-sm text-gray-400">在 WhatsApp 中选择联系人</p>
              <p className="text-xs text-gray-300 mt-1.5 leading-relaxed">
                系统将自动识别客户信息
                <br />
                新客户将自动建立档案
              </p>
            </div>
          )}
        </div>

        {/* 新消息提示 */}
        {lastMessage && (
          <div className="px-3 py-2 border-t bg-yellow-50 shrink-0">
            <p className="text-[10px] text-yellow-700 font-medium">📩 新消息</p>
            <p className="text-xs text-gray-700 truncate">{lastMessage}</p>
          </div>
        )}
      </div>

      {/* AI 辅助订单 — 报价/PI/样品单 弹窗 */}
      {quoteFormType && conversationDetail && (
        <QuotePIForm
          conversationId={conversationDetail.id}
          leadId={conversationDetail.lead?.id || selectedConvId || ''}
          type={quoteFormType}
          placement="right"
          onClose={() => setQuoteFormType(null)}
        />
      )}
    </div>
  );
}
