/**
 * 系统托盘管理
 */

import { Tray, Menu, nativeImage, app } from 'electron';
import path from 'path';
import { WindowManager } from './window-manager';

export class TrayManager {
  private tray: Tray | null = null;
  private windowManager: WindowManager;

  constructor(windowManager: WindowManager) {
    this.windowManager = windowManager;
    this.createTray();
  }

  private createTray(): void {
    // 生产包从 extraResources 读取公司品牌 ICO；开发模式回退源码资源。
    let icon: Electron.NativeImage;
    try {
      const packagedIcon = path.join(process.resourcesPath, 'brand', 'icon.ico');
      const developmentIcon = path.join(__dirname, '..', '..', 'build', 'icon.ico');
      icon = nativeImage.createFromPath(app.isPackaged ? packagedIcon : developmentIcon);
      if (icon.isEmpty()) {
        throw new Error('brand tray icon is empty');
      }
      icon = icon.resize({ width: 16, height: 16 });
    } catch (error) {
      console.error('[Tray] 无法加载品牌托盘图标', error);
      icon = nativeImage.createEmpty();
    }

    this.tray = new Tray(icon);
    this.tray.setToolTip('Vaysen AI CRM');

    const contextMenu = Menu.buildFromTemplate([
      {
        label: '显示主窗口',
        click: () => {
          const win = this.windowManager.getMainWindow();
          if (win) {
            if (win.isMinimized()) win.restore();
            win.show();
            win.focus();
          }
        },
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          app.quit();
        },
      },
    ]);

    this.tray.setContextMenu(contextMenu);

    // 点击托盘图标显示窗口
    this.tray.on('click', () => {
      const win = this.windowManager.getMainWindow();
      if (win) {
        if (win.isVisible()) {
          win.hide();
        } else {
          win.show();
          win.focus();
        }
      }
    });
  }

  destroy(): void {
    if (this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
  }
}
