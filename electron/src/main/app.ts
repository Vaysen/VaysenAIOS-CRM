/**
 * Electron 主进程入口
 * 管理应用生命周期、创建窗口、启动本地服务器
 */

import { app, BrowserWindow, globalShortcut, crashReporter } from 'electron';
import path from 'path';
import { WindowManager } from './window-manager';
import { LocalServer } from './local-server';
import { IpcHandlers } from './ipc-handlers';
import { TrayManager } from './tray';
import { AutoUpdater } from './auto-updater';
import { getValidatedApiBaseUrl, RuntimeConfigError } from '../shared/runtime-config';
import { IPC_CHANNELS } from '../shared/ipc-channels';
import { configureStableUserDataPath } from './user-data-path';
import { installSafeConsole } from './safe-console';

// Packaged GUI builds may outlive the stdout pipe inherited from their
// launcher.  A closed pipe must never turn a harmless layout log into an
// uncaught main-process exception.
if (app.isPackaged) installSafeConsole();

// 必须在任何 electron-store/safeStorage 数据访问之前固定历史 userData 路径。
// 产品显示名升级为 Vaysen AI CRM时仍复用旧版数据目录。
configureStableUserDataPath(app);

// 防止多个实例运行（单实例锁：第二个实例聚焦主窗口）
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
}

// 崩溃报告：仅本地落盘到用户数据目录，不向任何第三方上传
// （uploadToServer:false）。用于「崩溃日志」验收项的可追溯性。
try {
  crashReporter.start({
    uploadToServer: false,
    ignoreSystemCrashHandler: false,
    productName: 'Vaysen AI CRM',
    companyName: 'Example Trading Company',
  });
} catch {
  // 重复初始化或环境不支持时静默忽略
}

// 运行时配置：默认连接已批准的 ZeroTier 后端，也允许环境变量/持久化配置覆盖。
// 非法 API 配置抛 RuntimeConfigError，业务请求保持 fail-closed；更新器状态与 API 解耦。
let API_BASE_URL: string | null;
let RUNTIME_CONFIG_ISSUE: { field: 'apiBaseUrl' | 'updateFeedUrl'; reason: string } | null = null;
try {
  API_BASE_URL = getValidatedApiBaseUrl();
} catch (err) {
  const reason = err instanceof RuntimeConfigError ? err.message : String(err);
  console.error(`[App] API 配置非法：${reason}。应用仅启动配置能力，业务请求保持禁用。`);
  API_BASE_URL = null;
  RUNTIME_CONFIG_ISSUE = {
    field: err instanceof RuntimeConfigError ? err.field : 'apiBaseUrl',
    reason,
  };
}

let windowManager: WindowManager;
let localServer: LocalServer;
let ipcHandlers: IpcHandlers;
let trayManager: TrayManager;
let autoUpdater: AutoUpdater;

const isDev = process.env.NODE_ENV === 'development';

app.whenReady().then(async () => {
  // 1. 启动本地静态服务器（生产模式）
  let frontendUrl: string;

  if (isDev) {
    // 开发模式：直接加载 Next.js 开发服务器
    frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
  } else {
    // 生产模式：启动本地 Express 服务器
    localServer = new LocalServer(API_BASE_URL);
    const frontendOutDir = path.join(process.resourcesPath, 'frontend-out');
    const port = await localServer.start(frontendOutDir);
    frontendUrl = `http://127.0.0.1:${port}`;
  }

  // 2. 创建窗口管理器
  windowManager = new WindowManager();

  // 3. 创建主窗口
  const mainWindow = windowManager.createMainWindow(frontendUrl, isDev);

  // 4. 注册 IPC 处理器
  ipcHandlers = new IpcHandlers(windowManager, API_BASE_URL);
  ipcHandlers.registerAll();
  if (RUNTIME_CONFIG_ISSUE) {
    mainWindow.webContents.once('did-finish-load', () => {
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC_CHANNELS.APP_CONFIG_INVALID, RUNTIME_CONFIG_ISSUE);
      }
    });
  }

  // 5. 创建 WhatsApp Web 视图（延迟创建，等主窗口就绪）
  mainWindow.once('ready-to-show', () => {
    windowManager.createWhatsappView();
    windowManager.layoutViews();
  });

  // 6. 创建系统托盘
  trayManager = new TrayManager(windowManager);

  // 7. 开发模式：F12 打开 DevTools（right 模式，避免 detach 卡死）
  if (isDev) {
    globalShortcut.register('F12', () => {
      const win = windowManager.getMainWindow();
      if (win && !win.isDestroyed()) {
        if (win.webContents.isDevToolsOpened()) {
          win.webContents.closeDevTools();
        } else {
          win.webContents.openDevTools({ mode: 'right' });
        }
      }
    });
    // Ctrl+Shift+I 也支持
    globalShortcut.register('CommandOrControl+Shift+I', () => {
      const win = windowManager.getMainWindow();
      if (win && !win.isDestroyed()) {
        if (win.webContents.isDevToolsOpened()) {
          win.webContents.closeDevTools();
        } else {
          win.webContents.openDevTools({ mode: 'right' });
        }
      }
    });
  }

  // 8. 初始化自动更新（非开发模式）
  if (!isDev) {
    autoUpdater = new AutoUpdater();
    autoUpdater.setMainWindow(mainWindow);
    if (autoUpdater.initialize()) autoUpdater.checkOnLaunch();
  }

  console.log('[App] 应用启动完成');
  console.log(`[App] 前端地址: ${frontendUrl}`);
  console.log(`[App] API 地址: ${API_BASE_URL || '(disabled: configuration required)'}`);
  console.log(`[App] 开发模式: ${isDev}`);
});

// 第二个实例启动时聚焦主窗口
app.on('second-instance', () => {
  const mainWindow = windowManager?.getMainWindow();
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// 所有窗口关闭时退出（macOS 除外）
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    // 重新创建窗口
    if (windowManager) {
      const url = isDev
        ? (process.env.FRONTEND_URL || 'http://localhost:3000')
        : localServer?.getUrl() || 'http://127.0.0.1:0';
      windowManager.createMainWindow(url, isDev);
    }
  }
});

// 应用退出前清理
app.on('before-quit', async () => {
  globalShortcut.unregisterAll();
  if (localServer) {
    await localServer.stop();
  }
  if (windowManager) {
    windowManager.destroyAll();
  }
});
