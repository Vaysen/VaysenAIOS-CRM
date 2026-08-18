'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * ElectronAPI 类型声明（内联）
 *
 * 镜像 electron/src/shared/electron-api.d.ts 的结构。前端项目无法直接引用
 * electron 子包下的类型文件，因此在此内联声明，保证 `window.electronAPI`
 * 的类型安全访问。
 */
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
    onContactsSync: (callback: (contacts: any) => void) => () => void;
    onCurrentChat: (callback: (chatInfo: any) => void) => () => void;
    requestCurrentChat: () => Promise<{
      requested: boolean;
      chat?: { accountId: string; name: string; phone: string; isGroup: boolean; externalId?: string; observedAt: string; selectionProof: string } | null;
    }>;
    onAccountSwitched: (
      callback: (data: { accountId: string; label: string }) => void,
    ) => () => void;
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
    createAccount: (
      accountId: string,
      label: string,
    ) => Promise<{ success: boolean; accountId: string }>;
    switchAccount: (accountId: string) => Promise<{ success: boolean }>;
    removeAccount: (accountId: string) => Promise<{ success: boolean }>;
    listAccounts: () => Promise<
      Array<{ id: string; label: string; isActive: boolean }>
    >;
    // 视图布局控制
    showView: (layout?: { leftNavWidth?: number; chatListWidth?: number; rightPanelWidth?: number; topOffset?: number; bottomOffset?: number }) => void;
    hideView: () => void;
    setLayout: (config: { leftNavWidth?: number; chatListWidth?: number; rightPanelWidth?: number; topOffset?: number; bottomOffset?: number }) => void;
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

  agentBridge: {
    getCapabilities: () => Promise<unknown>;
    getHeartbeat: () => Promise<unknown>;
    prepareQuoteDelivery: (request: {
      proposalId: string;
    }) => Promise<{
      success: boolean;
      data?: {
        preparedFileId: string;
        quoteId: string;
        filename: string;
        size: number;
        sha256: string;
        targetPhone: string;
      };
      error?: string;
    }>;
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
    configGet: () => Promise<{
      valid: boolean;
      config: { apiBaseUrl: string; updateFeedUrl: string };
      errors: Array<{ field: 'apiBaseUrl' | 'updateFeedUrl'; value: string; reason: string }>;
    }>;
    configSet: (config: { apiBaseUrl?: string; updateFeedUrl?: string }) => Promise<{
      success: boolean;
      config?: { apiBaseUrl: string; updateFeedUrl: string };
      error?: string;
    }>;
    checkConnection: (apiBaseUrl: string) => Promise<{
      ok: boolean;
      code: 'ok' | 'not_configured' | 'invalid_url' | 'dns' | 'timeout' | 'http_status' | 'version_mismatch' | 'invalid_response' | 'unreachable' | 'network_error';
      url: string;
      status?: number;
      latencyMs?: number;
      message: string;
      serverVersion?: string;
      release?: { tag?: string; commit?: string };
    }>;
    onNeedRestart: (callback: (payload: { reason: string; next?: { apiBaseUrl: string; updateFeedUrl: string } }) => void) => () => void;
  };

  // API 错误监听
  onApiError: (callback: (error: any) => void) => () => void;
}

/** WhatsApp 连接状态 */
export type WhatsAppLoginStatus = 'waiting_scan' | 'logged_in' | 'unknown';

