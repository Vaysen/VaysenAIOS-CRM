/**
 * 自动更新模块
 * 使用 electron-updater 检查、下载、安装更新
 */

import { autoUpdater } from 'electron-updater';
import { ipcMain, BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../shared/ipc-channels';
import {
  getValidatedUpdateFeedUrl,
  isAutoUpdateEnabled,
  RuntimeConfigError,
} from '../shared/runtime-config';

export class AutoUpdater {
  private mainWindow: BrowserWindow | null = null;
  private updateAvailable: boolean = false;
  private initialized = false;
  private disabledReason: string | null = null;

  constructor() {
    // IPC 始终可用；即使配置非法，也要向渲染层返回明确的 disabled 错误。
    this.registerIpcHandlers();
  }

  setMainWindow(win: BrowserWindow | null): void {
    this.mainWindow = win;
  }

  initialize(): boolean {
    if (this.initialized) return true;
    if (!isAutoUpdateEnabled()) {
      this.disabledReason = '局域网版本默认采用人工覆盖安装，自动更新已关闭';
      console.log(`[AutoUpdater] ${this.disabledReason}`);
      return false;
    }
    // v1.2b 红线 #5：更新源严格校验。非法值抛 RuntimeConfigError，**不**静默
    // 回退默认（v1.2 之前"不强制校验"会指向私网/HTTP/本机，掩盖旧脏值）。
    // 捕获后由 IPC 引导用户进入配置页，禁止更新器启动。
    let feedUrl: string;
    try {
      feedUrl = getValidatedUpdateFeedUrl();
    } catch (err) {
      const reason = err instanceof RuntimeConfigError ? err.message : String(err);
      this.disabledReason = reason;
      console.error(`[AutoUpdater] ❌ 配置非法，更新器禁用: ${reason}`);
      // 通知所有渲染进程：需重新配置
      if (this.mainWindow && !this.mainWindow.isDestroyed()) {
        this.mainWindow.webContents.send(IPC_CHANNELS.APP_CONFIG_INVALID, {
          field: 'updateFeedUrl',
          reason,
        });
      }
      return false; // 更新器不启动，IPC 仍保持注册
    }
    try {
      autoUpdater.setFeedURL(feedUrl);
    } catch {
      // 某些 provider 组合下 setFeedURL 可能抛错，忽略并沿用打包内置地址
    }

    // 配置
    autoUpdater.autoDownload = false;  // 不自动下载，等用户确认
    autoUpdater.autoInstallOnAppQuit = true;  // 退出时自动安装

    // 检查更新
    autoUpdater.on('checking-for-update', () => {
      this.sendStatus({ status: 'checking' });
    });

    // 有可用更新
    autoUpdater.on('update-available', (info) => {
      this.updateAvailable = true;
      this.sendStatus({ status: 'available', version: info.version, releaseNotes: info.releaseNotes });
    });

    // 没有可用更新
    autoUpdater.on('update-not-available', () => {
      this.sendStatus({ status: 'not-available' });
    });

    // 下载进度
    autoUpdater.on('download-progress', (progress) => {
      this.sendStatus({
        status: 'downloading',
        progress: Math.round(progress.percent),
        transferred: progress.transferred,
        total: progress.total,
      });
    });

    // 下载完成
    autoUpdater.on('update-downloaded', (info) => {
      this.sendStatus({ status: 'downloaded', version: info.version });
    });

    // 错误
    autoUpdater.on('error', (err) => {
      this.sendStatus({ status: 'error', message: err.message });
    });

    this.initialized = true;
    this.disabledReason = null;
    return true;
  }

  private registerIpcHandlers(): void {
    // 检查更新
    ipcMain.handle(IPC_CHANNELS.APP_CHECK_UPDATE, async () => {
      if (!this.initialized) {
        return { success: false, error: this.disabledReason || '自动更新器尚未初始化' };
      }
      try {
        await autoUpdater.checkForUpdates();
        return { success: true };
      } catch (error: any) {
        return { success: false, error: error.message };
      }
    });

    // 下载更新
    ipcMain.handle(IPC_CHANNELS.APP_DOWNLOAD_UPDATE, async () => {
      if (!this.initialized) {
        return { success: false, error: this.disabledReason || '自动更新器尚未初始化' };
      }
      try {
        await autoUpdater.downloadUpdate();
        return { success: true };
      } catch (error: any) {
        return { success: false, error: error.message };
      }
    });

    // 安装更新（会重启应用）
    ipcMain.handle(IPC_CHANNELS.APP_INSTALL_UPDATE, () => {
      if (!this.initialized) {
        throw new Error(this.disabledReason || '自动更新器尚未初始化');
      }
      autoUpdater.quitAndInstall();
    });
  }

  private sendStatus(data: any): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(IPC_CHANNELS.APP_UPDATE_STATUS, data);
    }
  }

  /**
   * 应用启动后自动检查更新（延迟 30 秒）
   */
  checkOnLaunch(): void {
    if (!this.initialized) return;
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch((err) => {
        console.error('[AutoUpdater] 启动检查失败:', err.message);
      });
    }, 30000);
  }
}
