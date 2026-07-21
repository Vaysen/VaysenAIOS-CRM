/**
 * 应用渲染进程 Preload 脚本 v2.0
 * 暴露安全的 IPC 接口给前端使用
 * 通过 contextBridge 隔离，防止前端直接访问 Node.js API
 */

import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../shared/ipc-channels';
import type {
  AgentQuoteDeliveryRequest,
  AgentWhatsappTextSendRequest,
} from '../shared/agent-bridge-types';

const appPreload = {
  // === API 请求 ===
  apiRequest: (config: {
    method?: string;
    url: string;
    data?: any;
    params?: any;
    headers?: Record<string, string>;
    timeout?: number;
  }) => ipcRenderer.invoke(IPC_CHANNELS.API_REQUEST, config),

  // === 认证 ===
  auth: {
    getToken: () => ipcRenderer.invoke(IPC_CHANNELS.AUTH_GET_TOKEN),
    setToken: (token: string, refreshToken: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.AUTH_SET_TOKEN, { token, refreshToken }),
    clearToken: () => ipcRenderer.invoke(IPC_CHANNELS.AUTH_CLEAR_TOKEN),
    getCompany: () => ipcRenderer.invoke(IPC_CHANNELS.AUTH_GET_COMPANY),
    setCompany: (companyId: string) => ipcRenderer.invoke(IPC_CHANNELS.AUTH_SET_COMPANY, companyId),
  },

  // === WhatsApp 消息监听 + 多账号管理 ===
  whatsapp: {
    // 监听新消息（含文本/图片/文件/音频/视频，附带 accountId）
    onNewMessage: (callback: (message: any) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.WA_NEW_MESSAGE, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.WA_NEW_MESSAGE, handler);
    },
    // 监听登录状态变化（含 selector_warning / unread_update / reconnecting）
    onLoginStatus: (callback: (status: any) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.WA_LOGIN_STATUS, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.WA_LOGIN_STATUS, handler);
    },
    // 监听联系人同步
    onContactsSync: (callback: (contacts: any) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.WA_CONTACTS_SYNC, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.WA_CONTACTS_SYNC, handler);
    },
    // 监听当前聊天变化
    onCurrentChat: (callback: (chatInfo: any) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.WA_CURRENT_CHAT, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.WA_CURRENT_CHAT, handler);
    },
    // 页面订阅可能晚于 WhatsApp 首次识别事件；主动要求 preload 重发当前聊天。
    requestCurrentChat: () => ipcRenderer.invoke(IPC_CHANNELS.WA_REQUEST_CURRENT_CHAT),
    // 监听账号切换
    onAccountSwitched: (callback: (data: { accountId: string; label: string }) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.WA_ACCOUNT_SWITCHED, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.WA_ACCOUNT_SWITCHED, handler);
    },
    // 发送文本消息
    sendText: (chatId: string, text: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.WA_SEND_TEXT, { chatId, text }),
    fillDraft: (request: {
      text: string;
      targetPhone: string;
      targetName: string;
      targetAccountId?: string;
      selectionProof: string;
    }) =>
      ipcRenderer.invoke(IPC_CHANNELS.WA_FILL_DRAFT, request),
    // 监听文本注入请求
    onInjectText: (callback: (data: { chatId: string; text: string }) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.WA_INJECT_TEXT, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.WA_INJECT_TEXT, handler);
    },
    // 监听发送结果
    onSendResult: (callback: (result: any) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.WA_SEND_RESULT, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.WA_SEND_RESULT, handler);
    },

    // === 多账号管理 ===
    createAccount: (accountId: string, label: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.WA_CREATE_ACCOUNT, { accountId, label }),
    switchAccount: (accountId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.WA_SWITCH_ACCOUNT, { accountId }),
    removeAccount: (accountId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.WA_REMOVE_ACCOUNT, { accountId }),
    listAccounts: () =>
      ipcRenderer.invoke(IPC_CHANNELS.WA_LIST_ACCOUNTS),

    // 视图布局控制
    showView: (layout?: { leftNavWidth?: number; chatListWidth?: number; rightPanelWidth?: number; topOffset?: number; bottomOffset?: number }) =>
      ipcRenderer.send(IPC_CHANNELS.WA_SHOW_VIEW, layout),
    hideView: () =>
      ipcRenderer.send(IPC_CHANNELS.WA_HIDE_VIEW),
    setLayout: (config: { leftNavWidth?: number; chatListWidth?: number; rightPanelWidth?: number; topOffset?: number; bottomOffset?: number }) =>
      ipcRenderer.send(IPC_CHANNELS.WA_SET_LAYOUT, config),
    setOverlayWidth: (width: number) =>
      ipcRenderer.send(IPC_CHANNELS.WA_SET_OVERLAY_WIDTH, width),

    // 获取当前聊天的最近消息
    getRecentMessages: (maxCount?: number) =>
      ipcRenderer.invoke('wa:get-recent-messages', maxCount),
  },

  quoteFiles: {
    prepare: (quoteId: string, filename: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.QUOTE_FILE_PREPARE, { quoteId, filename }),
    startDrag: (preparedFileId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.QUOTE_FILE_START_DRAG, { preparedFileId }),
    openFolder: (preparedFileId: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.QUOTE_FILE_OPEN_FOLDER, { preparedFileId }),
  },

  // === 窗口控制 ===
  window: {
    minimize: () => ipcRenderer.send(IPC_CHANNELS.WINDOW_MINIMIZE),
    maximizeToggle: () => ipcRenderer.send(IPC_CHANNELS.WINDOW_MAXIMIZE),
    close: () => ipcRenderer.send(IPC_CHANNELS.WINDOW_CLOSE),
    isMaximized: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_IS_MAXIMIZED),
  },

  // === 应用信息 ===
  app: {
    getVersion: () => ipcRenderer.invoke(IPC_CHANNELS.APP_VERSION),
    onOnlineStatus: (callback: (isOnline: boolean) => void) => {
      const handler = (_event: any, data: boolean) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.APP_ONLINE_STATUS, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.APP_ONLINE_STATUS, handler);
    },
    // 运行时配置（TASK-111 v1.1 红线 2 修复）
    // 渲染层首次配置页可调用：configGet 读当前值；configSet 写新值
    //   （返回 { success: true|false, error? }；私网需精确 allowlist，本机永远拒绝）
    // 配置保存后 onNeedRestart 会触发，渲染层应提示用户重启应用
    //   （axios 实例与 electron-updater 在模块加载时固化，必须重启才生效）
    configGet: (): Promise<{
      valid: boolean;
      config: { apiBaseUrl: string; updateFeedUrl: string };
      errors: Array<{ field: 'apiBaseUrl' | 'updateFeedUrl'; value: string; reason: string }>;
    }> =>
      ipcRenderer.invoke(IPC_CHANNELS.APP_CONFIG_GET),
    configSet: (config: { apiBaseUrl?: string; updateFeedUrl?: string }): Promise<{ success: boolean; config?: { apiBaseUrl: string; updateFeedUrl: string }; error?: string }> =>
      ipcRenderer.invoke(IPC_CHANNELS.APP_CONFIG_SET, config),
    onNeedRestart: (callback: (payload: { reason: string; next?: { apiBaseUrl: string; updateFeedUrl: string } }) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.APP_NEED_RESTART, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.APP_NEED_RESTART, handler);
    },
    // v1.2b 红线 #5：env/持久化配置非法时，主进程广播此事件，渲染层应引导
    // 用户进入配置页（API 请求拒绝发出；更新器禁用）。
    onConfigInvalid: (callback: (payload: { field: 'apiBaseUrl' | 'updateFeedUrl'; reason: string }) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.APP_CONFIG_INVALID, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.APP_CONFIG_INVALID, handler);
    },
    // 自动更新
    checkUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.APP_CHECK_UPDATE),
    downloadUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.APP_DOWNLOAD_UPDATE),
    installUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.APP_INSTALL_UPDATE),
    onUpdateStatus: (callback: (status: any) => void) => {
      const handler = (_event: any, data: any) => callback(data);
      ipcRenderer.on(IPC_CHANNELS.APP_UPDATE_STATUS, handler);
      return () => ipcRenderer.removeListener(IPC_CHANNELS.APP_UPDATE_STATUS, handler);
    },
  },

  // === API 错误监听 ===
  onApiError: (callback: (error: any) => void) => {
    const handler = (_event: any, data: any) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.API_ERROR, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.API_ERROR, handler);
  },

  // === AI 功能 ===
  ai: {
    suggestReplies: (messageId: string, targetLanguage?: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.AI_SUGGESTION, { messageId, targetLanguage }),
    translate: (text: string, targetLanguage?: string) =>
      ipcRenderer.invoke(IPC_CHANNELS.AI_TRANSLATE, { text, targetLanguage }),
  },

  // === AI 业务助理桌面桥（人工确认、只准备文件、不自动发送） ===
  agentBridge: {
    getCapabilities: () =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_DESKTOP_CAPABILITIES),
    getHeartbeat: () =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_DESKTOP_HEARTBEAT),
    prepareQuoteDelivery: (request: AgentQuoteDeliveryRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_PREPARE_QUOTE_DELIVERY, request),
    sendWhatsappText: (request: AgentWhatsappTextSendRequest) =>
      ipcRenderer.invoke(IPC_CHANNELS.AGENT_SEND_WHATSAPP_TEXT, request),
  },
};

// 通过 contextBridge 暴露给前端
contextBridge.exposeInMainWorld('electronAPI', appPreload);

// 类型声明（供前端 TypeScript 使用）
export type AppPreload = typeof appPreload;
