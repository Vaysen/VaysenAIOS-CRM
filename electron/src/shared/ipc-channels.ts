/**
 * IPC 通信频道定义 v2.0
 * 所有主进程与渲染进程之间的通信都通过这些频道进行
 */

export const IPC_CHANNELS = {
  // === API 请求 ===
  API_REQUEST: 'api:request',
  API_RESPONSE: 'api:response',
  API_ERROR: 'api:error',

  // === 认证管理 ===
  AUTH_GET_TOKEN: 'auth:get-token',
  AUTH_SET_TOKEN: 'auth:set-token',
  AUTH_CLEAR_TOKEN: 'auth:clear-token',
  AUTH_REFRESH_SESSION: 'auth:refresh-session',
  AUTH_LOGOUT_SESSION: 'auth:logout-session',
  AUTH_GET_COMPANY: 'auth:get-company',
  AUTH_SET_COMPANY: 'auth:set-company',

  // === WhatsApp Web 消息 ===
  WA_NEW_MESSAGE: 'wa:new-message',         // Preload → 主进程：新消息（含文本/图片/文件/音频/视频）
  WA_SEND_TEXT: 'wa:send-text',             // 渲染进程 → 主进程：发送文本
  WA_SEND_RESULT: 'wa:send-result',         // 主进程 → 渲染进程：发送结果
  WA_SEND_DOCUMENT: 'wa:send-document',     // 兼容旧调用，但主进程永久拒绝自动发送
  QUOTE_FILE_PREPARE: 'quote-file:prepare',
  QUOTE_FILE_START_DRAG: 'quote-file:start-drag',
  QUOTE_FILE_OPEN_FOLDER: 'quote-file:open-folder',
  WA_LOGIN_STATUS: 'wa:login-status',       // Preload → 主进程：登录状态/选择器告警/未读计数/断线重连
  WA_CONTACTS_SYNC: 'wa:contacts-sync',     // Preload → 主进程：联系人列表同步
  WA_INJECT_TEXT: 'wa:inject-text',         // 主进程 → Preload：注入文本到输入框
  WA_CURRENT_CHAT: 'wa:current-chat',       // Preload → 主进程：当前打开的聊天
  WA_REQUEST_CURRENT_CHAT: 'wa:request-current-chat', // 渲染进程 → 主进程 → WhatsApp Preload：主动重发当前聊天
  WA_FILL_DRAFT: 'wa:fill-draft',
  WA_FILL_DRAFT_RESULT: 'wa:fill-draft-result',
  WA_SEND_AUTHORIZED: 'wa:send-authorized',
  WA_SEND_AUTHORIZED_RESULT: 'wa:send-authorized-result',

  // === WhatsApp 多账号 ===
  WA_CREATE_ACCOUNT: 'wa:create-account',   // 渲染进程 → 主进程：创建新账号视图
  WA_SWITCH_ACCOUNT: 'wa:switch-account',   // 渲染进程 → 主进程：切换活跃账号
  WA_REMOVE_ACCOUNT: 'wa:remove-account',   // 渲染进程 → 主进程：移除账号
  WA_LIST_ACCOUNTS: 'wa:list-accounts',     // 渲染进程 → 主进程：获取账号列表
  WA_ACCOUNT_SWITCHED: 'wa:account-switched',// 主进程 → 渲染进程：账号已切换

  // === WhatsApp 视图布局控制 ===
  WA_SHOW_VIEW: 'wa:show-view',     // 渲染进程 → 主进程：显示 WhatsApp 视图（进入聊天页）
  WA_HIDE_VIEW: 'wa:hide-view',     // 渲染进程 → 主进程：隐藏 WhatsApp 视图（离开聊天页）
  WA_SET_LAYOUT: 'wa:set-layout',   // 渲染进程 → 主进程：设置布局参数（左栏宽、右栏宽、顶部偏移）
  WA_SET_OVERLAY_WIDTH: 'wa:set-overlay-width',

  // === 运行时配置（首次配置页 / 解耦局域网地址）===
  APP_CONFIG_GET: 'app:config-get',   // 渲染进程 → 主进程：读取运行时配置（API/更新地址）
  APP_CONFIG_SET: 'app:config-set',   // 渲染进程 → 主进程：写入运行时配置
  APP_CHECK_CONNECTION: 'app:check-connection', // 渲染进程 → 主进程：探测候选 LAN 后端
  APP_NEED_RESTART: 'app:need-restart', // 主进程 → 渲染进程：配置已变更，需要重启（axios 在模块加载时固化）
  APP_CONFIG_INVALID: 'app:config-invalid', // 主进程 → 渲染进程：env/持久化配置非法，引导进入配置页（v1.2b 红线 #5）

  // === WhatsApp Preload ↔ 主进程 API 代理（wa-preload 专用）===
  WA_API_REQUEST: 'wa:api-request',       // wa-preload → 主进程：代理 API 请求
  WA_API_RESPONSE: 'wa:api-response',     // 主进程 → wa-preload：API 响应

  // === AI 功能 ===
  AI_SUGGESTION: 'ai:suggestion',           // 渲染进程 → 主进程：请求 AI 建议
  AI_TRANSLATE: 'ai:translate',             // 渲染进程 → 主进程：请求翻译
  AI_RESULT: 'ai:result',                   // 主进程 → 渲染进程：AI 结果

  // === AI 业务助理桌面桥（仅人工确认的报价文件准备；绝不自动点击发送） ===
  AGENT_DESKTOP_CAPABILITIES: 'agent:desktop-capabilities',
  AGENT_DESKTOP_HEARTBEAT: 'agent:desktop-heartbeat',
  AGENT_PREPARE_QUOTE_DELIVERY: 'agent:prepare-quote-delivery',
  AGENT_SEND_WHATSAPP_TEXT: 'agent:send-whatsapp-text',

  // === 窗口管理 ===
  WINDOW_MINIMIZE: 'window:minimize',
  WINDOW_MAXIMIZE: 'window:maximize',
  WINDOW_CLOSE: 'window:close',
  WINDOW_IS_MAXIMIZED: 'window:is-maximized',

  // === 系统 ===
  APP_VERSION: 'app:version',
  APP_CHECK_UPDATE: 'app:check-update',
  APP_DOWNLOAD_UPDATE: 'app:download-update',
  APP_INSTALL_UPDATE: 'app:install-update',
  APP_UPDATE_STATUS: 'app:update-status',
  APP_ONLINE_STATUS: 'app:online-status',
} as const;

export type IpcChannel = typeof IPC_CHANNELS[keyof typeof IPC_CHANNELS];
