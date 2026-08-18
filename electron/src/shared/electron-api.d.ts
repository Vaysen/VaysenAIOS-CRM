/**
 * Electron API 类型声明 v2.0
 * 供前端 TypeScript 使用 window.electronAPI
 */

import type { WhatsAppContactSnapshot } from './whatsapp-contact-types';
import type {
  AgentDesktopCapabilitySnapshot,
  AgentDesktopHeartbeat,
  AgentQuoteDeliveryRequest,
  AgentQuoteDeliveryResult,
} from './agent-bridge-types';

export interface ElectronAPI {
  // API 请求
  apiRequest: (config: {
    method?: string;
    url: string;
    data?: any;
    params?: any;
    headers?: Record<string, string>;
    timeout?: number;
  }) => Promise<{ success: boolean; data?: any; status?: number; message?: string }>;

  // 认证
  auth: {
    getToken: () => Promise<string | null>;
    setToken: (token: string, refreshToken: string) => Promise<void>;
    clearToken: () => Promise<void>;
    refreshSession: () => Promise<{ accessToken: string }>;
    logoutSession: () => Promise<void>;
    getCompany: () => Promise<string | null>;
    setCompany: (companyId: string) => Promise<void>;
  };

  // WhatsApp
  whatsapp: {
    onNewMessage: (callback: (message: any) => void) => () => void;
    onLoginStatus: (callback: (status: any) => void) => () => void;
    /**
     * 联系人同步载荷 (TASK-102D)。
     * contacts 为 WhatsAppContactSnapshot[] — 仅含可信 JID/LID/号码候选,
     * 群组/self/系统文案伪联系人已在 preload 侧过滤。
     */
    onContactsSync: (callback: (payload: {
      contacts: WhatsAppContactSnapshot[];
      accountId?: string;
      timestamp?: number;
      total?: number;
    }) => void) => () => void;
    onCurrentChat: (callback: (chatInfo: any) => void) => () => void;
    requestCurrentChat: () => Promise<{
      requested: boolean;
      chat: { accountId: string; name: string; phone: string; isGroup: boolean; externalId?: string; observedAt: string; selectionProof: string } | null;
    }>;
    onAccountSwitched: (callback: (data: { accountId: string; label: string }) => void) => () => void;
    sendText: (chatId: string, text: string) => Promise<{ success: boolean; error?: string }>;
    fillDraft: (request: {
      text: string;
      targetPhone: string;
      targetName: string;
      targetAccountId?: string;
      selectionProof: string;
    }) => Promise<{ success: boolean; error?: string }>;
    onInjectText: (callback: (data: { chatId: string; text: string }) => void) => () => void;
    onSendResult: (callback: (result: any) => void) => () => void;
    // 多账号管理
    createAccount: (accountId: string, label: string) => Promise<{ success: boolean; accountId: string }>;
    switchAccount: (accountId: string) => Promise<{ success: boolean }>;
    removeAccount: (accountId: string) => Promise<{ success: boolean }>;
    listAccounts: () => Promise<Array<{ id: string; label: string; isActive: boolean }>>;
    // 视图布局控制
    showView: (layout?: { leftNavWidth?: number; chatListWidth?: number; rightPanelWidth?: number; topOffset?: number; bottomOffset?: number }) => void;
    hideView: () => void;
    setLayout: (config: { leftNavWidth?: number; chatListWidth?: number; rightPanelWidth?: number; topOffset?: number; bottomOffset?: number }) => void;
    setOverlayWidth: (width: number) => void;
    // 获取当前聊天的最近消息
    getRecentMessages: (maxCount?: number) => Promise<Array<{ text: string; isOutgoing: boolean; time: string }>>;
  };

  quoteFiles: {
    prepare: (quoteId: string, filename: string) => Promise<{
      success: boolean;
      data?: { preparedFileId: string; quoteId: string; filename: string; size: number; sha256: string };
      error?: string;
    }>;
    startDrag: (preparedFileId: string) => Promise<{ success: boolean; error?: string }>;
    openFolder: (preparedFileId: string) => Promise<{ success: boolean; error?: string }>;
  };

  // 窗口控制
  window: {
    minimize: () => void;
    maximizeToggle: () => void;
    close: () => void;
    isMaximized: () => Promise<boolean>;
  };

  // 应用信息
  app: {
    getVersion: () => Promise<string>;
    onOnlineStatus: (callback: (isOnline: boolean) => void) => () => void;
    // 运行时配置（TASK-111 v1.2b）
    configGet: () => Promise<{
      valid: boolean;
      config: { apiBaseUrl: string; updateFeedUrl: string };
      errors: Array<{ field: 'apiBaseUrl' | 'updateFeedUrl'; value: string; reason: string }>;
    }>;
    configSet: (config: { apiBaseUrl?: string; updateFeedUrl?: string }) =>
      Promise<{ success: boolean; config?: { apiBaseUrl: string; updateFeedUrl: string }; error?: string }>;
    checkConnection: (apiBaseUrl: string) => Promise<import('./connection-check').ConnectionCheckResult>;
    onNeedRestart: (callback: (payload: { reason: string; next?: { apiBaseUrl: string; updateFeedUrl: string } }) => void) => () => void;
    onConfigInvalid: (callback: (payload: { field: 'apiBaseUrl' | 'updateFeedUrl'; reason: string }) => void) => () => void;
    checkUpdate: () => Promise<{ success: boolean; error?: string }>;
    downloadUpdate: () => Promise<{ success: boolean; error?: string }>;
    installUpdate: () => Promise<void>;
    onUpdateStatus: (callback: (status: any) => void) => () => void;
  };

  // API 错误监听
  onApiError: (callback: (error: any) => void) => () => void;

  // AI 功能
  ai: {
    suggestReplies: (messageId: string, targetLanguage?: string) => Promise<{ success: boolean; data?: any; error?: string }>;
    translate: (text: string, targetLanguage?: string) => Promise<{ success: boolean; data?: any; error?: string }>;
  };

  /** AI 业务助理桌面桥：仅允许人工确认后准备报价 PDF，不自动发送。 */
  agentBridge: {
    getCapabilities: () => Promise<AgentDesktopCapabilitySnapshot>;
    getHeartbeat: () => Promise<AgentDesktopHeartbeat>;
    prepareQuoteDelivery: (
      request: AgentQuoteDeliveryRequest,
    ) => Promise<AgentQuoteDeliveryResult>;
    sendWhatsappText: (request: {
      conversationId: string;
      targetPhone: string;
      targetName: string;
      targetAccountId: string;
      selectionProof: string;
      text: string;
    }) => Promise<{
      success: boolean;
      actionId?: string;
      warning?: string;
      error?: string;
    }>;
  };
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
