/**
 * 窗口管理器 v2.0
 *
 * 新增功能：
 * - 多账号支持（多个 WebContentsView + 不同 partition）
 * - 活跃账号切换
 * - 每个账号独立的消息处理
 */

import { BrowserWindow, WebContentsView } from 'electron';
import path from 'path';
import Store from 'electron-store';
import { registerNavigationGuards } from './navigation-policy';

interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  isMaximized: boolean;
}

const DEFAULT_BOUNDS: WindowBounds = {
  x: -1,
  y: -1,
  width: 1440,
  height: 900,
  isMaximized: false,
};

const MIN_WIDTH = 1280;
const MIN_HEIGHT = 720;

// 三栏布局默认尺寸
const DEFAULT_LEFT_NAV_WIDTH = 220;
const DEFAULT_RIGHT_PANEL_WIDTH = 360;

// 动态布局参数
interface LayoutConfig {
  leftNavWidth: number;     // 侧边栏宽度
  chatListWidth: number;    // 聊天页左栏联系人列表宽度
  rightPanelWidth: number;  // 右侧 AI 面板宽度
  topOffset: number;        // 顶部偏移（标题栏高度）
  bottomOffset: number;     // 底部偏移（状态栏高度）
  whatsappVisible: boolean; // WhatsApp 视图是否可见
}

const DEFAULT_LAYOUT: LayoutConfig = {
  leftNavWidth: 240,       // 侧边栏展开宽度
  chatListWidth: 280,      // 聊天页联系人列表
  rightPanelWidth: 360,    // AI 面板
  topOffset: 64,           // Header 高度
  bottomOffset: 40,        // 状态栏高度
  whatsappVisible: false,  // 默认隐藏
};

interface WhatsappAccount {
  id: string;
  label: string;
  view: WebContentsView;
  partition: string;
  isActive: boolean;
}

export class WindowManager {
  private store = new Store<WindowBounds>({
    name: 'window-bounds',
    defaults: DEFAULT_BOUNDS,
  });

  private mainWindow: BrowserWindow | null = null;
  private whatsappAccounts: Map<string, WhatsappAccount> = new Map();
  private activeAccountId: string | null = null;
  private layout: LayoutConfig = { ...DEFAULT_LAYOUT };
  private rendererOverlayWidth = 0;

