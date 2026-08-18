/**
 * WhatsApp Web Preload 脚本 v3.0
 *
 * 核心功能：
 * - 消息翻译（AI 业务助理入口由主渲染器统一提供）
 * - 可靠的当前会话检测（多种策略）
 * - MutationObserver 消息监听
 * - 联系人信息提取（含电话号码从 JID/data-id 解析）
 * - 文本草稿注入（最终发送必须人工确认）
 * - CSS 注入隐藏不需要的 UI
 */

import { ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../shared/ipc-channels';
import { WhatsAppContactSnapshot } from '../shared/whatsapp-contact-types';
// 纯逻辑统一从 wa-logic.ts 引入（单一来源，便于行为测试，避免与源码重复）。
import {
  buildContactSnapshotFromElement,
  extractMessage,
  SelectorFailureTracker,
  sanitizeWhatsAppDisplayName,
  firstTrustedWhatsAppDisplayName,
  normalizePhoneLikeWhatsAppTitle,
  findTrustedWhatsAppJidInObject,
  isUnavailableAiTranslation,
  createInFlightSendGate,
  pickSendButton,
  runInjectAndSend,
  MAX_DEDUP_SIZE,
} from './wa-logic';

// ════════════════════════════════════════════════════════════
// 常量
// ════════════════════════════════════════════════════════════

const CONTACT_SYNC_INTERVAL = 60000;
const LOGIN_CHECK_INTERVAL = 5000;
const RECONNECT_CHECK_INTERVAL = 30000;
const CHAT_CHECK_INTERVAL = 1500;
const UNREAD_COUNT_INTERVAL = 10000;
const SELECTOR_FAIL_THRESHOLD = 3;

const processedMessageIds = new Set<string>();
// 选择器失败计数（连续失败达阈值触发告警）。逻辑来自 wa-logic.ts 的 SelectorFailureTracker。
const selectorFailTracker = new SelectorFailureTracker(SELECTOR_FAIL_THRESHOLD);
const authorizedSendGate = createInFlightSendGate();

// ════════════════════════════════════════════════════════════
// 多选择器工具
// ════════════════════════════════════════════════════════════

function $(selectors: string[], groupKey: string): Element | null {
  for (const sel of selectors) {
    try {
      const el = document.querySelector(sel);
      if (el) { selectorFailTracker.reset(groupKey); return el; }
    } catch {}
  }
  if (selectorFailTracker.record(groupKey)) {
    console.warn(`[WA] 选择器组 "${groupKey}" 连续失败`);
  }
  return null;
}

function $$(selectors: string[], groupKey: string): Element[] {
  for (const sel of selectors) {
    try {
      const els = document.querySelectorAll(sel);
      if (els.length > 0) { selectorFailTracker.reset(groupKey); return Array.from(els); }
    } catch {}
  }
  selectorFailTracker.record(groupKey);
  return [];
}

function querySelectorFallback(
  selectors: string[],
  groupKey: string,
): Element | null {
  return $(selectors, groupKey);
}

function querySelectorAllFallback(
  selectors: string[],
  groupKey: string,
): Element[] {
  return $$(selectors, groupKey);
}

// ════════════════════════════════════════════════════════════
// 选择器配置
// ════════════════════════════════════════════════════════════

const SELECTORS = {
  // 当前打开聊天的头部
  chatHeader: [
    '#main header',
    '[data-testid="conversation-header"]',
    '[data-testid="conversation-info-header"]',
    'div[data-testid="conversation-panel-header"]',
  ],
  // 当前打开聊天的头部名称
  chatHeaderName: [
    '#main [data-testid="conversation-info-header-chat-title"]',
    '#main header span[dir="auto"][title]',
    '#main [data-testid="conversation-info-header"] span[title]',
    '#main header [data-testid="header-title"] span',
  ],
  // 聊天列表项
  chatListItem: [
    '#pane-side [role="listitem"]',
    '[data-testid="chat-list"] [role="listitem"]',
    'div[role="listitem"]',
  ],
  // 活跃/选中的聊天项
  activeChatItem: [
    '#pane-side [aria-selected="true"]',
    '#pane-side [role="listitem"][aria-selected="true"]',
    '#pane-side [role="listitem"][class*="active"]',
    'div[aria-selected="true"][role="listitem"]',
  ],
  // 输入框
  inputBox: [
    'div[contenteditable="true"][data-tab="10"]',
    'footer div[contenteditable="true"]',
    '[data-testid="conversation-compose-box-input"] [contenteditable="true"]',
  ],
  // 发送按钮
  sendButton: [
    'span[data-icon="send"]',
    'button[aria-label="Send"]',
    'footer button[data-testid="compose-btn-send"]',
  ],
  // 消息元素
  messageRow: [
    'div.message-in, div.message-out',
    '[data-testid="msg-container"]',
    '#main div[role="row"]',
    '[data-testid="conversation-panel-messages"] div[data-id]',
  ],
  // 未读消息徽章
  unreadBadge: [
    '#pane-side [role="listitem"] [class*="unread"]',
    '#pane-side span[class*="badge"]',
    '[data-testid="icon-unread-count"]',
  ],
  // QR 码
  qrCode: ['[data-testid="qr-code"]', 'div[data-ref] canvas'],
  // 已登录标志
  loggedIn: ['#pane-side', '[data-testid="chat-list"]'],
  // 断线提示
  offlineNotice: ['span[data-icon="alert-phone"]', '[data-testid="connectivity-poor-notice"]'],
  // 图片消息
  mediaImage: [
    'img[src*="blob"]',
    'img[src*="https://"]',
    '[data-testid="image-msg"] img',
  ],
  // 文件消息
  mediaFile: [
    '[data-testid="document-file"]',
    '[class*="document-file"]',
    '[data-testid*="document"]',
  ],
  // 联系人名称（聊天列表中）
  contactName: [
    '#pane-side [role="listitem"] span[dir="auto"][title]',
    '#pane-side [role="listitem"] span[title]',
    '[data-testid="chat-list"] span[dir="auto"][title]',
  ],
  // 联系人最后消息（聊天列表中）
  contactLastMessage: [
    '#pane-side [role="listitem"] span[class*="message"]',
    '#pane-side [role="listitem"] [dir="auto"]:last-child',
    '[data-testid="chat-list"] [class*="last-message"]',
  ],
};

function getTrustedJidFromElement(element: HTMLElement): string | null {
  const candidates = [element, ...Array.from(element.querySelectorAll('[data-id]'))];
  for (const candidate of candidates) {
    const dataId = candidate.getAttribute('data-id') || '';
    const match = dataId.match(/(\d{7,15}@(?:c\.us|s\.whatsapp\.net)|\d+@lid|\d{10,}@(?:g\.us|broadcast))/);
    if (match) return match[1];
  }

  // React 的内部 key 每次启动会带随机后缀，因此只按稳定前缀筛选。
  const reactRoots: unknown[] = [];
  let selectedIdentity: string | null = null;
  for (const key of Object.keys(element)) {
    if (!key.startsWith('__reactProps$') && !key.startsWith('__reactFiber$')) continue;
    let value: unknown;
    try {
      value = (element as unknown as Record<string, unknown>)[key];
    } catch {
      continue;
    }
    reactRoots.push(value);
    const jid = findTrustedWhatsAppJidInObject(value);
    if (jid?.endsWith('@c.us') || jid?.endsWith('@s.whatsapp.net')) return jid;
    if (jid && !selectedIdentity) selectedIdentity = jid;
  }
  // Preserve a LID as the channel identity. A numeric LID prefix is not a
  // phone number; any phone-JID mapping is reserved for explicit send flows.
  return selectedIdentity;
}

// ════════════════════════════════════════════════════════════
// 联系人快照构建逻辑已抽到 ./wa-logic.ts (buildContactSnapshotFromElement)，
// 便于用 jest + MockElement 做行为测试（TASK-111）。这里仅引用，不重复实现。

// ════════════════════════════════════════════════════════════
// 当前会话信息提取 — 多种策略,最可靠的组合
// ════════════════════════════════════════════════════════════

function getCurrentChatInfo(): { name: string; phone: string; isGroup: boolean; externalId: string } | null {
  let name = '';
  let phone = '';
  let isGroup = false;
  let externalId = '';

  // ── 策略 0 (最高优先): 从活跃聊天列表项的 data-id 提取 JID ──
  // 这是最可靠的电话号码来源，即使联系人有备注名也能正确提取
  for (const sel of SELECTORS.activeChatItem) {
    try {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (el) {
        const dataId = getTrustedJidFromElement(el) || el.getAttribute('data-id') || '';
        const trustedJid = dataId.match(/(\d{7,15}@(?:c\.us|s\.whatsapp\.net|lid)|\d{10,}@(?:g\.us|broadcast))/)?.[1] || '';
        if (trustedJid) externalId = trustedJid;
        // JID 格式: 8613800138000@c.us 或 false_8613800138000@c.us_3EB...
        const jidMatch = dataId.match(/(\d{8,})@(?:c\.us|s\.whatsapp\.net|l\.us)/);
        if (jidMatch) {
          phone = jidMatch[1];
        }
        if (dataId.includes('@g.us') || dataId.includes('@broadcast')) {
          isGroup = true;
        }
        // 同时尝试从列表项提取名称（备注名）
        if (!name) {
          const nameEls = Array.from(el.querySelectorAll('span[dir="auto"][title]'));
          const n = firstTrustedWhatsAppDisplayName(nameEls.map((nameEl) => (
            nameEl.getAttribute('title') || nameEl.textContent
          )));
          if (n) name = n;
        }
        break; // 找到活跃项就停止
      }
    } catch {}
  }

  // ── 策略 1: 从 URL 解析（WhatsApp 新版 URL 可能包含 JID）──
  if (!phone) {
    try {
      const hash = window.location.hash;
      const jidMatch = hash.match(/(\d{8,})@(?:c\.us|s\.whatsapp\.net)/);
      if (jidMatch) {
        phone = jidMatch[1];
      } else {
        const numMatch = hash.match(/(\d{10,})/);
        if (numMatch) phone = numMatch[1];
      }
    } catch {}
  }

  // ── 策略 2: 从聊天头部标题获取名称 ──
  for (const sel of SELECTORS.chatHeaderName) {
    try {
      const candidates = Array.from(document.querySelectorAll(sel));
      const candidateTexts = candidates.map((el) => (
        el.getAttribute('title') || el.textContent
      ));
      const t = firstTrustedWhatsAppDisplayName(candidateTexts);
      if (t && !name) name = t;
      if (!phone) {
        for (const candidate of candidateTexts) {
          const titlePhone = normalizePhoneLikeWhatsAppTitle(candidate);
          if (titlePhone) {
            phone = titlePhone;
            break;
          }
        }
      }
    } catch {}
  }

  // ── 策略 3: 从活跃聊天列表项补充提取名称（电话已在策略0提取）──
  for (const sel of SELECTORS.activeChatItem) {
    try {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (el) {
        // 从子元素获取名称
        if (!name) {
          const nameEls = Array.from(el.querySelectorAll('span[dir="auto"][title]'));
          const n = firstTrustedWhatsAppDisplayName(nameEls.map((nameEl) => (
            nameEl.getAttribute('title') || nameEl.textContent
          )));
          if (n) name = n;
        }

        // 有些聊天列表项的 title 属性就是电话号码/名称
        const itemTitle = sanitizeWhatsAppDisplayName(el.getAttribute('title'));
        if (itemTitle && !name) name = itemTitle;
        if (!phone) {
          const itemPhone = normalizePhoneLikeWhatsAppTitle(itemTitle);
          if (itemPhone) phone = itemPhone;
        }
      }
    } catch {}
  }

  // ── 策略 4: 尝试从 Store （WidFactory）解析 JID ──
  // WhatsApp Web 使用 window.Store 或内部模块，这里尝试从 DOM data 属性提取
  try {
    const mainEl = document.querySelector('#main') as HTMLElement;
    if (mainEl) {
      // 某些版本在 main 元素上有 data-peerjid 或类似属性
      const peerJid = mainEl.getAttribute('data-peerjid') || mainEl.getAttribute('data-jid') || '';
      const jidMatch = peerJid.match(/(\d{8,})@/);
      if (jidMatch && !phone) phone = jidMatch[1];
    }
  } catch {}

  // ── 策略 5/6 已移除 (TASK-102D) ──
  // 旧逻辑会从 #main header 的 span 文本 / 聊天标题里反推号码,
  // 这会把状态文本、UI 文案误判为号码。现在只保留可信 JID 来源,
  // 号码缺失时 phone 留空,由后端按 externalId 走 IdentityResolutionService 处理。

  // 清理号码：去除 + 和空格，保留纯数字
  if (phone) {
    phone = phone.replace(/\D/g, '');
    // 去掉可能的前缀 00
    if (phone.startsWith('00')) phone = phone.slice(2);
  }

  // 群聊：如果检测到是群聊，标注 isGroup
  if (!isGroup) {
    try {
      const groupEl = document.querySelector('#main header [data-testid="group-icon"]') ||
                       document.querySelector('span[data-icon="default-group"]');
      isGroup = !!groupEl;
    } catch {}
  }

  if (externalId && /@(?:g\.us|broadcast)$/i.test(externalId)) isGroup = true;

  if (name || phone || externalId) {
    console.log(`[WA] getCurrentChatInfo 结果: name="${name}", phone="${phone}", isGroup=${isGroup}`);
    return { name, phone, isGroup, externalId };
  }
  // 调试：如果没找到任何信息，输出当前 DOM 状态帮助诊断
  console.log('[WA] getCurrentChatInfo 未找到聊天信息, #main=', !!document.querySelector('#main'), '#pane-side=', !!document.querySelector('#pane-side'), 'header=', !!document.querySelector('#main header'), 'url=', location.href);
  return null;
}

// ════════════════════════════════════════════════════════════
// 消息提取 — 逻辑已抽到 ./wa-logic.ts (extractMessage)，此处仅引用
// ════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════
// 获取最近消息（用于 AI 上下文）
// ════════════════════════════════════════════════════════════

function getRecentMessages(maxCount: number = 10) {
  const messages: Array<{ text: string; isOutgoing: boolean; time: string }> = [];
  const msgEls = $$(SELECTORS.messageRow, 'messageRow');
  if (msgEls.length === 0) return messages;

  const count = Math.min(msgEls.length, maxCount);
  for (let i = msgEls.length - 1; i >= 0 && messages.length < count; i--) {
    const el = msgEls[i] as HTMLElement;
    const isOutgoing = el.classList.contains('message-out') || el.closest('.message-out') !== null;
    let text = '';
    const textEl = el.querySelector('.selectable-text span, span.selectable-text, .copyable-text span');
    if (textEl) text = textEl.textContent?.trim() || '';
    if (!text) text = el.textContent?.trim().slice(0, 500) || '';
    if (text && text.length < 500) {
      messages.unshift({ text, isOutgoing, time: '' });
    }
  }
  return messages;
}

// IPC: 主进程请求最近消息
ipcRenderer.on('wa:get-recent-messages', (_event, maxCount?: number) => {
  ipcRenderer.send('wa:recent-messages', getRecentMessages(maxCount || 10));
});

// ════════════════════════════════════════════════════════════
// 文本注入 + 发送
// ════════════════════════════════════════════════════════════

function injectText(text: string): boolean {
  const inputEl = $(SELECTORS.inputBox, 'inputBox') as HTMLElement | null;
  if (!inputEl) return false;
  inputEl.focus();
  (inputEl as any).innerHTML = '';
  // execCommand('insertText') 会插入文本并自动触发 input 事件
  // 不要再手动 dispatchEvent，否则 WhatsApp 会收到两次输入导致文本重复
  document.execCommand('insertText', false, text);
  return true;
}

function normalizeContactName(value: unknown): string {
  return typeof value === 'string'
    ? value.normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().toLocaleLowerCase()
    : '';
}

ipcRenderer.on(
  IPC_CHANNELS.WA_FILL_DRAFT,
  (_event, request: {
    requestId?: string;
    text?: string;
    targetPhone?: string;
    targetName?: string;
  }) => {
    const requestId = typeof request?.requestId === 'string' ? request.requestId : '';
    const text = typeof request?.text === 'string' ? request.text.trim() : '';
    const targetPhone = typeof request?.targetPhone === 'string'
      ? request.targetPhone.replace(/\D/g, '')
      : '';
    const chat = getCurrentChatInfo();
    const currentPhone = chat?.phone?.replace(/\D/g, '') || '';
    const targetName = normalizeContactName(request?.targetName);
    const currentName = normalizeContactName(chat?.name);
    const valid = !!requestId
      && !!text
      && text.length <= 4_000
      && /^\d{7,15}$/.test(targetPhone)
      && !!targetName
      && chat?.isGroup === false
      && (currentPhone ? currentPhone === targetPhone : currentName === targetName);
    const success = valid && injectText(text);
    ipcRenderer.send(IPC_CHANNELS.WA_FILL_DRAFT_RESULT, {
      requestId,
      success,
      ...(success ? {} : { error: '当前联系人或 WhatsApp 输入框不可用，未填入草稿' }),
    });
  },
);

function clickAuthorizedSendButton(): boolean {
  const candidate = $(SELECTORS.sendButton, 'sendButton') as HTMLElement | null;
  const button = pickSendButton(candidate as any) as HTMLElement | null;
  if (!button || typeof button.click !== 'function') return false;
  button.click();
  return true;
}

ipcRenderer.on(
  IPC_CHANNELS.WA_SEND_AUTHORIZED,
  (_event, request: {
    requestId?: string;
    actionId?: string;
    text?: string;
    targetPhone?: string;
    targetName?: string;
    expiresAt?: string;
  }) => {
    const requestId = typeof request?.requestId === 'string' ? request.requestId : '';
    const actionId = typeof request?.actionId === 'string' ? request.actionId : '';
    const text = typeof request?.text === 'string' ? request.text.trim() : '';
    const targetPhone = typeof request?.targetPhone === 'string'
      ? request.targetPhone.replace(/\D/g, '')
      : '';
    const expiryMs = Date.parse(typeof request?.expiresAt === 'string' ? request.expiresAt : '');
    const chat = getCurrentChatInfo();
    const currentPhone = chat?.phone?.replace(/\D/g, '') || '';
    const targetName = normalizeContactName(request?.targetName);
    const currentName = normalizeContactName(chat?.name);
    const valid = !!requestId
      && !!actionId
      && !!text
      && text.length <= 4_000
      && /^\d{7,15}$/.test(targetPhone)
      && !!targetName
      && Number.isFinite(expiryMs)
      && expiryMs > Date.now()
      && expiryMs <= Date.now() + 31_000
      && chat?.isGroup === false
      && (currentPhone ? currentPhone === targetPhone : currentName === targetName);
    if (!valid) {
      ipcRenderer.send(IPC_CHANNELS.WA_SEND_AUTHORIZED_RESULT, {
        requestId,
        actionId,
        sent: false,
        reason: 'identity-or-permit-invalid',
      });
      return;
    }
    runInjectAndSend(text, {
      gate: authorizedSendGate,
      clock: {
        setTimeout: (callback, ms) => setTimeout(callback, ms),
        clearTimeout: (handle) => clearTimeout(handle),
      },
      inject: injectText,
      click: clickAuthorizedSendButton,
      onResult: (result) => {
        ipcRenderer.send(IPC_CHANNELS.WA_SEND_AUTHORIZED_RESULT, {
          requestId,
          actionId,
          sent: result.sent,
          reason: result.reason || (result.sent ? 'click-dispatched' : 'click-failed'),
        });
      },
    });
  },
);

function waitForElement<T extends Element>(
  finder: () => T | null,
  timeoutMs: number,
): Promise<T | null> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const check = () => {
      const element = finder();
      if (element) {
        resolve(element);
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        resolve(null);
        return;
      }
      setTimeout(check, 150);
    };
    check();
  });
}