/** API 错误信息（含 401 未授权等） */
export interface ApiErrorInfo {
  status?: number;
  message?: string;
  [key: string]: any;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

/** 安全地获取 window.electronAPI，兼容 SSR 环境 */
function getElectronAPI(): ElectronAPI | null {
  if (typeof window === 'undefined') return null;
  return window.electronAPI ?? null;
}

/** 将 WhatsApp 登录状态事件归一化为三种已知状态 */
function normalizeWhatsAppStatus(raw: any): WhatsAppLoginStatus {
  if (raw == null) return 'unknown';

  if (typeof raw === 'string') {
    const value = raw.toLowerCase();
    if (
      ['logged_in', 'loggedin', 'logged', 'connected', 'authenticated', 'ready'].some((k) =>
        value.includes(k),
      )
    ) {
      return 'logged_in';
    }
    if (['waiting_scan', 'scan', 'qr', 'waiting', 'pending'].some((k) => value.includes(k))) {
      return 'waiting_scan';
    }
    return 'unknown';
  }

  if (typeof raw === 'object') {
    if (raw.isLoggedIn === true || raw.logged_in === true || raw.isAuthenticated === true) {
      return 'logged_in';
    }
    if (raw.isLoggedIn === false || raw.logged_in === false) {
      return 'waiting_scan';
    }
    if (raw.qr || raw.qrCode || raw.qrcode) {
      return 'waiting_scan';
    }
    const inner = raw.status ?? raw.state ?? raw.type;
    if (inner != null) {
      return normalizeWhatsAppStatus(inner);
    }
  }

  return 'unknown';
}

export interface UseElectronResult {
  /** 是否运行在 Electron 桌面环境中 */
  isElectron: boolean;
  /** 类型安全的 electronAPI 访问（非 Electron 环境为 null） */
  api: ElectronAPI | null;
  /** 当前是否在线 */
  isOnline: boolean;
  /** WhatsApp 连接状态 */
  whatsappStatus: WhatsAppLoginStatus;
  /** 最近一次 API 错误 */
  apiError: ApiErrorInfo | null;
  /** 是否触发 401 未授权错误 */
  isUnauthorized: boolean;
  /** 应用版本号 */
  appVersion: string;
  /** 订阅 WhatsApp 新消息事件，返回取消订阅函数 */
  onWhatsappNewMessage: (callback: (message: any) => void) => () => void;
  /** 订阅 WhatsApp 联系人同步事件，返回取消订阅函数 */
  onWhatsappContactsSync: (callback: (contacts: any) => void) => () => void;
  /** 订阅 WhatsApp 当前聊天变化事件，返回取消订阅函数 */
  onWhatsappCurrentChat: (callback: (chatInfo: any) => void) => () => void;
  /** 订阅 WhatsApp 活跃账号切换事件，返回取消订阅函数 */
  onWhatsappAccountSwitched: (
    callback: (data: { accountId: string; label: string }) => void,
  ) => () => void;
}

const noopUnsubscribe = (): void => {};

export function useElectron(): UseElectronResult {
  const [isElectron, setIsElectron] = useState(false);
  const [api, setApi] = useState<ElectronAPI | null>(null);
  const [isOnline, setIsOnline] = useState(true);
  const [whatsappStatus, setWhatsappStatus] = useState<WhatsAppLoginStatus>('unknown');
  const [apiError, setApiError] = useState<ApiErrorInfo | null>(null);
  const [appVersion, setAppVersion] = useState('');

  // 始终保持最新的 electronAPI 引用，供稳定的订阅函数使用
  const apiRef = useRef<ElectronAPI | null>(null);

  useEffect(() => {
    const electronAPI = getElectronAPI();
    apiRef.current = electronAPI;
    setApi(electronAPI);
    setIsElectron(!!electronAPI);

    if (!electronAPI) return;

    // 在线/离线状态：Electron 主进程推送 + 浏览器原生事件双重监听
    setIsOnline(typeof navigator !== 'undefined' ? navigator.onLine : true);
    const unsubscribeOnline = electronAPI.app.onOnlineStatus((online) => setIsOnline(online));
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    // API 错误监听（含 401 未授权）
    const unsubscribeApiError = electronAPI.onApiError((error: any) => {
      setApiError(error ?? null);
    });

    // WhatsApp 登录状态变化
    const unsubscribeLogin = electronAPI.whatsapp.onLoginStatus((status: any) => {
      setWhatsappStatus(normalizeWhatsAppStatus(status));
    });

    // 应用版本号
    electronAPI.app
      .getVersion()
      .then((version) => setAppVersion(version))
      .catch((error) => { console.error('[Frontend] background operation failed:', error); });

    return () => {
      unsubscribeOnline?.();
      unsubscribeApiError?.();
      unsubscribeLogin?.();
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const onWhatsappNewMessage = useCallback((callback: (message: any) => void) => {
    const current = apiRef.current;
    if (!current) return noopUnsubscribe;
    return current.whatsapp.onNewMessage(callback);
  }, []);

  const onWhatsappContactsSync = useCallback((callback: (contacts: any) => void) => {
    const current = apiRef.current;
    if (!current) return noopUnsubscribe;
    return current.whatsapp.onContactsSync(callback);
  }, []);

  const onWhatsappCurrentChat = useCallback((callback: (chatInfo: any) => void) => {
    const current = apiRef.current;
    if (!current) return noopUnsubscribe;
    return current.whatsapp.onCurrentChat(callback);
  }, []);

  const onWhatsappAccountSwitched = useCallback(
    (callback: (data: { accountId: string; label: string }) => void) => {
      const current = apiRef.current;
      if (!current) return noopUnsubscribe;
      return current.whatsapp.onAccountSwitched(callback);
    },
    [],
  );

  return {
    isElectron,
    api,
    isOnline,
    whatsappStatus,
    apiError,
    isUnauthorized: apiError?.status === 401,
    appVersion,
    onWhatsappNewMessage,
    onWhatsappContactsSync,
    onWhatsappCurrentChat,
    onWhatsappAccountSwitched,
  };
}