  /**
   * 创建主窗口
   */
  createMainWindow(url: string, isDev: boolean): BrowserWindow {
    const bounds = this.store.store;

    const windowOptions: Electron.BrowserWindowConstructorOptions = {
      width: bounds.width,
      height: bounds.height,
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      x: bounds.x >= 0 ? bounds.x : undefined,
      y: bounds.y >= 0 ? bounds.y : undefined,
      show: false,
      title: 'Vaysen 外贸系统',
      backgroundColor: '#0f172a',
      frame: true, // 使用系统标题栏（可改为 false 启用自定义标题栏）
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'app-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    };

    this.mainWindow = new BrowserWindow(windowOptions);
    const mainOrigins = new Set<string>();
    try {
      mainOrigins.add(new URL(url).origin);
    } catch {
      // loadURL will report the invalid URL; do not broaden navigation access.
    }
    registerNavigationGuards(this.mainWindow.webContents, mainOrigins);

    if (bounds.isMaximized) {
      this.mainWindow.maximize();
    }

    this.setupWindowEvents();
    this.mainWindow.loadURL(url);

    // 开发模式下不自动打开 DevTools（避免未响应）
    // 使用 F12 或 Ctrl+Shift+I 手动打开，使用 'right' 模式避免 detach 窗口卡死
    if (isDev) {
      this.mainWindow.webContents.on('devtools-opened', () => {
        // 限制 DevTools 不会同时打开多个面板，减轻负担
      });
    }

    return this.mainWindow;
  }

  /**
   * 创建 WhatsApp Web 视图（默认账号）
   */
  createWhatsappView(accountId: string = 'default', label: string = '主账号'): WebContentsView | null {
    if (!this.mainWindow) return null;

    // 如果已存在同 ID 的账号，先移除
    if (this.whatsappAccounts.has(accountId)) {
      this.removeWhatsappAccount(accountId);
    }

    const partition = accountId === 'default' ? 'persist:whatsapp' : `persist:whatsapp-${accountId}`;

    const view = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'wa-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        partition,
        webSecurity: true,
        allowRunningInsecureContent: false,
      },
    });
    registerNavigationGuards(view.webContents, new Set(), partition);

    this.mainWindow.contentView.addChildView(view);

    // 设置 User-Agent
    view.webContents.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
    );

    // 加载 WhatsApp Web
    view.webContents.loadURL('https://web.whatsapp.com');

    const account: WhatsappAccount = {
      id: accountId,
      label,
      view,
      partition,
      isActive: false,
    };

    this.whatsappAccounts.set(accountId, account);

    // 如果是第一个账号或没有活跃账号，设为活跃
    if (!this.activeAccountId || accountId === 'default') {
      this.setActiveAccount(accountId);
    } else {
      // 非活跃账号隐藏
      view.setBounds({ x: -9999, y: -9999, width: 0, height: 0 });
    }

    return view;
  }

  /**
   * 切换活跃 WhatsApp 账号
   */
  setActiveAccount(accountId: string): boolean {
    if (!this.whatsappAccounts.has(accountId)) return false;

    // 隐藏所有账号
    for (const [id, account] of this.whatsappAccounts) {
      account.isActive = (id === accountId);
      if (id !== accountId) {
        account.view.setBounds({ x: -9999, y: -9999, width: 0, height: 0 });
      }
    }

    this.activeAccountId = accountId;
    this.layoutViews();

    // 通知前端
    this.sendToRenderer('wa:account-switched', {
      accountId,
      label: this.whatsappAccounts.get(accountId)?.label || '',
    });

    return true;
  }

  /**
   * 获取活跃账号 ID
   */
  getActiveAccountId(): string | null {
    return this.activeAccountId;
  }

  /**
   * 获取当前活跃的 WhatsApp view
   */
  getActiveWhatsappView(): WebContentsView | null {
    if (!this.activeAccountId) return null;
    const account = this.whatsappAccounts.get(this.activeAccountId);
    return account?.view || null;
  }

  /** Resolve the owning account from the isolated WhatsApp WebContents. */
  getWhatsappAccountIdForSender(sender: unknown): string | null {
    for (const [accountId, account] of this.whatsappAccounts) {
      if (account.view.webContents === sender) return accountId;
    }
    return null;
  }

  /**
   * 获取所有账号列表
   */
  getAccountList(): Array<{ id: string; label: string; isActive: boolean }> {
    const list: Array<{ id: string; label: string; isActive: boolean }> = [];
    for (const [id, account] of this.whatsappAccounts) {
      list.push({ id, label: account.label, isActive: account.isActive });
    }
    return list;
  }

  /**
   * 移除 WhatsApp 账号
   */
  removeWhatsappAccount(accountId: string): void {
    const account = this.whatsappAccounts.get(accountId);
    if (!account || !this.mainWindow) return;

    this.mainWindow.contentView.removeChildView(account.view);
    this.whatsappAccounts.delete(accountId);

    if (this.activeAccountId === accountId) {
      // 切换到第一个可用账号
      const firstId = this.whatsappAccounts.keys().next().value;
      if (firstId) {
        this.setActiveAccount(firstId);
      } else {
        this.activeAccountId = null;
      }
    }
  }

  /**
   * 获取活跃 WhatsApp 视图
   */
  getWhatsappView(): WebContentsView | null {
    if (!this.activeAccountId) return null;
    return this.whatsappAccounts.get(this.activeAccountId)?.view || null;
  }

  /**
   * 获取指定账号的 WhatsApp 视图
   */
  getWhatsappViewById(accountId: string): WebContentsView | null {
    return this.whatsappAccounts.get(accountId)?.view || null;
  }

  /**
   * 布局视图：根据当前布局配置定位 WhatsApp 视图
   *
   * 布局模式：
   * 1. whatsappVisible=true（聊天页）：侧边栏 + 联系人列表 + WhatsApp视图 + AI面板
   * 2. whatsappVisible=false（其他页面）：WhatsApp 视图移到屏幕外
   */
  layoutViews(): void {
    if (!this.mainWindow || !this.activeAccountId) {
      console.log(`[WindowManager] layoutViews 跳过: mainWindow=${!!this.mainWindow}, activeAccountId=${this.activeAccountId}`);
      return;
    }

    const account = this.whatsappAccounts.get(this.activeAccountId);
    if (!account) {
      console.log(`[WindowManager] layoutViews 跳过: 账号 ${this.activeAccountId} 不存在`);
      return;
    }

    const [width, height] = this.mainWindow.getContentSize();

    if (this.layout.whatsappVisible) {
      const x = this.layout.leftNavWidth + this.layout.chatListWidth;
      const y = this.layout.topOffset;
      const reservedRightWidth = Math.max(this.layout.rightPanelWidth, this.rendererOverlayWidth);
      const w = Math.max(200, width - this.layout.leftNavWidth - this.layout.chatListWidth - reservedRightWidth);
      const h = Math.max(200, height - this.layout.topOffset - this.layout.bottomOffset);

      account.view.setBounds({ x, y, width: w, height: h });
      console.log(`[WindowManager] 视图显示: bounds={x:${x}, y:${y}, w:${w}, h:${h}}, 窗口=${width}x${height}`);
    } else {
      account.view.setBounds({ x: -9999, y: -9999, width: 0, height: 0 });
      console.log(`[WindowManager] 视图隐藏（移到屏幕外）`);
    }
  }

  /**
   * 显示 WhatsApp 视图（进入聊天页时调用）
   */
  showWhatsappView(): void {
    this.layout.whatsappVisible = true;
    // 确保有活跃账号
    if (!this.activeAccountId) {
      const firstId = this.whatsappAccounts.keys().next().value;
      if (firstId) {
        this.activeAccountId = firstId;
      }
    }
    this.layoutViews();
    console.log(`[WindowManager] WhatsApp 视图已显示, activeAccount=${this.activeAccountId}`);
  }

  /**
   * 隐藏 WhatsApp 视图（离开聊天页时调用）
   */
  hideWhatsappView(): void {
    this.layout.whatsappVisible = false;
    this.layoutViews();
    console.log('[WindowManager] WhatsApp 视图已隐藏');
  }

  /**
   * 更新布局参数
   */
  updateLayout(config: Partial<LayoutConfig>): void {
    this.layout = { ...this.layout, ...config };
    this.layoutViews();
  }

  setRendererOverlayWidth(width: number): void {
    this.rendererOverlayWidth = Math.max(0, Math.round(width));
    this.layoutViews();
  }

  /**
   * 设置窗口事件监听
   */
  private setupWindowEvents(): void {
    if (!this.mainWindow) return;

    this.mainWindow.once('ready-to-show', () => {
      this.mainWindow?.show();
      this.layoutViews();
    });

    const saveBounds = () => {
      if (!this.mainWindow) return;
      const isMaximized = this.mainWindow.isMaximized();
      if (!isMaximized) {
        const bounds = this.mainWindow.getBounds();
        this.store.set({
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
          isMaximized: false,
        });
      } else {
        this.store.set('isMaximized', true);
      }
    };

    this.mainWindow.on('resize', () => {
      this.layoutViews();
      saveBounds();
    });

    this.mainWindow.on('move', saveBounds);

    this.mainWindow.on('maximize', () => {
      this.store.set('isMaximized', true);
      this.layoutViews();
    });

    this.mainWindow.on('unmaximize', () => {
      this.store.set('isMaximized', false);
      this.layoutViews();
    });

    this.mainWindow.on('close', saveBounds);

    this.mainWindow.on('closed', () => {
      this.mainWindow = null;
      this.whatsappAccounts.clear();
      this.activeAccountId = null;
    });
  }

  getMainWindow(): BrowserWindow | null {
    return this.mainWindow;
  }

  sendToRenderer(channel: string, data: any): void {
    this.mainWindow?.webContents.send(channel, data);
  }

  /**
   * 向活跃的 WhatsApp view 发送消息
   */
  sendToActiveWhatsappView(channel: string, data: any): void {
    const view = this.getActiveWhatsappView();
    if (view) {
      view.webContents.send(channel, data);
    }
  }

  /**
   * 在活跃 WhatsApp 视图中执行 JavaScript
   */
  executeWhatsappScript(script: string): Promise<any> {
    const view = this.getWhatsappView();
    if (!view) return Promise.reject(new Error('WhatsApp 视图未初始化'));
    return view.webContents.executeJavaScript(script);
  }

  /**
   * 销毁所有窗口和视图
   */
  destroyAll(): void {
    if (this.mainWindow) {
      for (const [, account] of this.whatsappAccounts) {
        this.mainWindow.contentView.removeChildView(account.view);
      }
    }
    this.whatsappAccounts.clear();
    this.activeAccountId = null;
    this.rendererOverlayWidth = 0;
    if (this.mainWindow) {
      this.mainWindow.close();
      this.mainWindow = null;
    }
  }
}