// ════════════════════════════════════════════════════════════
// 登录状态检测
// ════════════════════════════════════════════════════════════

function checkLoginStatus(): string {
  if ($(SELECTORS.loggedIn, 'loggedIn')) return 'logged_in';
  if ($(SELECTORS.qrCode, 'qrCode')) return 'waiting_scan';
  return 'unknown';
}

// ════════════════════════════════════════════════════════════
// AI 浮动面板 — 直接注入 WhatsApp DOM
// ════════════════════════════════════════════════════════════

namespace AIPanel {
  let root: HTMLDivElement | null = null;
  let panel: HTMLDivElement | null = null;
  let isOpen = false;
  let activeTab: 'suggest' | 'translate' | 'analysis' | 'kb' | 'draft' = 'suggest';
  let suggestions: string[] = [];
  let zhInput = '';
  let enOutput = '';
  let isLoadingSuggest = false;
  let isTranslating = false;
  let analysisResult: any = null;
  let isLoadingAnalysis = false;
  let kbContext: any = null;
  let isLoadingKb = false;
  let draftResult: any = null;
  let isLoadingDraft = false;

  // ── 专业 SVG 图标（Lucide 风格，无 emoji）──
  const ICONS = {
    // AI 助手图标 — 星形闪光
    ai: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .962 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.962 0z"/><path d="M20 3v4"/><path d="M22 5h-4"/><path d="M4 17v2"/><path d="M5 18H3"/></svg>',
    // 收起箭头 — 向下
    chevronDown: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;"><path d="m6 9 6 6 6-6"/></svg>',
    // AI 回复 — 灯泡
    lightbulb: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;"><path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/></svg>',
    // 翻译 — 地球
    globe: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>',
    // 关闭 — X
    close: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>',
    // 加载中 — 旋转环
    loader: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;animation:tl-spin 1s linear infinite;"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>',
    // 复制 — 剪贴板
    copy: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>',
    // 发送 — 纸飞机
    send: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;"><path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/></svg>',
    // 生成 — 闪光
    spark: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;"><path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .962 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.962 0z"/></svg>',
    // 客户分析 — 用户
    user: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
    // 知识库 — 书本
    book: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
    // 接待草稿 — 收件箱
    inbox: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>',
  };

  // 注入 spinner 动画 keyframes
  const spinStyle = document.createElement('style');
  spinStyle.textContent = '@keyframes tl-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }';

  // 代理 API 请求（通过主进程）
  async function apiRequest(config: { method?: string; url: string; data?: any; params?: any }) {
    try {
      const result = await ipcRenderer.invoke(IPC_CHANNELS.WA_API_REQUEST, config);
      return result;
    } catch (e) {
      return { success: false, message: String(e) };
    }
  }

  function createEl(tag: string, className: string = '', styles?: Partial<CSSStyleDeclaration>): HTMLElement {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (styles) Object.assign(el.style, styles as any);
    return el;
  }

  function build() {
    if (root) {
      // 确保 root 在 DOM 中（可能被 WhatsApp React 移除）
      if (!document.body.contains(root)) {
        document.body.appendChild(root);
      }
      return;
    }

    // 容器 — 使用 all:initial 隔离 WhatsApp 样式
    // 右侧停靠侧栏（常驻，非悬浮球）：top/right/bottom 全高，宽度 420px
    root = createEl('div', 'tl-ai-root') as HTMLDivElement;
    Object.assign(root.style, {
      all: 'initial',
      position: 'fixed',
      top: '0',
      right: '0',
      bottom: '0',
      width: '420px',
      height: '100vh',
      display: 'flex',
      flexDirection: 'column',
      zIndex: '2147483647',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
      boxShadow: '-2px 0 12px rgba(0,0,0,0.12)',
      background: '#ffffff',
      borderLeft: '1px solid #e5e7eb',
    } as any);

    // ── 面板（占满整个侧栏）──
    panel = createEl('div', 'tl-ai-panel') as HTMLDivElement;
    Object.assign(panel.style, {
      all: 'initial',
      position: 'static',
      flex: '1',
      display: 'flex',
      flexDirection: 'column',
      width: '100%',
      background: '#ffffff',
      overflow: 'hidden',
      fontFamily: 'inherit',
      fontSize: '13px',
      color: '#374151',
      zIndex: '2147483647',
      pointerEvents: 'auto',
    } as any);

    renderPanel();

    root.appendChild(panel);

    if (document.body) {
      document.body.appendChild(root);
      // 注入 spinner 动画
      if (!document.getElementById('tl-spin-style')) {
        spinStyle.id = 'tl-spin-style';
        document.head.appendChild(spinStyle);
      }
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        if (root && !document.body.contains(root)) document.body.appendChild(root);
      });
    }

    // 停靠侧栏常驻：默认展开；不因点击外部而关闭（保留显式折叠按钮）
    open();

    // 保护：如果 root 被移除则重新添加
    const protectObserver = new MutationObserver(() => {
      if (root && !document.body.contains(root)) {
        console.log('[WA AI] root 被移除，重新添加');
        document.body.appendChild(root);
      }
    });
    protectObserver.observe(document.body, { childList: true, subtree: false });
  }

  function renderPanel() {
    if (!panel) return;
    panel.innerHTML = '';

    // 头部
    const header = createEl('div', 'tl-ai-header');
    Object.assign(header.style, {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '10px 14px', borderBottom: '1px solid rgba(0,0,0,0.06)',
      flexShrink: '0',
    });
    const tabs = createEl('div', 'tl-ai-tabs');
    Object.assign(tabs.style, { display: 'flex', gap: '4px' });

    const tabSuggest = createEl('button', 'tl-ai-tab') as HTMLButtonElement;
    Object.assign(tabSuggest.style, {
      all: 'initial', padding: '6px 12px', fontSize: '12px', fontWeight: 500,
      borderRadius: '6px', cursor: 'pointer', fontFamily: 'inherit',
      background: activeTab === 'suggest' ? '#f3f4f6' : 'transparent',
      color: activeTab === 'suggest' ? '#374151' : '#9ca3af',
    });
    tabSuggest.innerHTML = ICONS.lightbulb + ' AI 回复';
    tabSuggest.addEventListener('click', () => { activeTab = 'suggest'; renderPanel(); });

    const tabTranslate = createEl('button', 'tl-ai-tab') as HTMLButtonElement;
    Object.assign(tabTranslate.style, {
      all: 'initial', padding: '6px 12px', fontSize: '12px', fontWeight: 500,
      borderRadius: '6px', cursor: 'pointer', fontFamily: 'inherit',
      background: activeTab === 'translate' ? '#f3f4f6' : 'transparent',
      color: activeTab === 'translate' ? '#374151' : '#9ca3af',
    });
    tabTranslate.innerHTML = ICONS.globe + ' 翻译';
    tabTranslate.addEventListener('click', () => { activeTab = 'translate'; renderPanel(); });

    const tabAnalysis = createEl('button', 'tl-ai-tab') as HTMLButtonElement;
    Object.assign(tabAnalysis.style, {
      all: 'initial', padding: '6px 12px', fontSize: '12px', fontWeight: 500,
      borderRadius: '6px', cursor: 'pointer', fontFamily: 'inherit',
      background: activeTab === 'analysis' ? '#f3f4f6' : 'transparent',
      color: activeTab === 'analysis' ? '#374151' : '#9ca3af',
    });
    tabAnalysis.innerHTML = ICONS.user + ' 客户分析';
    tabAnalysis.addEventListener('click', () => { activeTab = 'analysis'; renderPanel(); });

    const tabKb = createEl('button', 'tl-ai-tab') as HTMLButtonElement;
    Object.assign(tabKb.style, {
      all: 'initial', padding: '6px 12px', fontSize: '12px', fontWeight: 500,
      borderRadius: '6px', cursor: 'pointer', fontFamily: 'inherit',
      background: activeTab === 'kb' ? '#f3f4f6' : 'transparent',
      color: activeTab === 'kb' ? '#374151' : '#9ca3af',
    });
    tabKb.innerHTML = ICONS.book + ' 知识库';
    tabKb.addEventListener('click', () => { activeTab = 'kb'; renderPanel(); });

    const tabDraft = createEl('button', 'tl-ai-tab') as HTMLButtonElement;
    Object.assign(tabDraft.style, {
      all: 'initial', padding: '6px 12px', fontSize: '12px', fontWeight: 500,
      borderRadius: '6px', cursor: 'pointer', fontFamily: 'inherit',
      background: activeTab === 'draft' ? '#f3f4f6' : 'transparent',
      color: activeTab === 'draft' ? '#374151' : '#9ca3af',
    });
    tabDraft.innerHTML = ICONS.inbox + ' 接待草稿';
    tabDraft.addEventListener('click', () => { activeTab = 'draft'; renderPanel(); });

    tabs.appendChild(tabSuggest);
    tabs.appendChild(tabTranslate);
    tabs.appendChild(tabAnalysis);
    tabs.appendChild(tabKb);
    tabs.appendChild(tabDraft);

    const closeBtn = createEl('button', 'tl-ai-close') as HTMLButtonElement;
    Object.assign(closeBtn.style, {
      all: 'initial', cursor: 'pointer', fontSize: '16px', color: '#9ca3af',
      padding: '4px', lineHeight: 1,
    });
    closeBtn.innerHTML = ICONS.close;
    closeBtn.addEventListener('click', () => { collapse(); });

    header.appendChild(tabs);
    header.appendChild(closeBtn);
    panel.appendChild(header);

    // 内容区 — 撑满侧栏剩余空间
    const body = createEl('div', 'tl-ai-body');
    Object.assign(body.style, { padding: '14px', flex: '1', overflowY: 'auto' });

    if (activeTab === 'suggest') {
      renderSuggestTab(body);
    } else if (activeTab === 'analysis') {
      renderAnalysisTab(body);
    } else if (activeTab === 'kb') {
      renderKbTab(body);
    } else if (activeTab === 'draft') {
      renderDraftTab(body);
    } else {
      renderTranslateTab(body);
    }

    panel.appendChild(body);
  }

  function renderSuggestTab(container: HTMLElement) {
    // 上下文预览
    const msgs = getRecentMessages(5);
    if (msgs.length > 0) {
      const ctxBox = createEl('div', 'tl-ai-ctx');
      Object.assign(ctxBox.style, {
        marginBottom: '10px', padding: '8px 10px', borderRadius: '8px',
        background: 'rgba(0,0,0,0.03)', fontSize: '11px', color: '#6b7280',
        maxHeight: '80px', overflowY: 'auto',
      });
      ctxBox.innerHTML = '<div style="margin-bottom:4px;font-weight:600;color:#9ca3af;">最近消息</div>' +
        msgs.slice(-3).map(m =>
          `<div><span style="color:${m.isOutgoing ? '#3b82f6' : '#10b981'};font-weight:600;">${m.isOutgoing ? '我' : '客'}:</span> ${escapeHtml(m.text.slice(0, 80))}</div>`
        ).join('');
      container.appendChild(ctxBox);
    }

    // 生成按钮
    const btnRow = createEl('div', 'tl-ai-btnrow');
    Object.assign(btnRow.style, { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' });
    const hint = createEl('span');
    Object.assign(hint.style, { fontSize: '11px', color: '#9ca3af' });
    hint.textContent = msgs.length > 0 ? '基于最近消息生成回复建议' : '点击生成 AI 回复建议';
    const genBtn = createEl('button', 'tl-ai-genbtn') as HTMLButtonElement;
    Object.assign(genBtn.style, {
      all: 'initial', padding: '6px 14px', borderRadius: '6px', background: '#374151',
      color: '#fff', fontSize: '12px', fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit',
      display: 'inline-flex', alignItems: 'center', gap: '4px', opacity: isLoadingSuggest ? '0.5' : '1',
      border: '1px solid #1f2937',
    });
    genBtn.innerHTML = isLoadingSuggest ? ICONS.loader + ' 生成中...' : ICONS.spark + ' 生成建议';
    genBtn.disabled = isLoadingSuggest;
    genBtn.addEventListener('click', fetchSuggestions);

    btnRow.appendChild(hint);
    btnRow.appendChild(genBtn);
    container.appendChild(btnRow);

    // 建议列表
    if (suggestions.length > 0) {
      const list = createEl('div');
      Object.assign(list.style, { display: 'flex', flexDirection: 'column', gap: '8px' });
      suggestions.forEach((s, i) => {
        const card = createEl('div');
        Object.assign(card.style, {
          padding: '10px 12px', borderRadius: '8px',
          background: '#f9fafb', border: '1px solid #e5e7eb',
        });
        const text = createEl('div');
        Object.assign(text.style, { fontSize: '12px', color: '#374151', lineHeight: '1.5', marginBottom: '8px' });
        text.textContent = s;

        const actions = createEl('div');
        Object.assign(actions.style, { display: 'flex', gap: '6px' });

        const copyBtn = createEl('button') as HTMLButtonElement;
        Object.assign(copyBtn.style, {
          all: 'initial', padding: '4px 10px', borderRadius: '6px', background: '#f3f4f6',
          color: '#4b5563', fontSize: '11px', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500,
        });
        copyBtn.innerHTML = ICONS.copy + ' 复制';
        copyBtn.addEventListener('click', () => {
          navigator.clipboard.writeText(s).catch(() => {});
        });

        const fillBtn = createEl('button') as HTMLButtonElement;
        Object.assign(fillBtn.style, {
          all: 'initial', padding: '4px 10px', borderRadius: '6px', background: '#e5e7eb',
          color: '#374151', fontSize: '11px', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500,
        });
        fillBtn.textContent = '📝 填入草稿';
        fillBtn.addEventListener('click', () => {
          if (injectText(s)) {
            close();
          }
        });

        actions.appendChild(copyBtn);
        actions.appendChild(fillBtn);
        card.appendChild(text);
        card.appendChild(actions);
        list.appendChild(card);
      });
      container.appendChild(list);
    } else if (!isLoadingSuggest) {
      const empty = createEl('div');
      Object.assign(empty.style, { textAlign: 'center', padding: '20px 0', fontSize: '12px', color: '#9ca3af' });
      empty.textContent = '点击"生成建议"，AI 将根据聊天内容生成英文回复';
      container.appendChild(empty);
    }
  }

  // ── 客户分析面板：按当前 WhatsApp 手机号解析 lead → 调用后端 AI 分析 ──
  function renderAnalysisTab(container: HTMLElement) {
    const info = getCurrentChatInfo();
    const phone = info?.phone || '';
    const contactName = info?.name || phone;
    if (!phone) {
      const empty = createEl('div');
      Object.assign(empty.style, { textAlign: 'center', padding: '20px 0', fontSize: '12px', color: '#9ca3af' });
      empty.textContent = '未能识别当前联系人的手机号，请先打开一个 WhatsApp 聊天';
      container.appendChild(empty);
      return;
    }

    const phoneRow = createEl('div');
    Object.assign(phoneRow.style, { fontSize: '11px', color: '#6b7280', marginBottom: '8px', wordBreak: 'break-all' });
    phoneRow.textContent = `联系人: ${contactName}  ·  ${phone}`;
    container.appendChild(phoneRow);

    const genBtn = createEl('button') as HTMLButtonElement;
    Object.assign(genBtn.style, {
      all: 'initial', display: 'inline-flex', alignItems: 'center', gap: '6px',
      padding: '7px 14px', borderRadius: '6px', background: '#374151', color: '#ffffff',
      fontSize: '12px', fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', marginBottom: '10px',
    });
    genBtn.innerHTML = ICONS.spark + ' 生成客户分析';
    genBtn.addEventListener('click', () => {
      if (isLoadingAnalysis) return;
      isLoadingAnalysis = true;
      analysisResult = null;
      renderAnalysisTab(container);
      runAnalysis(container, phone);
    });
    container.appendChild(genBtn);

    if (isLoadingAnalysis) {
      const load = createEl('div');
      Object.assign(load.style, { display: 'flex', alignItems: 'center', gap: '8px', padding: '12px 0', fontSize: '12px', color: '#6b7280' });
      load.innerHTML = ICONS.loader + ' 正在分析客户…';
      container.appendChild(load);
      return;
    }

    if (!analysisResult) {
      const hint = createEl('div');
      Object.assign(hint.style, { fontSize: '11px', color: '#9ca3af', lineHeight: '1.6' });
      hint.textContent = '基于当前客户与 CRM 中的沟通记录，AI 生成客户背景分析、匹配度与下一步建议。';
      container.appendChild(hint);
      return;
    }

    const a = analysisResult.analysis || analysisResult;

    // ── AI 自动标签（无需手动添加）──
    if (Array.isArray(a.tags) && a.tags.length > 0) {
      const tagRow = createEl('div');
      Object.assign(tagRow.style, { display: 'flex', flexWrap: 'wrap', gap: '4px', marginBottom: '8px' });
      a.tags.slice(0, 8).forEach((t: string) => {
        const tag = createEl('span');
        Object.assign(tag.style, { fontSize: '10px', padding: '3px 6px', borderRadius: '6px', background: '#fff7ed', color: '#e26710' });
        tag.textContent = String(t);
        tagRow.appendChild(tag);
      });
      container.appendChild(tagRow);
    }

    // ── 成交概率 + 意图（评分环风格）──
    if (typeof a.probability === 'number') {
      const probRow = createEl('div');
      Object.assign(probRow.style, { display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', background: '#fff', border: '1px solid #edf0f4', borderRadius: '11px', marginBottom: '8px' });
      const ring = createEl('div');
      const angle = Math.max(0, Math.min(100, Number(a.probability))) * 3.6;
      Object.assign(ring.style, { position: 'relative', width: '52px', height: '52px', flex: '0 0 52px', borderRadius: '50%', background: `conic-gradient(#ff6a00 ${angle}deg, #edf1f5 0)`, display: 'flex', alignItems: 'center', justifyContent: 'center', isolation: 'isolate' });
      const ringInner = createEl('div');
      Object.assign(ringInner.style, { position: 'absolute', inset: '5px', zIndex: '-1', borderRadius: '50%', background: '#fff' });
      ring.appendChild(ringInner);
      const num = createEl('div');
      Object.assign(num.style, { position: 'relative', fontSize: '13px', fontWeight: 800, color: '#ff6a00', lineHeight: '1' });
      num.textContent = `${a.probability}%`;
      ring.appendChild(num);
      probRow.appendChild(ring);
      const info = createEl('div');
      Object.assign(info.style, { flex: '1', minWidth: '0' });
      const intent = createEl('div');
      Object.assign(intent.style, { fontSize: '12px', color: '#111827', fontWeight: 600 });
      intent.textContent = a.intent || '成交概率';
      const intentSub = createEl('div');
      Object.assign(intentSub.style, { fontSize: '11px', color: '#6b7280', marginTop: '2px' });
      intentSub.textContent = `客户意图：${a.intent || '待确认'}`;
      info.appendChild(intent);
      info.appendChild(intentSub);
      probRow.appendChild(info);
      container.appendChild(probRow);
    }

    // ── 客户背调基础字段 ──
    const rows: Array<[string, string]> = [];
    if (a.matchScore) rows.push(['业务匹配度', a.matchScore]);
    if (a.estimatedScale) rows.push(['规模', a.estimatedScale]);
    if (a.contactInfo) rows.push(['联系人', a.contactInfo]);
    if (a.businessMatch) rows.push(['业务匹配', a.businessMatch]);
    if (a.recommendation) rows.push(['建议', a.recommendation]);
    if (a.confidence) rows.push(['可信度', a.confidence]);
    if (a.summary) rows.push(['判断', a.summary]);

    if (rows.length > 0) {
      const card = createEl('div');
      Object.assign(card.style, { padding: '10px 12px', background: '#fff', border: '1px solid #edf0f4', borderRadius: '11px', marginBottom: '8px' });
      for (const [label, value] of rows) {
        const row = createEl('div');
        Object.assign(row.style, { display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#6b7280', padding: '3px 0' });
        const lbl = createEl('span');
        lbl.textContent = label;
        const val = createEl('span');
        Object.assign(val.style, { color: '#2c3e50', textAlign: 'right', maxWidth: '200px' });
        val.textContent = String(value);
        row.appendChild(lbl);
        row.appendChild(val);
        card.appendChild(row);
      }
      container.appendChild(card);
    }

    // ── 下一步行动（stepper 风格）──
    if (Array.isArray(a.nextSteps) && a.nextSteps.length > 0) {
      const nextTitle = createEl('div');
      Object.assign(nextTitle.style, { fontSize: '13px', fontWeight: 600, color: '#172033', marginBottom: '6px' });
      nextTitle.textContent = '下一步行动';
      container.appendChild(nextTitle);
      const stepper = createEl('div');
      Object.assign(stepper.style, { display: 'grid', gridTemplateColumns: `repeat(${Math.min(a.nextSteps.length, 3)}, minmax(0,1fr))`, gap: '4px', marginBottom: '8px' });
      a.nextSteps.slice(0, 3).forEach((s: any, i: number) => {
        const step = createEl('div');
        Object.assign(step.style, { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px', textAlign: 'center' });
        const n = createEl('span');
        Object.assign(n.style, { width: '20px', height: '20px', borderRadius: '50%', background: i === 0 ? '#0ea5e9' : '#f1f3f6', color: i === 0 ? '#fff' : '#aeb6c1', fontSize: '9px', fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' });
        n.textContent = String(i + 1);
        const title = typeof s === 'string' ? s : s?.title || '';
        const desc = typeof s === 'string' ? '' : s?.description || '';
        const t = createEl('div');
        Object.assign(t.style, { fontSize: '9px', color: '#334155', lineHeight: '1.45', fontWeight: 600 });
        t.textContent = title;
        step.appendChild(n);
        step.appendChild(t);
        if (desc) {
          const d = createEl('div');
          Object.assign(d.style, { fontSize: '8px', color: '#8b96a5', lineHeight: '1.4' });
          d.textContent = desc;
          step.appendChild(d);
        }
        stepper.appendChild(step);
      });
      container.appendChild(stepper);
    }

    // ── AI 推荐回复（4 tab + 中文对照 + 一键填入）──
    if (a.replyVariants && typeof a.replyVariants === 'object') {
      const replyTitle = createEl('div');
      Object.assign(replyTitle.style, { fontSize: '13px', fontWeight: 600, color: '#172033', marginBottom: '6px' });
      replyTitle.textContent = 'AI 推荐回复';
      container.appendChild(replyTitle);

      const tabs = createEl('div');
      Object.assign(tabs.style, { display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', borderBottom: '1px solid #eef1f4' });
      const variants: Array<[string, string]> = [
        ['standard', '标准'], ['brief', '简短'], ['detailed', '详细'], ['chinese', '中文对照'],
      ];
      let currentReply = '';
      let currentTranslation = '';

      const replyBody = createEl('div');
      Object.assign(replyBody.style, { minHeight: '70px', marginTop: '8px', padding: '11px', border: '1px solid #e8ebef', borderRadius: '8px', background: '#fcfcfd', color: '#27364a', fontSize: '13px', lineHeight: '1.7' });

      const translationBlock = createEl('div');
      Object.assign(translationBlock.style, { display: 'none', marginTop: '8px', paddingTop: '10px', borderTop: '1px solid #eef1f4', color: '#334256', fontSize: '13px', lineHeight: '1.8' });
      const transLabel = createEl('div');
      Object.assign(transLabel.style, { marginBottom: '6px', color: '#0369a1', fontSize: '13px', fontWeight: 600 });
      transLabel.textContent = '中文对照';
      const transText = createEl('div');
      translationBlock.appendChild(transLabel);
      translationBlock.appendChild(transText);

      const setReply = (key: string) => {
        tabs.querySelectorAll('button').forEach((b) => {
          b.classList.toggle('tl-ai-tab-active', (b as HTMLElement).dataset.key === key);
        });
        const variant = a.replyVariants[key] || a.replyVariants.standard || '';
        currentReply = String(variant);
        currentTranslation = key === 'chinese' ? String(a.replyVariants.standard || '') : String(a.replyVariants.chinese || '');
        replyBody.textContent = currentReply;
        transText.textContent = currentTranslation;
        translationBlock.style.display = key === 'chinese' ? 'block' : 'none';
      };

      variants.forEach(([key, label]) => {
        const btn = createEl('button') as HTMLButtonElement;
        Object.assign(btn.style, { padding: '8px 3px', border: '0', borderBottom: '2px solid transparent', background: 'transparent', color: '#788596', fontSize: '11px', cursor: 'pointer', fontFamily: 'inherit' });
        btn.dataset.key = key;
        btn.textContent = label;
        btn.addEventListener('click', () => setReply(key));
        tabs.appendChild(btn);
      });
      container.appendChild(tabs);
      container.appendChild(replyBody);
      container.appendChild(translationBlock);

      const replyActions = createEl('div');
      Object.assign(replyActions.style, { display: 'flex', gap: '6px', marginTop: '8px', marginBottom: '8px' });
      const copyBtn = createEl('button') as HTMLButtonElement;
      Object.assign(copyBtn.style, { fontSize: '11px', padding: '7px 12px', borderRadius: '6px', border: '1px solid #e3e8ef', background: '#fff', color: '#4b5563', cursor: 'pointer' });
      copyBtn.textContent = '复制';
      copyBtn.addEventListener('click', () => { if (currentReply) navigator.clipboard.writeText(currentReply).catch(() => {}); });
      const fillBtn = createEl('button') as HTMLButtonElement;
      Object.assign(fillBtn.style, { fontSize: '11px', padding: '7px 12px', borderRadius: '6px', border: '1px solid #0ea5e9', background: 'linear-gradient(135deg,#38bdf8,#2563eb)', color: '#fff', fontWeight: 700, cursor: 'pointer' });
      fillBtn.textContent = '一键填入发送';
      fillBtn.addEventListener('click', () => { if (currentReply && injectText(currentReply)) close(); });
      replyActions.appendChild(copyBtn);
      replyActions.appendChild(fillBtn);
      container.appendChild(replyActions);

      setReply('standard');
    }

    // ── 回复质检（插件风格）──
    if (a.replyQuality && typeof a.replyQuality === 'object') {
      const q = a.replyQuality;
      const qTitle = createEl('div');
      Object.assign(qTitle.style, { fontSize: '13px', fontWeight: 600, color: '#172033', marginBottom: '6px' });
      qTitle.textContent = '业务员回复质检';
      container.appendChild(qTitle);
      const qCard = createEl('div');
      Object.assign(qCard.style, { padding: '11px', background: '#fff', border: '1px solid #edf0f4', borderRadius: '11px' });

      if (typeof q.score === 'number') {
        const lead = createEl('div');
        Object.assign(lead.style, { display: 'flex', alignItems: 'baseline', gap: '6px' });
        const score = createEl('span');
        Object.assign(score.style, { color: '#ff6a00', fontSize: '17px', fontWeight: 700 });
        score.textContent = String(q.score);
        const suffix = createEl('span');
        Object.assign(suffix.style, { color: '#46576c', fontSize: '12px' });
        suffix.textContent = '/100';
        lead.appendChild(score);
        lead.appendChild(suffix);
        qCard.appendChild(lead);
      }
      const dims: Array<[string, string | number]> = [
        ['响应时效', q.timeliness], ['需求识别', q.clarity], ['专业度', q.tone], ['信息完整', q.completeness],
      ];
      dims.forEach(([label, v]) => {
        if (!v) return;
        const row = createEl('div');
        Object.assign(row.style, { display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: '#6b7280', padding: '2px 0' });
        const l = createEl('span'); l.textContent = label;
        const val = createEl('span'); Object.assign(val.style, { color: '#374151' }); val.textContent = String(v);
        row.appendChild(l); row.appendChild(val);
        qCard.appendChild(row);
      });
      container.appendChild(qCard);
    }
  }

  async function runAnalysis(container: HTMLElement, phone: string) {
    try {
      const resolved = await apiRequest({ method: 'GET', url: `/ai-communications/whatsapp-lead/${encodeURIComponent(phone)}` });
      const leadId = resolved?.data?.leadId || resolved?.leadId;
      if (!leadId) {
        analysisResult = { analysis: { summary: 'CRM 中未找到该号码对应的客户。可先在前台创建/关联该客户后重试。', confidence: '未匹配到 Lead' } };
        isLoadingAnalysis = false;
        renderAnalysisTab(container);
        return;
      }
      const res = await apiRequest({ method: 'POST', url: `/ai-communications/customer-analysis/${leadId}` });
      const analysis = res?.data?.analysis || res?.analysis;
      analysisResult = { analysis: analysis || { summary: '分析完成，但未返回结构化结果。', confidence: '未知' } };
    } catch (e) {
      analysisResult = { analysis: { summary: `分析失败: ${String(e)}`, confidence: '错误' } };
    }
    isLoadingAnalysis = false;
    renderAnalysisTab(container);
  }

  // ── 知识库面板：显示公司品牌与主营产品上下文 ──
  function renderKbTab(container: HTMLElement) {
    if (isLoadingKb) {
      const load = createEl('div');
      Object.assign(load.style, { display: 'flex', alignItems: 'center', gap: '8px', padding: '12px 0', fontSize: '12px', color: '#6b7280' });
      load.innerHTML = ICONS.loader + ' 正在加载知识库…';
      container.appendChild(load);
      return;
    }

    const loadBtn = createEl('button') as HTMLButtonElement;
    Object.assign(loadBtn.style, {
      all: 'initial', display: 'inline-flex', alignItems: 'center', gap: '6px',
      padding: '7px 14px', borderRadius: '6px', background: '#374151', color: '#ffffff',
      fontSize: '12px', fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', marginBottom: '10px',
    });
    loadBtn.innerHTML = ICONS.book + (kbContext ? ' 刷新知识库' : ' 加载知识库');
    loadBtn.addEventListener('click', async () => {
      isLoadingKb = true;
      renderKbTab(container);
      const res = await apiRequest({ method: 'GET', url: '/ai-communications/knowledge-context' });
      kbContext = res?.data || res;
      isLoadingKb = false;
      renderKbTab(container);
    });
    container.appendChild(loadBtn);

    if (!kbContext) {
      const hint = createEl('div');
      Object.assign(hint.style, { fontSize: '11px', color: '#9ca3af', lineHeight: '1.6' });
      hint.textContent = '加载后展示公司品牌信息与主营产品，供 AI 回复和接待草稿引用。';
      container.appendChild(hint);
      return;
    }

    const name = kbContext.companyName || '—';
    const block = (label: string, value: string) => {
      if (!value) return;
      const row = createEl('div');
      Object.assign(row.style, { padding: '6px 0', borderBottom: '1px solid #f3f4f6' });
      const lbl = createEl('div');
      Object.assign(lbl.style, { fontSize: '11px', color: '#9ca3af', fontWeight: 500 });
      lbl.textContent = label;
      const val = createEl('div');
      Object.assign(val.style, { fontSize: '12px', color: '#374151', lineHeight: '1.5', whiteSpace: 'pre-wrap', wordBreak: 'break-word' });
      val.textContent = value;
      row.appendChild(lbl);
      row.appendChild(val);
      container.appendChild(row);
    };

    block('公司', name);
    block('行业', kbContext.industry);
    block('国家', kbContext.country);
    block('网站', kbContext.website);
    block('简介', kbContext.description);

    const products = (kbContext.products || []).slice(0, 10);
    if (products.length > 0) {
      const prodTitle = createEl('div');
      Object.assign(prodTitle.style, { fontSize: '12px', fontWeight: 600, color: '#374151', padding: '8px 0 4px' });
      prodTitle.textContent = `主营产品 (${products.length})`;
      container.appendChild(prodTitle);
      for (const p of products) {
        const item = createEl('div');
        Object.assign(item.style, { fontSize: '12px', color: '#4b5563', padding: '4px 0', lineHeight: '1.4' });
        item.textContent = `${p.name}${p.sku ? ` · ${p.sku}` : ''}${p.description ? ` — ${p.description}` : ''}`;
        container.appendChild(item);
      }
    }
  }

  // ── 接待草稿面板：基于知识库 + 客户消息生成回复草稿 ──
  function renderDraftTab(container: HTMLElement) {
    const info = getCurrentChatInfo();
    const phone = info?.phone || '';
    const messages = getRecentMessages(8);
    const customerText = messages.filter(m => !m.isOutgoing).map(m => m.text).join('\n').slice(0, 800);

    const hint = createEl('div');
    Object.assign(hint.style, { fontSize: '11px', color: '#9ca3af', marginBottom: '8px', lineHeight: '1.5' });
    hint.textContent = customerText
      ? '基于知识库与最近客户消息生成接待草稿（英文）。'
      : '打开一个 WhatsApp 聊天后，可基于该对话生成接待草稿。';
    container.appendChild(hint);

    const genBtn = createEl('button') as HTMLButtonElement;
    Object.assign(genBtn.style, {
      all: 'initial', display: 'inline-flex', alignItems: 'center', gap: '6px',
      padding: '7px 14px', borderRadius: '6px', background: '#374151', color: '#ffffff',
      fontSize: '12px', fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', marginBottom: '10px',
    });
    genBtn.innerHTML = ICONS.spark + ' 生成接待草稿';
    genBtn.addEventListener('click', async () => {
      if (isLoadingDraft) return;
      isLoadingDraft = true;
      draftResult = null;
      renderDraftTab(container);
      const res = await apiRequest({
        method: 'POST',
        url: '/ai-communications/reception-draft',
        data: { customerMessage: customerText || phone, targetLanguage: 'en' },
      });
      draftResult = res?.data || res;
      isLoadingDraft = false;
      renderDraftTab(container);
    });
    container.appendChild(genBtn);

    if (isLoadingDraft) {
      const load = createEl('div');
      Object.assign(load.style, { display: 'flex', alignItems: 'center', gap: '8px', padding: '12px 0', fontSize: '12px', color: '#6b7280' });
      load.innerHTML = ICONS.loader + ' 正在生成接待草稿…';
      container.appendChild(load);
      return;
    }

    if (!draftResult) return;

    const draft = draftResult.draft || '';
    if (draft) {
      const box = createEl('div');
      Object.assign(box.style, {
        padding: '10px 12px', borderRadius: '8px', background: '#f9fafb',
        border: '1px solid #e5e7eb', fontSize: '12px', color: '#374151',
        lineHeight: '1.6', whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginBottom: '8px',
      });
      box.textContent = draft;
      container.appendChild(box);

      const actions = createEl('div');
      Object.assign(actions.style, { display: 'flex', gap: '6px' });
      const copyBtn = createEl('button') as HTMLButtonElement;
      Object.assign(copyBtn.style, {
        all: 'initial', padding: '4px 10px', borderRadius: '6px', background: '#f3f4f6',
        color: '#4b5563', fontSize: '11px', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500,
      });
      copyBtn.innerHTML = ICONS.copy + ' 复制';
      copyBtn.addEventListener('click', () => { navigator.clipboard.writeText(draft).catch(() => {}); });
      const fillBtn = createEl('button') as HTMLButtonElement;
      Object.assign(fillBtn.style, {
        all: 'initial', padding: '4px 10px', borderRadius: '6px', background: '#e5e7eb',
        color: '#374151', fontSize: '11px', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500,
      });
      fillBtn.textContent = '填入草稿';
      fillBtn.addEventListener('click', () => { if (injectText(draft)) close(); });
      actions.appendChild(copyBtn);
      actions.appendChild(fillBtn);
      container.appendChild(actions);
    }

    const meta = createEl('div');
    Object.assign(meta.style, { fontSize: '11px', color: '#9ca3af', marginTop: '6px' });
    const conf = draftResult.confidence ? `置信度: ${draftResult.confidence} · ` : '';
    const needsHuman = draftResult.needsHuman ? '建议人工确认' : '可发送';
    meta.textContent = `${conf}${needsHuman}`;
    container.appendChild(meta);
  }

  function renderTranslateTab(container: HTMLElement) {
    const desc = createEl('div');
    Object.assign(desc.style, { fontSize: '11px', color: '#9ca3af', marginBottom: '8px' });
    desc.textContent = '输入中文，翻译为英文草稿；核对后由你手动发送';
    container.appendChild(desc);

    const ta = createEl('textarea') as HTMLTextAreaElement;
    Object.assign(ta.style, {
      all: 'initial', width: '100%', boxSizing: 'border-box', minHeight: '80px',
      padding: '10px 12px', borderRadius: '10px', border: '1px solid #e5e7eb',
      fontSize: '13px', fontFamily: 'inherit', color: '#1f2937', resize: 'vertical',
      outline: 'none', display: 'block', background: '#fff',
    } as any);
    ta.placeholder = '请输入中文...';
    ta.value = zhInput;
    ta.addEventListener('input', (e) => {
      zhInput = (e.target as HTMLTextAreaElement).value;
      debouncedTranslate();
    });
    container.appendChild(ta);

    if (enOutput) {
      const result = createEl('div');
      Object.assign(result.style, {
        marginTop: '10px', padding: '10px 12px', borderRadius: '10px',
        background: '#f9fafb', border: '1px solid #e5e7eb',
      });
      const outText = createEl('div');
      Object.assign(outText.style, { fontSize: '13px', color: '#374151', lineHeight: '1.5', marginBottom: '8px' });
      outText.textContent = enOutput;

      const actions = createEl('div');
      Object.assign(actions.style, { display: 'flex', gap: '6px' });

      const copyBtn = createEl('button') as HTMLButtonElement;
      Object.assign(copyBtn.style, {
        all: 'initial', padding: '4px 10px', borderRadius: '6px', background: '#f3f4f6',
        color: '#4b5563', fontSize: '11px', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500,
      });
      copyBtn.innerHTML = ICONS.copy + ' 复制';
      copyBtn.addEventListener('click', () => navigator.clipboard.writeText(enOutput).catch(() => {}));

      const fillBtn = createEl('button') as HTMLButtonElement;
      Object.assign(fillBtn.style, {
        all: 'initial', padding: '4px 10px', borderRadius: '6px', background: '#e5e7eb',
        color: '#374151', fontSize: '11px', cursor: 'pointer', fontFamily: 'inherit', fontWeight: 500,
      });
      fillBtn.textContent = '📝 填入草稿';
      fillBtn.addEventListener('click', () => {
        if (injectText(enOutput)) {
          zhInput = ''; enOutput = ''; renderPanel(); close();
        }
      });

      actions.appendChild(copyBtn);
      actions.appendChild(fillBtn);
      result.appendChild(outText);
      result.appendChild(actions);
      container.appendChild(result);
    }

    if (isTranslating) {
      const loading = createEl('div');
      Object.assign(loading.style, { fontSize: '11px', color: '#9ca3af', marginTop: '6px' });
      loading.innerHTML = ICONS.loader + ' 翻译中...';
      container.appendChild(loading);
    }
  }

  let translateTimer: ReturnType<typeof setTimeout> | null = null;
  function debouncedTranslate() {
    if (translateTimer) clearTimeout(translateTimer);
    translateTimer = setTimeout(doTranslate, 500);
  }

  async function doTranslate() {
    if (!zhInput.trim()) { enOutput = ''; renderPanel(); return; }
    isTranslating = true;
    renderPanel();
    try {
      const res = await apiRequest({
        method: 'POST',
        url: '/ai-communications/translate-draft',
        data: { text: zhInput, targetLanguage: 'en' },
      });
      if (res.success) {
        // 后端返回 { draft: "translated text", language, aiEnabled }
        enOutput = res.data?.draft || res.data?.data?.draft || res.data?.translation || res.data?.data?.translation || '';
      } else {
        enOutput = 'Translation failed: ' + (res.message || 'unknown error');
      }
    } catch (e: any) {
      enOutput = 'Translation failed';
    }
    isTranslating = false;
    renderPanel();
  }

  async function fetchSuggestions() {
    isLoadingSuggest = true;
    renderPanel();
    try {
      const msgs = getRecentMessages(10);
      const chatContext = msgs.map(m => `${m.isOutgoing ? 'Me' : 'Customer'}: ${m.text}`).join('\n');
      const res = await apiRequest({
        method: 'POST',
        url: '/ai-communications/generate-reply',
        data: { context: chatContext, targetLanguage: 'en' },
      });
      if (res.success) {
        // 后端返回 { replies: [...], language, aiEnabled }
        const data = res.data?.replies || res.data?.data?.replies || [];
        suggestions = Array.isArray(data) && data.length > 0 ? data.slice(0, 3) : ['Sorry, I cannot generate a reply right now.'];
      } else {
        suggestions = ['Sorry, AI service is temporarily unavailable. ' + (res.message || '')];
      }
    } catch (e: any) {
      suggestions = ['Sorry, AI service is temporarily unavailable.'];
    }
    isLoadingSuggest = false;
    renderPanel();
  }

  function open() {
    isOpen = true;
    if (root) root.style.display = 'flex';
    applyDockOffset();
  }

  function close() {
    isOpen = false;
    if (root) root.style.display = 'none';
    applyDockOffset();
  }

  function collapse() {
    isOpen = false;
    if (root) root.style.display = 'none';
    applyDockOffset();
  }

  function toggle() {
    if (isOpen) close(); else open();
  }

  // WhatsApp 内容让位：侧栏显示时把 #app 左移 420px，避免遮挡消息区
  function applyDockOffset() {
    try {
      const offset = isOpen ? '420px' : '0px';
      document.documentElement.style.setProperty('--tl-ai-dock-offset', offset);
    } catch (e) {
      // 忽略样式设置失败
    }
  }

  function escapeHtml(s: string): string {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  export function init() {
    const tryBuild = () => {
      if (document.body) {
        build();
        return true;
      }
      return false;
    };

    if (!tryBuild()) {
      const iv = setInterval(() => {
        if (tryBuild()) clearInterval(iv);
      }, 300);
    }

    // 定期检查 root 是否在 DOM 中（WhatsApp SPA 导航可能移除它）
    setInterval(() => {
      if (root && !document.body.contains(root)) {
        console.log('[WA AI] 检测到 root 被移除，重新注入');
        build();
      }
    }, 3000);
  }
}

// ════════════════════════════════════════════════════════════
// 消息实时翻译 — 在每条收到的客户消息下方注入中文翻译
// ════════════════════════════════════════════════════════════

namespace MessageTranslator {
  const translationCache = new Map<string, string>();
  const translatedIds = new Set<string>();
  const MAX_CACHE = 200;
  const MAX_TRANSLATED = 500; // 防止内存无限增长

  // ── 并发控制：同一时间最多1个翻译请求 ──
  let isProcessing = false;
  const pendingQueue: Element[] = [];
  let scanDebounceTimer: number | null = null;
  let observer: MutationObserver | null = null;
  let isDestroyed = false;

  // 代理 API 请求
  async function apiRequest(config: { method?: string; url: string; data?: any }) {
    try {
      return await ipcRenderer.invoke(IPC_CHANNELS.WA_API_REQUEST, config);
    } catch (e) {
      return { success: false, message: String(e) };
    }
  }

  function containsChinese(text: string): boolean {
    return /[\u4e00-\u9fa5]/.test(text);
  }

  function isTranslatable(text: string): boolean {
    if (!text || text.trim().length < 2) return false;
    if (containsChinese(text)) return false;
    if (/^https?:\/\//i.test(text.trim())) return false;
    if (/^\d+[\d\s.,+-]*$/.test(text.trim())) return false;
    return true;
  }

  async function translateText(text: string): Promise<string> {
    const cacheKey = text.slice(0, 100);
    if (translationCache.has(cacheKey)) {
      return translationCache.get(cacheKey)!;
    }

    const res = await apiRequest({
      method: 'POST',
      url: '/ai-communications/translate-draft',
      data: { text, targetLanguage: 'zh' },
    });

    let translated = '';
    if (res.success) {
      translated = res.data?.draft || res.data?.data?.draft || res.data?.translation || res.data?.data?.translation || '';
    }

    if (isUnavailableAiTranslation(translated)) return '';

    if (translationCache.size < MAX_CACHE) {
      translationCache.set(cacheKey, translated);
    }
    return translated;
  }

  function injectTranslation(msgEl: Element, translation: string) {
    if (msgEl.querySelector('.tl-translation')) return;

    const translationDiv = document.createElement('div');
    translationDiv.className = 'tl-translation';
    Object.assign(translationDiv.style, {
      fontSize: '12px', color: '#6b7280', marginTop: '4px',
      padding: '3px 8px', borderRadius: '6px', background: 'rgba(0,0,0,0.04)',
      lineHeight: '1.4', maxWidth: '400px', wordBreak: 'break-word',
      fontStyle: 'normal', borderLeft: '2px solid #d1d5db',
    } as any);

    translationDiv.innerHTML = '<span style="color:#9ca3af;font-size:10px;margin-right:4px;">译</span>' +
      '<span style="color:#4b5563;">' + escapeHtmlSimple(translation) + '</span>';

    // 临时断开 observer，避免注入 DOM 触发回调循环
    if (observer) observer.disconnect();

    const textContainer = msgEl.querySelector('.selectable-text, .copyable-text') as HTMLElement;
    if (textContainer && textContainer.parentNode) {
      textContainer.parentNode.insertBefore(translationDiv, textContainer.nextSibling);
    } else {
      msgEl.appendChild(translationDiv);
    }

    // 重新连接 observer
    if (observer && !isDestroyed) {
      observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  function escapeHtmlSimple(s: string): string {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  // 检查消息元素是否值得翻译
  function shouldTranslate(msgEl: Element): { ok: boolean; text: string } {
    const dataId = msgEl.getAttribute('data-id') || msgEl.closest('[data-id]')?.getAttribute('data-id');
    if (!dataId) return { ok: false, text: '' };
    // 已经有翻译DOM子元素了 → 标记为已翻译，跳过
    if (msgEl.querySelector('.tl-translation')) {
      translatedIds.add(dataId);
      return { ok: false, text: '' };
    }
    // 已在内存中标记过翻译，但DOM没有（可能是切聊天后DOM重建）
    // → 不跳过！需要重新注入翻译，但后端会从缓存秒回
    if (translatedIds.has(dataId)) {
      // 标记为需要重新注入，但不阻止处理
      translatedIds.delete(dataId);
    }

    const isOutgoing = msgEl.classList.contains('message-out') ||
      msgEl.closest('.message-out') !== null ||
      dataId.includes('_true_');
    if (isOutgoing) return { ok: false, text: '' };

    const textEl = msgEl.querySelector('.selectable-text span, .copyable-text span, span.selectable-text') as HTMLElement;
    const text = textEl?.textContent?.trim() || '';
    if (!isTranslatable(text)) return { ok: false, text: '' };

    return { ok: true, text };
  }

  // 从队列中取一条消息翻译（串行，不并发）
  async function processNext() {
    if (isProcessing || isDestroyed) return;
    const msgEl = pendingQueue.shift();
    if (!msgEl) return;

    // 元素可能已被移除（切换聊天）
    if (!msgEl.isConnected) {
      processNext();
      return;
    }

    const { ok, text } = shouldTranslate(msgEl);
    if (!ok) {
      processNext();
      return;
    }

    const dataId = msgEl.getAttribute('data-id') || msgEl.closest('[data-id]')?.getAttribute('data-id') || '';
    isProcessing = true;

    try {
      const translation = await translateText(text);
      if (translation && msgEl.isConnected && !isDestroyed) {
        injectTranslation(msgEl, translation);
        translatedIds.add(dataId);
        // 清理 translatedIds 防止无限增长
        if (translatedIds.size > MAX_TRANSLATED) {
          const first = translatedIds.values().next().value;
          if (first) translatedIds.delete(first);
        }
      }
    } catch (e) {
      console.warn('[WA Translate] 翻译失败:', e);
    } finally {
      isProcessing = false;
      // 继续处理队列中的下一条，但加一个小延迟避免请求过密
      setTimeout(processNext, 300);
    }
  }

  // 将待翻译消息加入队列
  function enqueueMessage(msgEl: Element) {
    const { ok } = shouldTranslate(msgEl);
    if (!ok) return;
    pendingQueue.push(msgEl);
    if (!isProcessing) {
      processNext();
    }
  }

  // 防抖扫描：多次触发只执行一次
  function debouncedScan() {
    if (scanDebounceTimer !== null) {
      clearTimeout(scanDebounceTimer);
    }
    scanDebounceTimer = window.setTimeout(() => {
      scanDebounceTimer = null;
      if (isDestroyed) return;
      const msgElements = $$(SELECTORS.messageRow, 'messageRow');
      for (const el of msgElements) {
        enqueueMessage(el);
      }
    }, 500);
  }

  export function init() {
    // 初始扫描（延迟，等 WhatsApp DOM 加载完成）
    setTimeout(debouncedScan, 5000);

    // MutationObserver — 只监听真正的消息节点，忽略我们自己的翻译注入
    observer = new MutationObserver((mutations) => {
      if (isDestroyed) return;
      let hasNewMessages = false;
      for (const mutation of mutations) {
        for (const node of Array.from(mutation.addedNodes)) {
          if (node.nodeType !== 1) continue;
          const el = node as Element;
          // 忽略我们注入的翻译元素
          if (el.classList && el.classList.contains('tl-translation')) continue;
          // 忽略纯样式变化
          const msgEl = el.matches && el.matches('[data-id]') ? el : (el.querySelector ? el.querySelector('[data-id]') : null);
          if (msgEl) {
            hasNewMessages = true;
            break;
          }
        }
        if (hasNewMessages) break;
      }
      if (hasNewMessages) {
        debouncedScan();
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // 定期扫描漏网消息（降低频率到30秒）
    setInterval(() => {
      if (!isDestroyed && !isProcessing && pendingQueue.length === 0) {
        debouncedScan();
      }
    }, 30000);

    console.log('[WA Translate] 消息翻译组件已启动 (v2 防抖+串行)');
  }
}

// ════════════════════════════════════════════════════════════
// CSS 注入
// ════════════════════════════════════════════════════════════

function injectCSS() {
  const style = document.createElement('style');
  style.id = 'vaysen-crm-custom-css';
  style.textContent = `
    /* 缩小 WhatsApp 导航图标条宽度（不使用 display:none 避免破坏 flex 布局） */
    div[data-testid="app-navigation"] {
      width: 0 !important; min-width: 0 !important; overflow: hidden !important; opacity: 0 !important;
    }
    /* 隐藏下载推广横幅 — 覆盖多种可能的class和data属性 */
    div[data-testid="download-banner"],
    div[data-testid="banner"],
    a[href*="download"],
    div[class*="download-banner"],
    div[class*="app-banner"],
    div[class*="promo-banner"],
    div[class*="DownloadBar"],
    div[class*="download-bar"] {
      display: none !important; height: 0 !important; overflow: hidden !important; opacity: 0 !important; pointer-events: none !important;
    }
    /* AI 面板容器 — 确保不受 WhatsApp CSS 影响 */
    .tl-ai-root, .tl-ai-root * {
      box-sizing: border-box;
    }
    .tl-ai-root textarea:focus {
      border-color: #10b981 !important;
    }
    .tl-ai-root button:hover {
      filter: brightness(0.95);
    }
    .tl-ai-tab-active {
      color: #0ea5e9 !important;
      font-weight: 700;
      border-bottom-color: #0ea5e9 !important;
    }
    /* WhatsApp 内容让位：侧栏显示时 #app 右移，避免遮挡消息区 */
    html:root { --tl-ai-dock-offset: 0px; }
    #app { margin-right: var(--tl-ai-dock-offset, 0px) !important; transition: margin-right 0.15s ease; }
    /* 侧栏自身滚动与层级 */
    .tl-ai-body { scrollbar-width: thin; scrollbar-color: #d1d5db transparent; }
  `;
  const inject = () => {
    if (document.head) { document.head.appendChild(style); }
    else setTimeout(inject, 100);
  };
  inject();

  // 只通过点击 X 按钮关闭下载横幅（安全，不会误伤其他元素）
  const closeDownloadBanner = () => {
    try {
      // 只查找底部区域（y > 80% 屏幕高度）的 X 关闭按钮
      const allX = document.querySelectorAll('span[data-icon="x"], span[data-icon="x-alt"], button[aria-label="Close"], button[aria-label="关闭"]');
      for (const x of Array.from(allX)) {
        const rect = (x as HTMLElement).getBoundingClientRect();
        // 只处理位于屏幕底部 20% 区域的小元素
        if (rect.bottom > window.innerHeight * 0.8 && rect.height < 40 && rect.width < 40) {
          (x as HTMLElement).click();
          console.log('[WA] 已点击下载横幅关闭按钮');
        }
      }
    } catch (e) {
      // ignore
    }
  };
  setTimeout(closeDownloadBanner, 2000);
  setTimeout(closeDownloadBanner, 5000);
}

// ════════════════════════════════════════════════════════════
// 联系人同步 — 只传可信快照,过滤群组/self/系统文案 (TASK-102D)
// ════════════════════════════════════════════════════════════

function syncContacts() {
  const items = $$(SELECTORS.chatListItem, 'chatListItem');
  if (items.length === 0) return;

  const contacts: WhatsAppContactSnapshot[] = [];
  for (const item of items.slice(0, 50)) {
    try {
      const snapshot = buildContactSnapshotFromElement(item);
      if (!snapshot) continue;
      // 在源头过滤群组与自己;系统文案伪联系人已被 snapshot displayName 判定过滤
      if (snapshot.isGroup || snapshot.isSelf) continue;
      contacts.push(snapshot);
    } catch {}
  }

  if (contacts.length > 0) {
    ipcRenderer.send(IPC_CHANNELS.WA_CONTACTS_SYNC, {
      contacts,
      timestamp: Date.now(),
      total: contacts.length,
    });
  }
}

function getUnreadCount(): number {
  const badges = $$(SELECTORS.unreadBadge, 'unreadBadge');
  let total = 0;
  for (const badge of badges) {
    const text = (badge as HTMLElement).textContent?.trim() || '';
    const count = parseInt(text, 10);
    if (!Number.isNaN(count) && count > 0) total += count;
  }
  return total;
}

function initReconnectMonitor(): void {
  setInterval(() => {
    const offline = $(SELECTORS.offlineNotice, 'offlineNotice');
    if (offline) {
      console.warn('[WA] 检测到断线，10秒后刷新');
      setTimeout(() => window.location.reload(), 10000);
    }
  }, RECONNECT_CHECK_INTERVAL);
}

function initMessageObserver(): void {
  const msgObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of Array.from(mutation.addedNodes)) {
        if (node.nodeType !== 1) continue;
        const el = node as Element;
        const msgEl = el.matches('[data-id]') ? el : el.querySelector('[data-id]');
        if (msgEl) {
          const msg = extractMessage(msgEl, processedMessageIds, MAX_DEDUP_SIZE);
          if (msg) {
            const chat = getCurrentChatInfo();
            // 优先用活跃聊天项的可信 JID 快照;不再从状态文本猜号码 (TASK-102D)
            let snapshot: WhatsAppContactSnapshot | null = null;
            for (const sel of SELECTORS.activeChatItem) {
              try {
                const activeEl = document.querySelector(sel);
                if (activeEl) {
                  snapshot = buildContactSnapshotFromElement(activeEl);
                  if (snapshot) break;
                }
              } catch {}
            }
            ipcRenderer.send(IPC_CHANNELS.WA_NEW_MESSAGE, {
              ...msg,
              chatName: chat?.name || snapshot?.displayNameCandidate || '',
              chatPhone: snapshot?.phoneCandidate || chat?.phone || '',
              isGroup: snapshot?.isGroup || chat?.isGroup || false,
              // 可信 JID/LID 信息,供后端 IdentityResolutionService 关联 contactPointId
              // snapshot 识别失败时回退到 getCurrentChatInfo 的 externalId(多策略兜底)
              externalId: snapshot?.externalId || chat?.externalId || '',
              externalIdKind: snapshot?.externalIdKind || 'unknown',
              phoneCandidate: snapshot?.phoneCandidate || null,
              displayNameCandidate: snapshot?.displayNameCandidate || null,
              isSelf: snapshot?.isSelf || false,
            });
          }
        }
      }
    }
  });
  msgObserver.observe(document.body, { childList: true, subtree: true });
}

// ════════════════════════════════════════════════════════════
// 初始化
// ════════════════════════════════════════════════════════════

function init() {
  injectCSS();
  // v1.4.35: 已禁用 AIPanel 5-tab 侧栏（AI回复/翻译/客户分析/知识库/接待草稿）。
  // 用户确认该侧栏为多余，CRM 客户分析统一走前端 CustomerCard（phone-frame 结构）。
  // AIPanel.init();
  MessageTranslator.init();

  // ── 消息监听 ──
  initMessageObserver();

  // ── 登录状态检查 ──
  let lastStatus = '';
  const checkStatus = () => {
    const s = checkLoginStatus();
    if (s !== lastStatus && s !== 'unknown') {
      lastStatus = s;
      ipcRenderer.send(IPC_CHANNELS.WA_LOGIN_STATUS, { status: s, timestamp: Date.now() });
    }
  };
  setTimeout(checkStatus, 3000);
  setInterval(checkStatus, LOGIN_CHECK_INTERVAL);

  // ── 未读消息计数 ──
  setInterval(() => {
    const unread = getUnreadCount();
    if (unread > 0) {
      ipcRenderer.send(IPC_CHANNELS.WA_LOGIN_STATUS, {
        status: 'unread_update',
        count: unread,
        timestamp: Date.now(),
      });
    }
  }, UNREAD_COUNT_INTERVAL);

  // ── 断线重连 ──
  initReconnectMonitor();

  // ── 联系人同步 ──
  setTimeout(syncContacts, 8000);
  setInterval(syncContacts, CONTACT_SYNC_INTERVAL);

  // ── 当前聊天变化检测（五重保险）──
  let lastChatKey = '';
  let lastUrl = location.href;

  const checkChat = (reason?: string, force = false) => {
    const chat = getCurrentChatInfo();
    if (chat) {
      const key = chat.phone || chat.name;
      if (key && (force || key !== lastChatKey)) {
        lastChatKey = key;
        console.log(`[WA] 聊天切换(${reason || 'unknown'}): name="${chat.name}", phone="${chat.phone}", group=${chat.isGroup}`);
        ipcRenderer.send(IPC_CHANNELS.WA_CURRENT_CHAT, chat);
      }
    }
  };

  // 前端页面可能在 init-1s/init-2s/init-4s 广播之后才订阅。
  // 收到显式请求时即使聊天键未变化也必须重发，修复右侧客户栏一直等待的问题。
  ipcRenderer.on(IPC_CHANNELS.WA_REQUEST_CURRENT_CHAT, () => {
    checkChat('renderer-request', true);
  });

  // 1. hashchange / popstate
  window.addEventListener('hashchange', () => { setTimeout(() => checkChat('hashchange'), 500); });
  window.addEventListener('popstate', () => { setTimeout(() => checkChat('popstate'), 500); });

  // 2. URL 变化轮询（WhatsApp 新版可能用 History API）
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      setTimeout(() => checkChat('url-change'), 600);
    }
  }, 800);

  // 3. MutationObserver 监听 header 和 pane-side
  const setupObserver = () => {
    const targets = [
      document.querySelector('#main header'),
      document.querySelector('#pane-side'),
      document.querySelector('[data-testid="chat-list"]'),
    ];
    const observer = new MutationObserver(() => { checkChat('mutation'); });
    for (const t of targets) {
      if (t) observer.observe(t, { childList: true, subtree: true, attributes: true, attributeFilter: ['title', 'aria-selected', 'class', 'data-id'] });
    }
    // 监听 body 子树变化（SPA 导航时 DOM 可能重建）
    const bodyObserver = new MutationObserver(() => {
      // 节流：避免频繁触发
      setTimeout(() => checkChat('body-mutation'), 300);
    });
    bodyObserver.observe(document.body, { childList: true, subtree: false });
  };
  setTimeout(setupObserver, 2000);

  // 4. 全局点击监听 — 最可靠的用户交互信号
  document.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    // 判断点击是否发生在聊天列表项内
    const listItem = target.closest('[role="listitem"]') || target.closest('#pane-side') || target.closest('[data-testid="chat-list"]');
    if (listItem) {
      // 延迟检查，等 DOM 更新完成
      setTimeout(() => checkChat('click-listitem'), 400);
      setTimeout(() => checkChat('click-listitem-delayed'), 1000);
    }
    // 点击 header 中的联系人信息也可能触发
    const header = target.closest('header');
    if (header) {
      setTimeout(() => checkChat('click-header'), 500);
    }
  }, true);

  // 5. 定时轮询（兜底）
  setInterval(() => checkChat('polling'), CHAT_CHECK_INTERVAL);

  // 首次检查（多次延迟确保 DOM 就绪）
  setTimeout(() => checkChat('init-1s'), 1000);
  setTimeout(() => checkChat('init-2s'), 2000);
  setTimeout(() => checkChat('init-4s'), 4000);

  console.log('[WA Preload] v3.0 已加载 — AI 面板已注入');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
